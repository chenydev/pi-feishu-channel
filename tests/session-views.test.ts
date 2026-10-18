/**
 * 只读视图：`/queue list`、`/progress`、用量快照。全是读操作，可以脱离管理器单独测。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { progressReportOf, queueSnapshotOf, queueStatsOf, schedulerSnapshotOf, usageSnapshotOf } from "../src/session/session-views.js";
import { DEFAULT_CONFIG, type FeishuInboundMessage } from "../src/types.js";

const msg = (over: Partial<FeishuInboundMessage> = {}) => ({
	messageId: "om_1", chatId: "oc_1", chatType: "group", senderId: "ou_1",
	text: "hi", msgType: "text", resources: [], ...over,
} as unknown as FeishuInboundMessage);

const session = (over: Record<string, unknown> = {}) => ({
	conversationKey: "oc_1", chatId: "oc_1", queue: [], steered: [], activeRun: false, ...over,
});

function state(over: Record<string, unknown> = {}) {
	const sessions = new Map<string, ReturnType<typeof session>>();
	const activeItems = new Map<string, { text: string; senderName?: string }>();
	return {
		sessions: { values: () => [...sessions.values()], get: (key: string) => sessions.get(key), size: sessions.size, map: sessions },
		activeItems,
		scheduler: { active: 0, waiting: [] as unknown[] },
		now: () => 1_000_000,
		...over,
	};
}

test("队列统计：排队总数 / 执行中 / 等待调度", () => {
	const st = state();
	st.sessions.map.set("a", session({ queue: [{ text: "1" }, { text: "2" }] }));
	st.sessions.map.set("b", session({ queue: [{ text: "3" }] }));
	st.scheduler.active = 2;
	st.scheduler.waiting = [{}, {}];
	assert.deepEqual(queueStatsOf(st), { queued: 3, active: 2, waiting: 2 });
});

test("/queue list：给出执行中的预览、排队列表、已并入条数", () => {
	const st = state();
	st.sessions.map.set("oc_1", session({ queue: [{ text: "第二条消息" }], steered: [{}] }));
	st.activeItems.set("oc_1", { text: "正在跑的这条" });
	const snapshot = queueSnapshotOf(st, DEFAULT_CONFIG, msg());
	assert.equal(snapshot.active, "正在跑的这条");
	assert.deepEqual(snapshot.queued, ["第二条消息"]);
	assert.equal(snapshot.steered, 1);
});

test("调度快照：按会话列出排队数与是否有执行中", () => {
	const st = state();
	st.sessions.map.set("k1", session({ queue: [{ text: "x" }], activeRun: true }));
	assert.deepEqual(schedulerSnapshotOf(st).queues, [{ conversationKey: "oc_1", queued: 1, active: true }]);
});

test("/progress：空闲时说没有任务；有排队时报数量", () => {
	const st = state();
	st.sessions.map.set("oc_1", session({ queue: [{ text: "x" }, { text: "y" }] }));
	assert.match(progressReportOf(st, DEFAULT_CONFIG, msg()), /当前没有执行中的任务，排队 2 个/);
});

test("/progress：别的会话在同一群里执行时只报人和时长（不给命令内容）", () => {
	const st = state();
	st.sessions.map.set("oc_1", session());
	st.sessions.map.set("oc_1:someone", session({ conversationKey: "oc_1:someone", activeRun: true, run: { startedAt: 1_000_000 - 65_000, inTool: true } }));
	st.activeItems.set("oc_1:someone", { text: "rm -rf /tmp/x", senderName: "示例用户" });
	const text = progressReportOf(st, DEFAULT_CONFIG, msg());
	assert.match(text, /这个群里另有 1 个任务在执行/);
	assert.match(text, /示例用户：已运行 1 分 5 秒/);
	assert.doesNotMatch(text, /rm -rf/, "不能把别人的命令内容贴出来");
});

test("用量快照：没有会话时返回 undefined，有会话时带模型标识", () => {
	const st = state();
	assert.equal(usageSnapshotOf(st, DEFAULT_CONFIG, msg()), undefined);
	st.sessions.map.set("oc_1", session({ agent: { modelId: "anthropic/claude" } }));
	assert.equal(usageSnapshotOf(st, DEFAULT_CONFIG, msg())?.modelLabel, "anthropic/claude");
});
