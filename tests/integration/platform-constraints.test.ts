/**
 * 在"模拟平台约束"的假服务上跑真实的发送链路（Sender / Outbox / StreamingCard）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Sender } from "../../src/outbound/sender.js";
import { Outbox } from "../../src/outbound/outbox.js";
import { StreamingCard } from "../../src/outbound/streaming-card.js";
import type { FeishuTransport } from "../../src/inbound/transport.js";
import { DEFAULT_CONFIG } from "../../src/types.js";
import { FakeFeishu } from "./fake-feishu.js";

function sender(fake: FakeFeishu): Sender {
	return new Sender({ config: DEFAULT_CONFIG, transport: { rawRequest: fake.rawRequest } as unknown as FeishuTransport });
}

test("平台约束：回复已撤回的消息 → 退回直接发送，不丢答案", async () => {
	const fake = new FakeFeishu();
	const parent = (await fake.rawRequest({ method: "POST", url: "/open-apis/im/v1/messages", data: { receive_id: "oc", msg_type: "text", content: "q" } })) as { data: { message_id: string } };
	fake.recall(parent.data.message_id);
	const result = await sender(fake).send("oc", "答案", { replyTo: parent.data.message_id });
	assert.equal(result.success, true);
	assert.equal(result.fallback, true);
	assert.ok(fake.visibleTexts("oc").some((text) => text.includes("答案")));
});

test("平台约束：编辑次数用尽（230072）→ 最终答案改为新发一条", async () => {
	const fake = new FakeFeishu();
	const draft = (await fake.rawRequest({ method: "POST", url: "/open-apis/im/v1/messages", data: { receive_id: "oc", msg_type: "text", content: "draft" } })) as { data: { message_id: string } };
	fake.messages.get(draft.data.message_id)!.edits = 20;
	const result = await sender(fake).send("oc", "最终答案", { editMessageId: draft.data.message_id });
	assert.equal(result.success, true);
	assert.notEqual(result.messageId, draft.data.message_id);
	assert.ok(fake.visibleTexts("oc").some((text) => text.includes("最终答案")));
});

test("平台约束：限流时 outbox 退避重试直到成功；同一 uuid 不产生重复消息", async () => {
	const fake = new FakeFeishu();
	fake.rateLimitNext = 2;
	const dir = mkdtempSync(join(tmpdir(), "fake-outbox-"));
	try {
		const s = sender(fake);
		const outbox = new Outbox({
			file: join(dir, "outbox.jsonl"),
			prepare: (chatId, content, opts) => s.prepare(chatId, content, opts),
			send: (request, checkpoint) => s.sendPrepared(request, checkpoint),
			backoffMs: 5,
			random: () => 0,
		});
		outbox.start();
		outbox.enqueue("oc", "限流后的答案", {}, { dedupeKey: "k1", laneKey: "oc", kind: "final" });
		const deadline = Date.now() + 3_000;
		while (outbox.stats().sent === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		assert.equal(outbox.stats().sent, 1);
		assert.equal(fake.visibleTexts("oc").filter((text) => text.includes("限流后的答案")).length, 1);
		await outbox.stop();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("平台约束：机器人不在群里（230002）是永久失败，不无限重试", async () => {
	const fake = new FakeFeishu();
	fake.notInChats.add("oc_gone");
	const result = await sender(fake).send("oc_gone", "x");
	assert.equal(result.success, false);
	assert.equal(result.retryable, false);
});

test("平台约束：流式卡片的 sequence 严格递增；回复目标已撤回时卡片仍发得出去", async () => {
	const fake = new FakeFeishu();
	const parent = (await fake.rawRequest({ method: "POST", url: "/open-apis/im/v1/messages", data: { receive_id: "oc", msg_type: "text", content: "q" } })) as { data: { message_id: string } };
	fake.recall(parent.data.message_id);
	const card = new StreamingCard({ rawRequest: fake.rawRequest, throttleMs: 0 });
	assert.equal(await card.start({ chatId: "oc", replyTo: parent.data.message_id }), true);
	card.update("第一段");
	card.update("第一段第二段");
	assert.equal(await card.finish("第一段第二段，完"), true);
	const [entity] = [...fake.cards.values()];
	assert.ok([...entity.elements.values()].some((content) => content.includes("完")));
});
