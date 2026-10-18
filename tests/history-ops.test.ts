/**
 * 改历史的命令（/undo /retry /fork /export）单独可测：
 * 步骤都是「等空闲 → 动 Pi 的历史 → 把结果讲给用户」，不涉及消息收发。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHistoryOps } from "../src/session/history-ops.js";
import { SessionTable } from "../src/session/session-table.js";
import { DEFAULT_CONFIG, type FeishuInboundMessage } from "../src/types.js";

const msg = (): FeishuInboundMessage => ({
	messageId: "om_1", chatId: "oc_1", chatType: "group", senderId: "ou_1",
	text: "hi", msgType: "text", resources: [],
} as unknown as FeishuInboundMessage);

function deps(overrides: Record<string, unknown> = {}) {
	const table = new SessionTable<{ conversationKey: string; chatId: string; sessionFile: string; lastItem?: { text: string; resources: unknown[] } }>();
	const log: Array<{ level: string; event: string; meta?: unknown }> = [];
	const requeued: Array<{ text: string; resources: unknown[] }> = [];
	return {
		table, log, requeued,
		value: {
			config: DEFAULT_CONFIG,
			sessions: table,
			busyReason: () => undefined,
			openAgent: async () => ({ key: "k", session: { conversationKey: "k", chatId: "oc_1", sessionFile: "/tmp/x" }, agent: {} as never }),
			requeue: async (_msg: unknown, item: { text: string; resources: unknown[] }) => { requeued.push({ text: item.text, resources: item.resources }); },
			log: (level: string, event: string, meta?: unknown) => { log.push({ level, event, meta }); },
			now: () => 1_000,
			...overrides,
		},
	};
}

test("/undo：会话忙时先说忙，不碰历史", async () => {
	// busyReason 由 `openAgent` 返回忙文案体现（管理器里那句拒绝就是在 openAgent 内部产生的）
	const ctx = deps({ openAgent: async () => "当前会话仍在执行或有排队任务，请先 /stop 或等待完成" });
	const ops = createHistoryOps(ctx.value as never);
	assert.match(await ops.undo(msg()), /请先 \/stop/);
});

test("/undo：没有可撤销的对话时给明确结论", async () => {
	const ctx = deps({
		openAgent: async () => ({ key: "k", session: { conversationKey: "k", chatId: "oc_1", sessionFile: "/tmp/x" }, agent: { userMessages: () => [], navigateTo: async () => ({ cancelled: false }) } as never }),
	});
	const ops = createHistoryOps(ctx.value as never);
	assert.match(await ops.undo(msg()), /还没有可撤销的对话/);
	assert.equal(ctx.log.length, 0, "没动历史就不该记 undo 日志");
});

test("/retry：优先用桥记下的原文重投（避免重复注入发言人/引用）", async () => {
	const ctx = deps({
		openAgent: async () => ({
			key: "k",
			session: { conversationKey: "k", chatId: "oc_1", sessionFile: "/tmp/x", lastItem: { text: "原始问题", resources: [] } },
			agent: {
				userMessages: () => [{ entryId: "e1", text: "[发言人：陈勇（open_id=ou_1）]\n\n原始问题" }],
				navigateTo: async () => ({ cancelled: false, editorText: "[发言人：陈勇…]\n\n原始问题" }),
				modelId: "p/m",
			} as never,
		}),
	});
	const ops = createHistoryOps(ctx.value as never);
	assert.match(await ops.retry(msg()), /正在重试上一条消息/);
	assert.deepEqual(ctx.requeued.map((item) => item.text), ["原始问题"], "重发的是桥记下的原文，不是含注入行的编辑器文本");
});

test("/fork：没开会话索引时直接拒绝（避免分叉成功但无处记录）", async () => {
	const ctx = deps();
	const ops = createHistoryOps(ctx.value as never);
	assert.match(await ops.fork(msg()), /未启用会话索引/);
});

test("/export：没配置导出目录或发文件能力时拒绝", async () => {
	const ctx = deps();
	const ops = createHistoryOps(ctx.value as never);
	assert.match(await ops.export(msg(), "md"), /未启用导出/);
});
