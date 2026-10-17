/**
 * 一轮任务的实时状态：在跑什么工具、跑了多久、最近的输出。两个用处：
 * - 空闲超时分两段计时：工具执行中按 `runToolIdleTimeoutMs`（默认 60 分钟），等模型时按 `runIdleTimeoutMs`（默认 10 分钟）。
 *   构建、跑测试这类长时间没有输出的命令很常见，不能和「模型卡住」用同一个时限；
 * - `/progress` 和忙碌提示：不经过模型，直接告诉用户这一轮做到哪了。
 */

export interface RunningTool {
	id: string;
	name: string;
	startedAt: number;
	/** 给人看的一句话（bash 是命令首行，文件工具是路径）。 */
	detail?: string;
}

const OUTPUT_LINES = 3;
const OUTPUT_LINE_MAX = 200;
const DETAIL_MAX = 80;

export class RunActivity {
	/** 最近一次收到 agent 事件的时间。 */
	lastEventAt: number;
	/** 本轮已开始的工具调用次数。 */
	toolCalls = 0;
	/**
	 * 本轮已结束的 turn 数（pi 的 `turn_end` 事件）。
	 *
	 * 用来判断「注入的 steer 到底有没有被执行」：steer 在 turn 边界被消费，
	 * 如果注入之后一个 turn 都没结束，说明这轮在消费它之前就收尾了。
	 */
	turnEnds = 0;
	/** 正在执行的工具最近几行输出（工具结束后清空）。 */
	lastOutput?: string;
	/** pi 正在自动重试（503、限流等临时错误）；收到模型输出或重试结束后清空。 */
	retry?: { attempt: number; maxAttempts: number; error: string };
	private readonly tools = new Map<string, RunningTool>();

	constructor(readonly startedAt: number) {
		this.lastEventAt = startedAt;
	}

	/** 记一个 agent 事件（工具事件和自动重试事件，其余只更新时间）。 */
	record(event: unknown, now: number): void {
		this.lastEventAt = now;
		if (!event || typeof event !== "object") return;
		const value = event as Record<string, unknown>;
		const id = typeof value.toolCallId === "string" ? value.toolCallId : "";
		if (value.type === "turn_end") {
			this.turnEnds += 1;
		} else if (value.type === "auto_retry_start") {
			const num = (key: string): number => (typeof value[key] === "number" ? value[key] as number : 0);
			this.retry = { attempt: num("attempt"), maxAttempts: num("maxAttempts"), error: typeof value.errorMessage === "string" ? value.errorMessage : "" };
		} else if (value.type === "auto_retry_end" || value.type === "message_update") {
			this.retry = undefined;
		} else if (value.type === "tool_execution_start") {
			const name = typeof value.toolName === "string" ? value.toolName : "tool";
			this.tools.set(id, { id, name, startedAt: now, detail: detailOf(value.args) });
			this.toolCalls += 1;
			this.lastOutput = undefined;
		} else if (value.type === "tool_execution_update") {
			const tail = outputTail(value.partialResult);
			if (tail) this.lastOutput = tail;
		} else if (value.type === "tool_execution_end") {
			this.tools.delete(id);
			if (this.tools.size === 0) this.lastOutput = undefined;
		}
	}

	/** 是否有工具在执行（决定空闲超时用哪个时限）。 */
	get inTool(): boolean {
		return this.tools.size > 0;
	}

	/** 执行最久的那个工具（并行执行时只报一个）。 */
	current(): RunningTool | undefined {
		let oldest: RunningTool | undefined;
		for (const tool of this.tools.values()) if (!oldest || tool.startedAt < oldest.startedAt) oldest = tool;
		return oldest;
	}
}

/** 「12 分 30 秒」「45 秒」「1 小时 5 分」。 */
export function durationLabel(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1_000));
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

/** 「bash `npm test`」或只有工具名。 */
export function toolLabel(tool: RunningTool): string {
	return tool.detail ? `${tool.name} \`${tool.detail}\`` : tool.name;
}

/**
 * 等模型时连续多久没有任何事件就提示「可能在排队」。
 *
 * DeepSeek 繁忙时不报错，而是先回响应头、再只发 SSE 注释 `: keep-alive` 排队，最长 10 分钟才断开；
 * pi 收不到任何事件，用户只看到「正在处理…」。
 */
export const MODEL_QUIET_NOTICE_MS = 60_000;

export interface ModelWaitNotice {
	kind: "retry" | "quiet";
	text: string;
}

