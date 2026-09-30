/**
 * 进度气泡：工具日志的追加、节流渲染、编辑配额轮换与收尾。
 *
 * 从 ConversationManager 拆出来 —— 它只依赖"往哪个会话写"（chatId/conversationKey）
 * 与发送/编辑/撤回能力，不关心队列、审批、会话生命周期。
 */
import type { BridgeConfig } from "../types.js";
import type { Sender } from "../outbound/sender.js";
import type { LiveChannel, SerialWriter } from "../outbound/live-channel.js";
import {
	DEFAULT_PREVIEW_CHARS,
	formatStepSummary,
	renderProgressText,
	renderToolLine,
	type ProgressLine,
	type ProgressMode,
} from "../outbound/progress-render.js";

/**
 * 飞书对同一条消息的编辑次数上限（官方文档为 20 次；超出返回 `code 230072`
 * "The message has reached the number of times it can be edited"）。
 *
 * 这是**真实链路验证发现的硬约束**：进度会随每个工具行 + 周期心跳持续改写同一条消息，
 * 长任务必然撞上限，表现为「耗时页脚冻结在某一秒 + 终态页脚（✅/⏹/⚠️）永远发不出去」。
 */
const FEISHU_MAX_MESSAGE_EDITS = 20;
/** 非终态写入的编辑配额：预留 2 次给终态页脚，避免「跑很久 → 结果页脚写不进去」。 */
const PROGRESS_EDIT_BUDGET = FEISHU_MAX_MESSAGE_EDITS - 2;
/**
 * 进度心跳间隔：只在长时间无工具变化时刷新耗时页脚。
 *
 * 不用更短的间隔是因为编辑配额有限（见上），而且编辑是要花网络往返的；
 * 30s 对「还在跑」的体感已经足够，配额用尽后会自动轮换新消息（见 `writeProgressText`）。
 */
export const PROGRESS_HEARTBEAT_MS = 30_000;

/** 进度消息的会话内状态（随 run 创建，收尾后删除）。 */
export interface ProgressState {
	/** 进度消息 id；被 final 复用（非卡片模式下已吐出正文）时清空，避免撤回正在用的消息。 */
	messageId?: string;
	/** 当前进度消息已被编辑的次数（飞书同一条消息上限 20 次，见 `FEISHU_MAX_MESSAGE_EDITS`）。 */
	edits: number;
	/** 轮换新进度消息时的回复目标（沿用触发消息，保持阅读顺序）。 */
	replyTo?: string;
	threadId?: string;
	/** 非卡片模式：该进度消息同时是流式草稿的载体，轮换时要一并改指。 */
	liveTarget?: boolean;
	/** 上次写入时间（节流用）。 */
	lastUpdateAt: number;
	/** 追加式日志行（见 `progress-render.ts` 的设计说明）。 */
	lines: ProgressLine[];
	/**
	 * 当前气泡第一行的下标。
	 *
	 * 飞书同一条消息最多编辑 20 次，长任务必然撞上限，因此需要换气泡（新发一条继续）。
	 * 换气泡时把它移到「旧气泡从未展示过的第一行」：新气泡只写之后的内容，不重复旧气泡，
	 * 一轮任务在群里读成一段连续日志（对齐 hermes `_roll_progress_overflow_if_needed` 的切分语义）。
	 */
	pageStart: number;
	/** 当前气泡上一次写出去时 `lines` 的长度（= 旧气泡已经展示到哪一行）。 */
	shownUpTo: number;
	/** 第几个进度气泡（0 = 首个）。换过气泡后标题标「（续）」，避免看成新的一轮。 */
	pageIndex: number;
	/** `new` 档去重：上一个已追加的工具名（hermes `last_tool`）。 */
	lastToolName?: string;
	/** 已见过的 toolCallId（SDK 重放/重试去重）。 */
	seenCallIds: Set<string>;
	startedAt?: number;
	/** 已收尾：之后不再接受进度写入（关掉与 8s 定时器竞争的最后一道闸）。 */
	finishedAt?: number;
	/** 思考摘要（仅配置开启时累积；只保留末尾 500 字）。 */
	thinking?: string;
	/**
	 * 卡片模式下进度气泡**懒创建** —— 第一个工具行出现时才发。
	 * 纯聊天（没调工具）的轮次因此不再"先发一条正在处理再撤回"（多 2 次 API、群里闪一下）。
	 */
	lazy?: boolean;
	/** 懒创建进行中（并发的工具行不重复发气泡）。 */
	creating?: boolean;
	/** 按工具名计数（不受 `new` 档折叠影响）与失败次数，终态页脚用。 */
	toolCounts: Record<string, number>;
	toolErrors: number;
}

