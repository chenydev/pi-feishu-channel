import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PendingStore } from "../src/session/pending-store.js";
import type { FeishuInboundMessage } from "../src/types.js";

function inbound(id: string, over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
	return {
		messageId: id,
		chatId: "oc_group",
		chatType: "group",
		senderId: "ou_sender",
		senderName: "用户",
		isBot: false,
		msgType: "text",
		text: "hello",
		mentions: [],
		resources: [],
		threadId: "om_thread",
		replyToMessageId: "om_parent",
		replyToText: "quoted",
		raw: { ignored: true },
		ts: 123,
		...over,
	};
}

test("PendingStore：完整记录跨重启恢复，ack 只删除目标记录", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-pending-"));
	const file = join(dir, "pending.jsonl");
	try {
		const first = new PendingStore(file, { now: () => 1_000 });
		first.claim(inbound("m1"), "oc_group:t:om_thread");
		first.claim(inbound("m2", { chatType: "p2p", chatId: "oc_dm", senderId: "ou_dm", threadId: undefined }), "oc_dm");
		assert.equal(first.depth(), 2);

		const restarted = new PendingStore(file, { now: () => 1_100 });
		const recovered = restarted.recoverable();
		assert.equal(recovered.length, 2);
		assert.equal(recovered[0].conversationKey, "oc_group:t:om_thread");
		assert.equal(recovered[0].message.senderId, "ou_sender");
		assert.equal(recovered[0].message.replyToText, "quoted");
		assert.equal(recovered[0].attempts, 2);
		restarted.ack("m1");
		assert.equal(restarted.depth(), 1);

		const crashedAgain = new PendingStore(file, { now: () => 1_200 });
		assert.deepEqual(crashedAgain.recoverable().map((record) => record.id), ["m2"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PendingStore：损坏行不影响其他记录，日志每行都可解析", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-pending-corrupt-"));
	const file = join(dir, "pending.jsonl");
	try {
		const store = new PendingStore(file);
		store.claim(inbound("m1"), "lane");
		writeFileSync(file, `${readFileSync(file, "utf8")}{broken\n`, "utf8");
		const restarted = new PendingStore(file);
		assert.equal(restarted.depth(), 1, "坏行跳过，其它记录照常恢复");
		restarted.ack("m1");
		// 追加式日志：ack 写的是删除标记，读回来必须是 0 条（不再要求文件当场清空）
		assert.equal(new PendingStore(file).depth(), 0, "ack 之后重启不能再把这条当成待处理");
		const bad = readFileSync(file, "utf8").split("\n").filter(Boolean)
			.filter((line) => { try { JSON.parse(line); return false; } catch { return true; } });
		assert.equal(bad.length, 1, "只有那条人为损坏的行不可解析（写入方每行都是完整 JSON）");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PendingStore：工具边界前持久标记 manual replay", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-pending-manual-"));
	const file = join(dir, "pending.jsonl");
	try {
		const store = new PendingStore(file);
		store.claim(inbound("manual"), "oc:u:ou");
		store.markManual("manual");
		// 追加式日志：取最后一条该记录的快照（后写覆盖先写）
		const latest = readFileSync(file, "utf8").split("\n").filter(Boolean)
			.map((line) => JSON.parse(line) as { id?: string; replayPolicy?: string })
			.filter((row) => row.id === "manual").at(-1);
		assert.equal(latest?.replayPolicy, "manual");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PendingStore：每条消息只追加一行，行数膨胀后压实成完整快照", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-pending-append-"));
	const file = join(dir, "pending.jsonl");
	const lines = (): number => readFileSync(file, "utf8").split("\n").filter(Boolean).length;
	try {
		const store = new PendingStore(file);
		store.claim(inbound("a"), "lane");
		const afterFirst = lines();
		store.claim(inbound("b"), "lane");
		assert.equal(lines(), afterFirst + 1, "新增一条只追加一行，不重写整表");

		store.ack("a");
		assert.equal(new PendingStore(file).depth(), 1, "删除标记生效");
		// 大量 ack 之后行数会膨胀；继续写会触发压实，行数回落到记录数
		for (let index = 0; index < 120; index += 1) {
			store.claim(inbound(`x${index}`), "lane");
			store.ack(`x${index}`);
		}
		const compacted = lines();
		assert.ok(compacted <= store.depth() * 3 + 52, `压实后行数要回落（实际 ${compacted}）`);
		assert.equal(new PendingStore(file).depth(), store.depth(), "压实后重新加载结果一致");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
