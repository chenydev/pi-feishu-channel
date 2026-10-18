/**
 * 用户可见提示的投递规则：虚拟会话跳过、优先持久 outbox、失败必须留日志。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNoticeSender, queuedNoticeText } from "../src/session/notices.js";

function recorder() {
	const logs: Array<{ level: string; event: string; meta?: unknown }> = [];
	return { logs, log: (level: string, event: string, meta?: unknown) => { logs.push({ level, event, meta }); } };
}

test("提示：虚拟会话（云文档评论）不发飞书消息，只记一条 info", async () => {
	const { logs, log } = recorder();
	const sender = createNoticeSender({ sender: { send: async () => { throw new Error("不该发"); } } as never, log: log as never });
	assert.equal(await sender.send({ chatId: "doc:abc", text: "hi" }), false);
	assert.equal(logs[0]?.event, "feishu.conv.notify_skipped_external");
});

test("提示：有持久 outbox 时进队列；去重键与车道按调用方给的走", async () => {
	const enqueued: Array<{ chatId: string; dedupeKey: string; laneKey: string; kind: string }> = [];
	const sender = createNoticeSender({
		sender: { send: async () => ({ success: true }) } as never,
		durableOutbox: { enqueue: (chatId: string, _text: string, _opts: unknown, meta: { dedupeKey: string; laneKey: string; kind: string }) => { enqueued.push({ chatId, ...meta }); return ["id"]; } } as never,
	});
	assert.equal(await sender.send({ chatId: "oc_1", text: "x", dedupeKey: "m1:busy", laneKey: "k1", kind: "error" }), true);
	assert.deepEqual(enqueued, [{ chatId: "oc_1", dedupeKey: "m1:busy", laneKey: "k1", kind: "error" }]);
});

test("提示：投递失败要留日志（否则用户看到的是「什么也没说」）", async () => {
	const { logs, log } = recorder();
	const failed = createNoticeSender({ sender: { send: async () => ({ success: false, error: "230002" }) } as never, log: log as never });
	assert.equal(await failed.send({ chatId: "oc_1", text: "x" }), false);
	assert.equal(logs.at(-1)?.event, "feishu.conv.notify_failed");
	assert.match(JSON.stringify(logs.at(-1)?.meta), /230002/);

	const thrown = createNoticeSender({ sender: { send: async () => { throw new Error("网络炸了"); } } as never, log: log as never });
	assert.equal(await thrown.send({ chatId: "oc_1", text: "x" }), false);
	assert.match(JSON.stringify(logs.at(-1)?.meta), /网络炸了/);
});

test("提示：排队回执带位置与三条自救命令", () => {
	const text = queuedNoticeText(3);
	assert.match(text, /第 3 个/);
	assert.match(text, /\/progress/);
	assert.match(text, /\/queue clear/);
});