/** 进度写到哪个会话（BridgeSession 的子集）。 */
export interface ProgressTarget {
	chatId: string;
	conversationKey: string;
}

export interface ProgressTrackerDeps {
	config: BridgeConfig;
	sender: Pick<Sender, "send">;
	editMessage?: (messageId: string, text: string) => Promise<boolean>;
	recallMessage?: (messageId: string) => Promise<boolean>;
	/** 非卡片模式下进度消息同时是流式草稿的载体（轮换时改指、吐正文后让位）。 */
	liveChannel?: LiveChannel;
	/** 进度写入的串行器（同一目标不并发、顺序确定）。 */
	writer?: SerialWriter;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	/** 统一时间源（测试可注入虚拟时钟）。 */
	now?: () => number;
}

export class ProgressTracker {
	/**
	 * 按会话的进度状态。`lines` 是**追加式日志**（hermes 进度气泡同构）：工具*开始*时追加一行，之后永不改写
	 * —— 因此能看到「这轮做了什么」的完整顺序，而不是只剩「此刻还剩哪几个在跑」。
	 * 行不可变也是连续重复行能安全折叠成 `(×N)` 的前提。
	 */
	private readonly states = new Map<string, ProgressState>();
	private readonly minIntervalMs = 1500;

	constructor(private readonly deps: ProgressTrackerDeps) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	get(key: string): ProgressState | undefined {
		return this.states.get(key);
	}

	clear(): void {
		this.states.clear();
	}

	/** 关闭时：先 drain 再撤回（避免迟到写入落到已撤回消息上）。 */
	async drain(messageId: string): Promise<void> {
		await this.deps.writer?.drain(messageId);
	}

	/** 进度状态（懒建）：不变量集中在这里，避免各处 `?? {}` 漏字段。 */
	state(key: string): ProgressState {
		let state = this.states.get(key);
		if (!state) {
			state = { lastUpdateAt: 0, edits: 0, lines: [], seenCallIds: new Set(), pageStart: 0, shownUpTo: 0, pageIndex: 0, toolCounts: {}, toolErrors: 0 };
			this.states.set(key, state);
		}
		return state;
	}

	/** 进度档位（`off` 时既不发进度消息也不追加行）。 */
	get mode(): ProgressMode {
		return this.deps.config.progress?.mode ?? "all";
	}

	private get maxLines(): number {
		return Math.max(1, this.deps.config.progress?.maxLines ?? 6);
	}

	private get previewChars(): number {
		return Math.max(4, this.deps.config.progress?.previewChars ?? DEFAULT_PREVIEW_CHARS);
	}

	/** 完成后是否保留进度消息（默认 true，对齐 hermes `cleanup_progress: false`）。 */
	private get keepOnFinish(): boolean {
		return this.deps.config.progress?.keepOnFinish !== false;
	}

	private thinking(st: ProgressState): string | undefined {
		return this.deps.config.progress?.showThinking ? st.thinking : undefined;
	}

	/** 追加一行工具日志（追加式：只在工具*开始*时调用）。 */
	append(sess: ProgressTarget, toolName: string, args?: Record<string, unknown>, toolCallId?: string): void {
		// `off` 档连日志都不维护（避免做无用的事后又发现没人看）
		if (this.mode === "off") return;
		const st = this.state(sess.conversationKey);
		// 同一 toolCallId 的重复 start 只记一次（SDK 重试/重放）；缺 id 时无法区分，只能照记
		if (toolCallId) {
			if (st.seenCallIds.has(toolCallId)) return;
			if (st.seenCallIds.size < 512) st.seenCallIds.add(toolCallId);
		}
		// `new` 档：只在工具**变化**时追加（hermes `progress_mode == "new"` 的语义）
		st.toolCounts[toolName] = (st.toolCounts[toolName] ?? 0) + 1;
		if (this.mode === "new" && toolName === st.lastToolName) return;
		st.lastToolName = toolName;

		const text = renderToolLine(toolName, args, { previewChars: this.previewChars, mode: this.mode });
		const last = st.lines[st.lines.length - 1];
		// 连续相同行折叠：`echo 1` 跑五遍只占一行（hermes `__dedup__` 哨兵的等价物）
		if (last && last.text === text) last.count += 1;
		else st.lines.push({ text, count: 1 });
		this.deps.log?.("info", "feishu.progress.append", {
			chatId: sess.chatId, conversationKey: sess.conversationKey,
			toolName, line: text, steps: st.lines.length,
			hasMessage: Boolean(st.messageId), hasCallId: Boolean(toolCallId),
		});
		void this.render(sess, st);
	}

