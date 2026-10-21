/**
 * 「等你作答」这条链路：有界等待、超时、中止、先说别的、skip。
 *
 * 关键不变量：**超时和「用户先发了别的消息」都不删记录**（卡片继续有效，用户之后还能点，
 * 答案标成补充作答）；只有 `skip`、新提问、会话重置、过期才作废那张卡。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ClarificationStore, MAX_CLARIFY_WAIT_MS, buildClarificationCard, isAtomicClarificationCard, resolveClarifyWaitMs, skippedCardFor } from "../src/interaction/clarification-store.js";

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

test("先说别的：用户发了别的消息 → 等待器立刻收到 interrupted，记录保留、之后作答算补充作答", async () => {
	const { store, audits } = makeStore();
	const record = store.create(request());
	store.attachCard(record.id, "om_card");
	const waiting = store.waitForAnswer(record.id, 60_000);
	const outcome = store.attemptTextResponse("oc_1", "等下，我先确认一下测试环境的状态");
	assert.equal(outcome.kind, "prose");
	if (outcome.kind === "prose") assert.equal(outcome.waiterActive, true);
	assert.deepEqual(await waiting, { kind: "interrupted" }, "工具不能等到超时（那条消息要等工具结束才进得来）");
	assert.equal(store.pendingCount(), 1, "说别的不作废提问");
	assert.ok(audits.some((event) => event.decision === "interrupted"), "中断等待要留审计");

	const later = store.attemptTextResponse("oc_1", "1");
	assert.equal(later.kind, "answered", "之后回「1」仍然是这道题的答案");
	if (later.kind === "answered") assert.deepEqual([later.choice, later.waiterActive, later.late], ["测试", false, true]);
});

test("先说别的：没有工具在等时，提问原样保留、不留痕", () => {
	const { store, audits } = makeStore();
	const record = store.create(request());
	const outcome = store.attemptTextResponse("oc_1", "顺便看下构建为什么失败");
	assert.equal(outcome.kind, "prose");
	if (outcome.kind === "prose") assert.equal(outcome.waiterActive, false);
	assert.equal(store.pendingCount(), 1);
	assert.equal(store.snapshot()[0]?.id, record.id);
	assert.equal(audits.length, 0);
});

test("skip：作废提问、等待器收到 dropped(skipped)，卡片能重绘成只读的「已跳过」", async () => {
	const { store, audits } = makeStore();
	const record = store.create(request());
	store.attachCard(record.id, "om_card");
	const waiting = store.waitForAnswer(record.id, 60_000);
	assert.equal(store.attemptTextResponse("oc_1", "skip").kind, "skipped");
	assert.deepEqual(await waiting, { kind: "dropped", reason: "skipped" });
	assert.equal(store.pendingCount(), 0);
	assert.ok(audits.some((event) => event.decision === "skipped"), "跳过要留审计");
	assert.equal(store.attemptTextResponse("oc_1", "1").kind, "none", "之后回「1」不再算作这道已放弃的题的答案");

	const card = JSON.stringify(skippedCardFor(record));
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

// ── 打字回复的三分法（对照 hermes）：答案是答案 / 无效选择重试 / 散文照常投递 ──────────

test("打字：数字与选项原文都算答案（忽略卡片上的 ⭐/（推荐）装饰）", () => {
	const { store } = makeStore();
	store.create(request());
	const viaNumber = store.attemptTextResponse("oc_1", "2");
	assert.equal(viaNumber.kind, "answered");
	if (viaNumber.kind === "answered") assert.equal(viaNumber.choice, "正式");
	assert.equal(store.pendingCount(), 0, "答过就消费掉");

	store.create({ ...request(), recommended: [1] });
	const viaLabel = store.attemptTextResponse("oc_1", "正式（推荐）");
	assert.equal(viaLabel.kind, "answered", "带装饰的选项文本也要匹配上");
	if (viaLabel.kind === "answered") assert.equal(viaLabel.choice, "正式");
});

test("打字：像选择但无效 → 保留提问，让用户重试（不要当成散文作废）", () => {
	const { store } = makeStore();
	store.create(request());
	const outcome = store.attemptTextResponse("oc_1", "9");
	assert.equal(outcome.kind, "invalid_selection");
	assert.match(outcome.kind === "invalid_selection" ? outcome.reason : "", /没听懂「9」/);
	assert.equal(store.pendingCount(), 1, "卡片还在，改一下就能答");
});

test("打字：多题表单的文字一律当散文 —— 表单保留，用户还能回去提交", async () => {
	const { store } = makeStore();
	const form = store.create({ conversationKey: "oc_1", chatId: "oc_1", chatType: "group", questions: [
		{ question: "字段？", options: ["名称", "价格"] }, { question: "范围？", options: ["当前", "近 7 天"] },
	] });
	store.attachCard(form.id, "om_form");
	const waiting = store.waitForAnswer(form.id, 60_000);
	assert.equal(store.attemptTextResponse("oc_1", "名称，当前").kind, "prose", "多题靠自由文本猜不可靠，当散文");
	assert.deepEqual(await waiting, { kind: "interrupted" });
	const submitted = store.decideForm({ messageId: "om_form", chatId: "oc_1", operatorOpenId: "ou_1", values: { q1: "名称", q2: "当前" } });
	assert.equal(submitted.ok, true, "表单仍然能提交");
});

test("打字：skip 关键字显式跳过；多选支持 1,3 与「1 3」", () => {
	const { store } = makeStore();
	store.create(request());
	assert.equal(store.attemptTextResponse("oc_1", "skip").kind, "skipped");
	assert.equal(store.pendingCount(), 0);

	store.create({ ...request(), multiSelect: true, options: ["登录", "下单", "支付"] });
	const picked = store.attemptTextResponse("oc_1", "1, 3");
	assert.equal(picked.kind, "answered");
	if (picked.kind === "answered") assert.equal(picked.choice, "登录、支付");

	store.create({ ...request(), multiSelect: true, options: ["登录", "下单", "支付"] });
	assert.equal(store.attemptTextResponse("oc_1", "1 9").kind, "invalid_selection", "任一项越界整条无效");
});

test("打字答案正在被等待时：交给工具，消息不再进会话（waiterActive）", async () => {
	const { store } = makeStore();
	const record = store.create(request());
	const waiting = store.waitForAnswer(record.id, 60_000);
	const outcome = store.attemptTextResponse("oc_1", "1");
	assert.equal(outcome.kind, "answered");
	if (outcome.kind === "answered") assert.equal(outcome.waiterActive, true, "有工具在等 → 这条消息归于工具结果");
	const settled = await waiting;
	assert.equal(settled.kind, "answered");
});

test("打字答案在超时之后：标记为补充作答（late）", async () => {
	const { store } = makeStore();
	const record = store.create(request());
	await store.waitForAnswer(record.id, 10);
	const outcome = store.attemptTextResponse("oc_1", "正式");
	assert.equal(outcome.kind, "answered");
	if (outcome.kind === "answered") {
		assert.equal(outcome.waiterActive, false, "没有工具在等了");
		assert.equal(outcome.late, true, "要让消息带上「补充作答」标记");
	}
});

test("超时重绘只动原子卡（表单卡不重绘，免得清掉用户没提交的输入）", () => {
	const { store } = makeStore();
	const button = store.create(request());
	const form = store.create({ conversationKey: "oc_2", chatId: "oc_2", chatType: "group", question: "要包含哪些？", options: ["名称", "价格"], multiSelect: true });
	assert.equal(isAtomicClarificationCard(button), true);
	assert.equal(isAtomicClarificationCard(form), false);
	const withNote = JSON.stringify(buildClarificationCard(button, { note: "⏳ 等待已结束" }));
	assert.match(withNote, /等待已结束/);
	assert.match(withNote, /"op":"clarify"/, "注记不影响可点");
});

test("等待时长：模型给的 waitSeconds 封顶、配置更大时以配置为准、总要短于工具空闲超时", () => {
	assert.deepEqual(resolveClarifyWaitMs({}), { waitMs: 60_000, clamped: false }, "默认 60 秒");
	assert.deepEqual(resolveClarifyWaitMs({ configWaitMs: 0 }), { waitMs: 0, clamped: false }, "配成 0 = 纯异步");
	assert.deepEqual(resolveClarifyWaitMs({ waitSeconds: 5 }), { waitMs: 5_000, clamped: false });
	assert.deepEqual(resolveClarifyWaitMs({ waitSeconds: -3 }), { waitMs: 0, clamped: false });
	assert.deepEqual(resolveClarifyWaitMs({ waitSeconds: 86_400 }), { waitMs: MAX_CLARIFY_WAIT_MS, clamped: true }, "模型填一天也只等 10 分钟");
	assert.deepEqual(resolveClarifyWaitMs({ waitSeconds: 86_400, configWaitMs: 30 * 60_000 }), { waitMs: 30 * 60_000, clamped: true }, "管理员配了更长，就能用到那么长");
	assert.deepEqual(resolveClarifyWaitMs({ waitSeconds: 300, toolIdleTimeoutMs: 120_000 }), { waitMs: 115_000, clamped: true }, "不能让工具空闲超时先把整轮中止");
	assert.deepEqual(resolveClarifyWaitMs({ configWaitMs: 600_000, toolIdleTimeoutMs: 0 }), { waitMs: 600_000, clamped: false }, "空闲超时 0 = 不限制");
});