/**
 * 等模型阶段的状态提示：pi 在自动重试，或者长时间没有任何输出（多半在排队）。
 * 工具执行中、一切正常时返回 undefined。时长按分钟取整，文案一分钟最多变一次（进度消息的编辑次数有限）。
 */
export function modelWaitNotice(activity: RunActivity, now: number, idleLimitMs: number): ModelWaitNotice | undefined {
	if (activity.inTool) return undefined;
	const quiet = now - activity.lastEventAt;
	if (quiet >= MODEL_QUIET_NOTICE_MS) {
		const minutes = Math.max(1, Math.floor(quiet / 60_000));
		const limit = idleLimitMs > 0 ? `，${durationLabel(idleLimitMs)}仍没有输出会自动中止` : "";
		return { kind: "quiet", text: `⏳ 已 ${minutes} 分钟没有收到模型输出，模型服务可能在排队${limit}。不想等可以 /stop，用 /model 换个模型再发。` };
	}
	const retry = activity.retry;
	if (retry) return { kind: "retry", text: `⚠️ 模型服务暂时不可用（${briefError(retry.error)}），正在自动重试（第 ${retry.attempt}/${retry.maxAttempts} 次）…` };
	return undefined;
}

/** 错误摘要：有 HTTP 状态码就只给状态码，否则取首行前 40 字。 */
function briefError(message: string): string {
	const status = /^\s*(\d{3})\b/.exec(message)?.[1];
	if (status) return status;
	const line = message.trim().split("\n")[0] ?? "";
	if (!line) return "临时错误";
	return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** 工具在执行时，用户的消息要等这一步结束才交给模型：返回一句说明（没有工具在执行时返回 undefined）。 */
export function busyNoticeText(activity: RunActivity, now: number): string | undefined {
	const tool = activity.current();
	if (!tool) return undefined;
	return `正在执行 ${toolLabel(tool)}（已 ${durationLabel(now - tool.startedAt)}），你的消息会在这一步结束后交给模型。发 /progress 看进度，/stop 停止。`;
}

/** `/progress` 的正文：这一轮跑了多久、现在在做什么、最近的输出、排队情况。 */
export function describeProgress(input: { activity: RunActivity; now: number; task?: string; steered: number; queued: number }): string {
	const { activity, now } = input;
	const lines = [`正在执行（已运行 ${durationLabel(now - activity.startedAt)}）`];
	if (input.task) lines.push(`任务：${input.task.replace(/\s+/g, " ").slice(0, 60)}`);
	const tool = activity.current();
	const quiet = now - activity.lastEventAt;
	if (tool) {
		lines.push(`当前：${toolLabel(tool)}，已执行 ${durationLabel(now - tool.startedAt)}${quiet >= 60_000 ? `，${durationLabel(quiet)}没有新输出` : ""}`);
		if (activity.lastOutput) lines.push("最近输出：", "```", activity.lastOutput, "```");
	} else {
		lines.push(`当前：等模型回复${quiet >= 30_000 ? `（${durationLabel(quiet)}没有新输出）` : ""}`);
		if (activity.retry) lines.push(`模型服务暂时不可用（${briefError(activity.retry.error)}），pi 正在自动重试（第 ${activity.retry.attempt}/${activity.retry.maxAttempts} 次）`);
	}
	const extra = [`本轮已调用工具 ${activity.toolCalls} 次`];
	if (input.steered) extra.push(`待并入 ${input.steered} 条消息`);
	if (input.queued) extra.push(`排队 ${input.queued} 个任务`);
	lines.push(extra.join("；"));
	return lines.join("\n");
}

function detailOf(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = args as Record<string, unknown>;
	const raw = [value.command, value.path, value.file_path, value.pattern].find((item) => typeof item === "string" && item.trim()) as string | undefined;
	if (!raw) return undefined;
	const first = raw.trim().split("\n")[0];
	return first.length > DETAIL_MAX ? `${first.slice(0, DETAIL_MAX)}…` : first;
}

/** 工具中间结果的最后几行（bash 的输出是累计的）。 */
function outputTail(partial: unknown): string | undefined {
	const content = (partial as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
	const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
	if (lines.length === 0) return undefined;
	return lines.slice(-OUTPUT_LINES).map((line) => (line.length > OUTPUT_LINE_MAX ? `${line.slice(0, OUTPUT_LINE_MAX)}…` : line)).join("\n").replaceAll("```", "'''");
}