	async render(sess: ProgressTarget, st: ProgressState): Promise<void> {
		if (!this.deps.editMessage) return;
		if (this.mode === "off") return;
		// 非卡片模式下进度消息同时是流式草稿的载体：一旦开始吐正文，进度就得让位，
		// 否则编辑会把已经流出的答案覆盖回进度块。
		if (this.deps.liveChannel?.hasContent(sess.conversationKey)) return;
		if (st.finishedAt !== undefined) return; // 已收尾（关掉与心跳定时器的写入竞争）
		if (!st.messageId && st.lazy && st.lines.length > 0) {
			await this.createLazyProgress(sess, st);
			return;
		}
		if (!st.messageId) return; // 进度消息还没发（或已撤回）
		const now = this.now();
		if (now - st.lastUpdateAt < this.minIntervalMs) return; // 节流
		st.lastUpdateAt = now;
		await this.writeProgressText(sess, st, false);
	}

	/** 首个工具行出现时才发进度气泡（卡片模式）。 */
	private async createLazyProgress(sess: ProgressTarget, st: ProgressState): Promise<void> {
		if (st.creating || !st.replyTo) return;
		st.creating = true;
		try {
			st.shownUpTo = st.lines.length;
			const sent = await this.deps.sender.send(sess.chatId, this.currentProgressText(st), { replyTo: st.replyTo, threadId: st.threadId });
			if (!sent.success || !sent.messageId) {
				this.deps.log?.("warn", "feishu.progress.lazy_create_failed", { chatId: sess.chatId, error: sent.error });
				return;
			}
			st.messageId = sent.messageId;
			st.edits = 0;
			st.lastUpdateAt = this.now();
			// 发送期间又来了新行，或者已经收尾：补写一次（收尾时由 finishProgress 写终态）
			if (st.finishedAt === undefined && st.lines.length > st.shownUpTo) await this.writeProgressText(sess, st, false);
		} finally {
			st.creating = false;
		}
	}

	/**
	 * 渲染**当前气泡**的正文。
	 *
	 * 只取 `st.lines.slice(st.pageStart)` —— 即本气泡自己的窗口；换过气泡之后标题变
	 * 「执行过程（续）」，因此新气泡不会把旧气泡的尾部再贴一遍。
	 */
	private currentProgressText(
		st: ProgressState,
		opts: { outcome?: "ok" | "failed" | "stopped" } = {},
	): string {
		return renderProgressText(st.lines.slice(st.pageStart), this.thinking(st), {
			mode: this.mode, maxLines: this.maxLines, previewChars: this.previewChars,
		}, {
			startedAt: st.startedAt,
			finishedAt: st.finishedAt,
			outcome: opts.outcome,
			now: st.finishedAt ?? this.now(),
			continued: st.pageIndex > 0,
			...(opts.outcome ? { stepSummary: formatStepSummary(st.toolCounts, st.toolErrors) } : {}),
		});
	}

	/**
	 * 写进度正文：优先编辑当前进度消息；**编辑配额用尽则另发一条继续**。
	 *
	 * 为什么必须轮换：飞书对同一条消息的编辑次数有硬上限（20 次，超出返回 `code 230072`）。
	 * 进度会随每个工具行与周期心跳持续改写同一条消息，长任务必然撞上限 —— 2026-09-21 用真实
	 * 长时间静默任务复现：第 20 次编辑后全部被拒，群里表现为耗时页脚冻结在 `⏱ 2m33s`，
	 * 紧随其后的终态页脚（`✅/⏹/⚠️`）**永远发不出去**（用户以为任务卡死）。
	 *
	 * 因此：非终态写入只用 `PROGRESS_EDIT_BUDGET`（留 2 次给终态）；用尽即**换气泡续写**
	 * （思路同 hermes 的 `_roll_progress_overflow_if_needed`，但触发条件是**次数**而非长度）：
	 * 新气泡从「旧气泡从未展示过的第一行」开始（`pageStart = shownUpTo`），因此
	 * 旧气泡保留自己的窗口、新气泡接着往后写 —— 不重复、历史不断。
	 * 终态写入额外拿到剩余配额，配额也已耗尽时直接新发一条 —— 结果页脚绝不丢。
	 */
	private async writeProgressText(
		sess: ProgressTarget,
		st: ProgressState,
		terminal = false,
		opts: { outcome?: "ok" | "failed" | "stopped" } = {},
	): Promise<void> {
		if (!st.messageId) return;
		const budget = terminal ? FEISHU_MAX_MESSAGE_EDITS : PROGRESS_EDIT_BUDGET;
		if (st.edits < budget) {
			st.edits += 1;
			st.shownUpTo = st.lines.length;
			// 进度写入与流式写入共用串行语义（同一目标永不并发，顺序确定）。
			this.deps.writer?.enqueue(st.messageId, this.currentProgressText(st, opts));
			return;
		}
		st.pageStart = Math.max(st.pageStart, st.shownUpTo);
		st.pageIndex += 1;
		await this.rollProgressMessage(sess, st, this.currentProgressText(st, opts));
	}

