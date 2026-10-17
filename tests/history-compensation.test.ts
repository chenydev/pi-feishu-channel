import assert from "node:assert/strict";
import { test } from "node:test";
import { compensateKnownChats } from "../src/runtime/history-compensation.js";
import type { FeishuInboundMessage } from "../src/types.js";

function message(id: string, chatId: string): FeishuInboundMessage {
	return { messageId: id, chatId, chatType: "group", senderId: "ou", isBot: false, msgType: "text", text: id, mentions: [], resources: [], raw: undefined, ts: 0 };
}

test("历史补收：模拟 10 秒断线，逐 chat 有界补收并继续处理权限失败", async () => {
	const handled: string[] = [];
	const calls: Array<{ chatId: string; start: number; end: number; limit: number }> = [];
	const result = await compensateKnownChats({
		chatIds: ["oc_a", "oc_denied", "oc_b"],
		outageStartedAt: 90_000,
		now: 100_000,
		maxWindowMs: 300_000,
		maxPerChat: 2,
		list: async (chatId, start, end, limit) => {
			calls.push({ chatId, start, end, limit });
			if (chatId === "oc_denied") throw new Error("forbidden");
			// 接口按倒序取回、这里给的是升序：3 条 > maxPerChat(2) → 丢更早那条
			return { messages: [message(`${chatId}-1`, chatId), message(`${chatId}-2`, chatId), message(`${chatId}-3`, chatId)], hasMore: true };
		},
		handle: async (item) => { handled.push(item.messageId); },
	});
	assert.deepEqual(result, { recovered: 4, errors: 1, windowTruncated: false, truncatedChats: 2 });
	assert.equal(calls.every((call) => call.start === 90_000 && call.end === 100_000 && call.limit === 2), true, "只按上限要，不再多要一条");
	// 截断时保留最新的：丢 oc_a-1 / oc_b-1（更早的），处理 oc_a-2、oc_a-3
	assert.deepEqual(handled, ["oc_a-2", "oc_a-3", "oc_b-2", "oc_b-3"]);
});

test("历史补收：过长断线窗口明确统计截断", async () => {
	const result = await compensateKnownChats({
		chatIds: [],
		outageStartedAt: 0,
		now: 1_000_000,
		maxWindowMs: 300_000,
		maxPerChat: 50,
		list: async () => ({ messages: [], hasMore: false }),
		handle: async () => {},
	});
	assert.equal(result.windowTruncated, true);
	assert.equal(result.truncatedChats, 0);
});
