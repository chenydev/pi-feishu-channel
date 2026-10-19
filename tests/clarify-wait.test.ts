/**
 * 「等你作答」这条链路：有界等待、超时、中止、隐式跳过。
 *
 * 关键不变量：**超时不删记录**（卡片继续有效，用户之后还能点），
 * 而「用户发了别的消息」才真正作废那张卡（否则几天后误点会把过时答案插进当时的对话）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ClarificationStore, buildClarificationCard, skippedCardFor } from "../src/interaction/clarification-store.js";

function makeStore() {
	let now = 1_000_000;
	const audits: Array<{ decision: string; choice?: string }> = [];
	const store = new ClarificationStore({
		now: () => now,
		onAudit: (event) => { audits.push({ decision: event.decision, choice: event.choice }); },
	});
	return { store, audits, advance: (ms: number) => { now += ms; }, at: () => now };
}

const request = () => ({
	conversationKey: "oc_1", chatId: "oc_1", chatType: "group" as const,
	question: "目标环境？", options: ["测试", "正式"],
});

test("等到了：作答立刻让等待落定，返回答案", async () => {
	const { store } = makeStore();
	const record = store.create(request());
	const waiting = store.waitForAnswer(record.id, 60_000);
	const decided = store.decide({ id: record.id, token: record.token, messageId: "om_card", chatId: "oc_1", operatorOpenId: "ou_1", choice: "正式" });
	assert.equal(decided.ok, true);
	const outcome = await waiting;
	assert.equal(outcome.kind, "answered");
	if (outcome.kind !== "answered") return;
	assert.deepEqual(outcome.answers, [{ question: "目标环境？", choices: ["正式"] }]);
});

test("超时：不删记录（卡片还能点），并打上 timedOutAt 供「补充作答」标记", async () => {
	const { store, advance } = makeStore();
	const record = store.create(request());
	const outcome = await store.waitForAnswer(record.id, 50);
	advance(100);
	assert.equal(outcome.kind, "timeout");
	assert.equal(store.pendingCount(), 1, "超时不能把记录删掉");
	assert.ok(store.snapshot().some((item) => item.id === record.id));
	// 之后用户再点：仍然有效，且记录里带着超时痕迹
	const decided = store.decide({ id: record.id, token: record.token, messageId: "om_card", chatId: "oc_1", operatorOpenId: "ou_1", choice: "测试" });
	assert.equal(decided.ok, true);
	assert.ok((decided.record?.timedOutAt ?? 0) > 0, "补充作答要知道之前超时过");
});

test("中止（/stop）：立刻返回 cancelled，记录仍保留", async () => {
	const { store } = makeStore();
	const record = store.create(request());
	const controller = new AbortController();
	const waiting = store.waitForAnswer(record.id, 60_000, controller.signal);
	controller.abort();
	assert.equal((await waiting).kind, "cancelled");
	assert.equal(store.pendingCount(), 1, "中止不等于放弃这道题的作答机会");
});

test("隐式跳过：用户发了别的消息 → 记录作废、等待器收到 dropped、卡片能重绘成「已跳过」", async () => {
	const { store, audits } = makeStore();
	const record = store.create(request());
	store.attachCard(record.id, "om_card");
	const waiting = store.waitForAnswer(record.id, 60_000);
	const skipped = store.skipPending("oc_1");
	assert.equal(skipped.length, 1);
	assert.equal((await waiting).kind, "dropped");
	assert.equal(store.pendingCount(), 0);
	assert.ok(audits.some((event) => event.decision === "skipped"), "跳过要留审计");

	const card = JSON.stringify(skippedCardFor(skipped[0]!));
	assert.match(card, /已跳过/);
	assert.match(card, /"disabled":true/, "选项只读");
	assert.doesNotMatch(card, /"behaviors"/, "跳过后不能再触发回调");
});

test("保护窗口：只算最近提问的，超窗口的不再挡住会话回收", () => {
	const { store, advance } = makeStore();
	store.create(request());
	assert.equal(store.pendingRecentCount("oc_1", 15 * 60_000), 1);
	advance(16 * 60_000);
	assert.equal(store.pendingRecentCount("oc_1", 15 * 60_000), 0, "过了保护窗口就不算忙（记录还在，卡片仍可点）");
	assert.equal(store.pendingCount(), 1);
});

test("等待不影响提问卡本身：卡片仍然可点（没有变成只读）", async () => {
	const { store } = makeStore();
	const record = store.create(request());
	void store.waitForAnswer(record.id, 10);
	const card = JSON.stringify(buildClarificationCard(record));
	assert.match(card, /"op":"clarify"/, "等待期间卡片照常可点");
	assert.doesNotMatch(card, /"disabled":true/);
});