	/** 编辑配额用尽：换气泡续写（旧气泡保留它自己的窗口，新气泡只写之后的行）。 */
	private async rollProgressMessage(sess: ProgressTarget, st: ProgressState, text: string): Promise<void> {
		if (!st.replyTo) {
			this.deps.log?.("warn", "feishu.progress.roll_skipped", { chatId: sess.chatId, reason: "no_reply_target" });
			return;
		}
		try {
			const sent = await this.deps.sender.send(sess.chatId, text, { replyTo: st.replyTo, threadId: st.threadId });
			if (!sent.success || !sent.messageId) {
				this.deps.log?.("warn", "feishu.progress.roll_failed", { chatId: sess.chatId, error: sent.error });
				return;
			}
			st.messageId = sent.messageId;
			st.edits = 0;
			st.shownUpTo = st.lines.length;
			// 非卡片模式下这条消息同时是流式草稿的载体：把草稿也改指到新消息上。
			// 只有「还没吐正文」时才会走到轮换（有正文时 renderProgress 已提前 return），
			// 且终态阶段（finishedAt 已置）不再重绑定。
			if (st.liveTarget && st.finishedAt === undefined) this.deps.liveChannel?.open(sess.conversationKey, sent.messageId);
			this.deps.log?.("info", "feishu.progress.rolled", {
				chatId: sess.chatId, messageId: sent.messageId, editsBefore: PROGRESS_EDIT_BUDGET,
			});
		} catch (error) {
			this.deps.log?.("warn", "feishu.progress.roll_error", {
				chatId: sess.chatId, error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * 收尾进度消息。
	 *
	 * `keepOnFinish`（默认 true，对齐 hermes `cleanup_progress: false`）时**保留**并写一次终态
	 * 页脚（✅/⏹/⚠️ + 总耗时）—— 「这轮做了什么」可回看；为 false 时维持旧行为（撤回）。
	 * 失败/中断同样保留（hermes：“Failed runs leave bubbles in place as breadcrumbs”）。
	 *
	 * 注意：被 final 复用的进度消息（非卡片模式下已吐出正文）不能撤回 —— 它就是答案本体。
	 */
	async finish(sess: ProgressTarget, st: ProgressState, outcome: "ok" | "failed" | "stopped"): Promise<void> {
		try {
			this.deps.liveChannel?.discard(sess.conversationKey);
			// 先标收尾：关掉心跳定时器与迟到回调对同一条消息的写入竞争（renderProgress 会早退）。
			st.finishedAt ??= this.now();
			const messageId = st.messageId;
			if (!messageId) return;
			// 保留的前提是**真有步骤可看**：纯聊天（没调任何工具）的 run 不该每轮多留一条
			// 「执行过程 ✅ 完成 · 0.1s」—— 那只是噪声。
			if (this.keepOnFinish && st.lines.length > 0) {
				// terminal=true：终态页脚拿到剩余编辑配额，配额也耗尽时 `writeProgressText`
				// 会新发一条把结果写进去 —— 长任务的「✅/⏹/⚠️ 结论」绝不允许被编辑上限吞掉。
				await this.writeProgressText(sess, st, true, { outcome });
				if (st.messageId) await this.deps.writer?.drain(st.messageId);
				return;
			}
			st.messageId = undefined;
			if (this.deps.recallMessage) {
				// 撤回前先 drain，避免迟到写入落在撤回之后（撤回后内容不可控）。
				await this.deps.writer?.drain(messageId);
				await this.deps.recallMessage(messageId);
			}
		} finally {
			this.states.delete(sess.conversationKey);
		}
	}
}
