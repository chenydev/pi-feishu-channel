/**
 * 会话的**只读视图**：`/feishu status`、`/queue list`、`/progress`、`status.json` 问的都是这些。
 *
 * 全是读操作 —— 不改会话、不排队、不发消息。把它们从管理器里挪出来的理由很实际：
 * 这些函数回答的是「现在什么样」，和「下一轮怎么跑」没有任何共享状态，放在一起读代码要来回跳。
 *
 * 参数一律显式传入（会话表、活动任务表、调度器、预算），不持有管理器。
 */
import type { UsageSnapshot } from "../commands/usage-card.js";
import type { BridgeConfig, FeishuInboundMessage } from "../types.js";
import { buildConversationKey } from "./conversation-key.js";
import { sessionUsageStats } from "./model-utils.js";
import { describeProgress, durationLabel, type RunActivity } from "./run-activity.js";
import { previewText } from "./text-utils.js";

/** 视图需要的会话形状（只读）。 */
export interface ViewSession {
	conversationKey: string;
	chatId: string;
	queue: Array<{ text: string }>;
	steered: unknown[];
	activeRun: boolean;
	lastRun?: UsageSnapshot["run"];
	agent?: { modelId?: string } & Parameters<typeof sessionUsageStats>[0];
	/** 本轮的活动（工具、turn 边界）。 */
	run?: RunActivity;
}

export interface ViewState<S extends ViewSession> {
	sessions: { values(): Iterable<S>; get(key: string): S | undefined; size: number };
	/** 当前正在跑的原始消息（按会话键）。 */
	activeItems: Map<string, { text: string; senderName?: string }>;
	scheduler: { active: number; waiting: unknown[] };
	now(): number;
}

export function queueStatsOf<S extends ViewSession>(state: ViewState<S>): { queued: number; active: number; waiting: number } {
	return {
		queued: [...state.sessions.values()].reduce((total, session) => total + session.queue.length, 0),
		active: state.scheduler.active,
		waiting: state.scheduler.waiting.length,
	};
}

export function schedulerSnapshotOf<S extends ViewSession>(state: ViewState<S>): { waiting: number; queues: Array<{ conversationKey: string; queued: number; active: boolean }> } {
	return {
		waiting: state.scheduler.waiting.length,
		queues: [...state.sessions.values()].map((session) => ({
			conversationKey: session.conversationKey,
			queued: session.queue.length,
			active: Boolean(session.activeRun),
		})),
	};
}

export function queueSnapshotOf<S extends ViewSession>(state: ViewState<S>, config: BridgeConfig, msg: FeishuInboundMessage): { active?: string; queued: string[]; steered: number } {
	const key = buildConversationKey(msg, config);
	const sess = state.sessions.get(key);
	const active = state.activeItems.get(key);
	return {
		...(active ? { active: previewText(active.text) } : {}),
		queued: (sess?.queue ?? []).map((item) => previewText(item.text)),
		steered: sess?.steered.length ?? 0,
	};
}

/**
 * `/progress`：不经过模型，直接报告这一轮做到哪了。自己的会话空闲时，列出同一个群里别人正在执行的任务
 * （只给人和时长，不给命令内容：群里各人会话独立时那是别人的任务）。
 */
export function progressReportOf<S extends ViewSession>(state: ViewState<S>, config: BridgeConfig, msg: FeishuInboundMessage): string {
	const key = buildConversationKey(msg, config);
	const own = state.sessions.get(key);
	const now = state.now();
	if (own?.run && state.activeItems.has(key)) {
		return describeProgress({ activity: own.run, now, task: state.activeItems.get(key)?.text, steered: own.steered.length, queued: own.queue.length });
	}
	const lines = [own?.queue.length ? `当前没有执行中的任务，排队 ${own.queue.length} 个` : "当前没有执行中的任务"];
	const others = [...state.sessions.values()].filter((session) => session !== own && session.chatId === msg.chatId && session.run && state.activeItems.has(session.conversationKey));
	if (others.length > 0) {
		lines.push(`这个群里另有 ${others.length} 个任务在执行：`);
		// 只给人和时长，不给命令内容：群里各人会话独立时那是别人的任务
		for (const other of others.slice(0, 5)) {
			const activity = other.run as RunActivity;
			const who = state.activeItems.get(other.conversationKey)?.senderName ?? "其他成员";
			lines.push(`· ${who}：已运行 ${durationLabel(now - activity.startedAt)}，${activity.inTool ? "正在执行工具" : "在等模型回复"}`);
		}
	}
	return lines.join("\n");
}

/** 当前会话的用量快照（`/feishu usage` 与状态页用）。 */
export function usageSnapshotOf<S extends ViewSession>(state: ViewState<S>, config: BridgeConfig, msg: FeishuInboundMessage): UsageSnapshot | undefined {
	const session = state.sessions.get(buildConversationKey(msg, config));
	if (!session) return undefined;
	const stats = sessionUsageStats(session.agent);
	const modelLabel = session.agent?.modelId;
	return {
		...(modelLabel ? { modelLabel } : {}),
		...(stats ? { session: stats } : {}),
		...(session.lastRun ? { run: session.lastRun } : {}),
	};
}
