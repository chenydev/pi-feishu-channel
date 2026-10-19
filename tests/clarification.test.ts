/**
 * 澄清/选择提问（不阻塞）：
 * - 跨群、旧卡、伪造值、无效选项、过期、会话重置后的点击一律拒绝；
 * - 正确选项**只消费一次**；无权作答时不消费（别人还能点）；
 * - 同一会话的新提问让旧卡失效；记录落盘，重启后仍能点；
 * - 选择**不写入**审批 allowlist（澄清 ≠ 工具授权）。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ClarificationStore,
	buildClarificationCard,
	answeredCardFor,
	clarificationAnswerText,
	clarificationTextFallback,
} from "../src/interaction/clarification-store.js";

function makeStore(options: { ttlMs?: number; now?: () => number; file?: string } = {}) {
	const audits: Array<{ decision: string; choice?: string }> = [];
	const store = new ClarificationStore({
		ttlMs: options.ttlMs, now: options.now, file: options.file,
		onAudit: (event) => { audits.push({ decision: event.decision, choice: event.choice }); },
	});
	return { store, audits };
}

function request(over: Partial<Parameters<ClarificationStore["create"]>[0]> = {}) {
	return {
		conversationKey: "oc_chat#ou_user", chatId: "oc_chat", threadId: "th_1", chatType: "group" as const, askerId: "ou_user",
		question: "选哪个方案？", options: ["方案A", "方案B"],
		...over,
	};
}

const click = (store: ClarificationStore, record: { id: string; token: string }, over: Partial<Parameters<ClarificationStore["decide"]>[0]> = {}, authorize?: Parameters<ClarificationStore["decide"]>[1]) =>
	store.decide({ id: record.id, token: record.token, messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_user", choice: "方案A", ...over }, authorize);

test("澄清提问：正确选项只消费一次，重复点击被拒", () => {
	const { store, audits } = makeStore();
	const record = store.create(request());
	store.attachCard(record.id, "om_card");
	const first = click(store, record);
	assert.equal(first.ok, true, first.reason);
	assert.equal(first.record?.conversationKey, "oc_chat#ou_user", "返回提问所在的会话，供合成消息路由");
	assert.equal(click(store, record, { choice: "方案B" }).ok, false, "重复点击必须拒绝");
	assert.equal(store.pendingCount(), 0);
	assert.equal(audits.filter((event) => event.decision === "answered").length, 1, "只能审计一次回答");
});

test("澄清提问：跨群、token 或卡片不匹配、无效选项都拒绝", () => {
	const { store } = makeStore();
	const record = store.create(request());
	store.attachCard(record.id, "om_card");
	assert.equal(click(store, record, { chatId: "oc_other" }).ok, false, "跨群");
	assert.equal(click(store, { id: record.id, token: "forged" }).ok, false, "伪造 token");
	assert.equal(click(store, record, { messageId: "om_other" }).ok, false, "别的卡片");
	assert.equal(click(store, record, { choice: "方案C" }).ok, false, "无效选项");
	assert.equal(store.pendingCount(), 1, "以上都不消费");
});

test("澄清提问：无权作答时不消费，别人仍可以点", () => {
	const { store } = makeStore();
	const record = store.create(request());
	store.attachCard(record.id, "om_card");
	const refused = click(store, record, { operatorOpenId: "ou_outsider" }, () => "你在这里没有使用机器人的权限，不能作答");
	assert.deepEqual([refused.ok, refused.reason], [false, "你在这里没有使用机器人的权限，不能作答"]);
	assert.equal(click(store, record, {}, () => undefined).ok, true);
});

test("澄清提问：过期后点击被拒，提示直接回复文字；ttl=0 不设上限", () => {
	let now = 0;
	const { store } = makeStore({ ttlMs: 1_000, now: () => now });
	const record = store.create(request());
	store.attachCard(record.id, "om_card");
	now = 1_001;
	const late = click(store, record);
	assert.equal(late.ok, false);
	assert.match(late.reason, /直接回复文字/);

	const forever = makeStore({ ttlMs: 0, now: () => now }).store;
	const kept = forever.create(request());
	forever.attachCard(kept.id, "om_card");
	now = 365 * 24 * 3_600_000;
	assert.equal(click(forever, kept).ok, true);
});

test("澄清提问：同一会话的新提问让旧卡失效；别的会话不受影响；会话重置全部失效", () => {
	const { store, audits } = makeStore();
	const old = store.create(request());
	const other = store.create(request({ conversationKey: "oc_chat#ou_other" }));
	const latest = store.create(request({ question: "新问题" }));
	assert.equal(click(store, old, { messageId: "om_any" }).ok, false, "旧卡失效");
	assert.ok(audits.some((event) => event.decision === "superseded"));
	assert.equal(store.pendingCount(), 2, "别的会话的提问还在");
	assert.equal(store.cancelConversation("oc_chat#ou_user"), 1);
	assert.equal(click(store, latest, { messageId: "om_any" }).ok, false, "/new 后失效");
	assert.equal(click(store, other, { messageId: "om_any" }).ok, true);
});

test("澄清提问：记录落盘，重启后卡片仍能点；卡片发送失败的记录不保留", () => {
	const file = join(mkdtempSync(join(tmpdir(), "clarify-")), "clarifications.json");
	const first = makeStore({ file }).store;
	const record = first.create(request());
	first.attachCard(record.id, "om_card");
	const failed = first.create(request({ conversationKey: "oc_chat#ou_other" }));
	first.discard(failed.id);

	const restarted = makeStore({ file }).store;
	assert.equal(restarted.pendingCount(), 1);
	assert.equal(click(restarted, record).ok, true, "重启后点击仍然有效");
	assert.equal(makeStore({ file }).store.pendingCount(), 0, "答过的不再恢复");
});

test("澄清提问：选项数量与问题内容校验", () => {
	const { store } = makeStore();
	assert.throws(() => store.create(request({ options: ["只有一个"] })), /至少需要 2 个选项/, "少于 2 个选项必须拒绝");
	const many = store.create(request({ options: ["a", "b", "c", "d", "e"] }));
	assert.equal(many.options.length, 4, "超过 4 个选项应截断");
	const long = store.create(request({ question: "x".repeat(1_000) }));
	assert.equal(long.question.length, 500, "问题应截断");
});

test("澄清提问：卡片与文本回退都携带全部选项；点击进入会话的消息带上问题", () => {
	const { store } = makeStore();
	const record = store.create(request({ options: ["方案A", "方案B", "方案C"] }));
	const card = JSON.stringify(buildClarificationCard(record));
	for (const option of ["方案A", "方案B", "方案C"]) assert.ok(card.includes(option), `卡片必须含选项 ${option}`);
	assert.ok(card.includes("\"op\":\"clarify\""), "卡片回调 op 必须是 clarify（不是 approval）");
	assert.ok(!card.includes("\"op\":\"approval\""), "澄清卡片绝不能伪装成审批卡");

	const fallback = clarificationTextFallback(record);
	assert.ok(fallback.includes("1. 方案A") && fallback.includes("3. 方案C"), "文本回退必须列出全部选项");
	assert.ok(fallback.includes("直接回复"), "文本回退必须说明如何回答");
	assert.equal(clarificationAnswerText("选哪个方案？", "方案B"), "[选择] 方案B\n（回答你的提问：选哪个方案？）");
});

test("澄清提问：选项短时每个选项一个整行按钮；有长选项时正文列完整选项、按钮只放编号", () => {
	const { store } = makeStore();
	type Button = { tag: string; text: { content: string }; value: { choice: string } };
	const buttonsOf = (card: unknown): Button[] => {
		const found: Button[] = [];
		const walk = (node: unknown): void => {
			if (!node || typeof node !== "object") return;
			if ((node as { tag?: string }).tag === "button") found.push(node as Button);
			for (const child of Object.values(node)) walk(child);
		};
		walk(card);
		return found;
	};

	const short = buildClarificationCard(store.create(request({ options: ["保持现状", "装到项目级"] })));
	assert.deepEqual(buttonsOf(short).map((button) => button.text.content), ["保持现状", "装到项目级"], "短选项原样做按钮，不截断");

	const options = [
		"保持现状：用户级已装同版本，无需再操作",
		"额外安装到项目级 ~/projects/demo/.agents/skills",
		"跳过",
	];
	const long = buildClarificationCard(store.create(request({ options })));
	const json = JSON.stringify(long);
	// 长选项不再「编号列表 + 选 N 按钮」两段式：直接把完整选项放进复选框，勾一个即答
	assert.equal(buttonsOf(long).length, 0, "长选项不用按钮");
	for (const option of options) assert.ok(json.includes(option), `选项文字必须完整出现：${option}`);
	assert.equal((json.match(/"tag":"checker"/g) ?? []).length, 3, "每个选项一个复选框");
	assert.match(json, /"op":"clarify"/, "勾选即回调作答");
});

test("澄清提问：不暴露任何授权接口（澄清 ≠ 工具授权）", () => {
	const { store } = makeStore();
	const api = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
	assert.ok(!api.some((name) => /allow|approve/i.test(name)), `澄清 store 不得暴露授权接口：${api.join(",")}`);
});

test("澄清卡片按钮：能在这里 @ 机器人的人就能作答；点击以点击人身份进入提问所在的会话", async () => {
	const { BridgeRuntime } = await import("../src/runtime/bridge-runtime.js");
	const { DEFAULT_CONFIG } = await import("../src/types.js");
	const { clarifyCardOps } = await import("../src/interaction/card-ops.js");
	const rt = new BridgeRuntime();
	rt.config = { ...DEFAULT_CONFIG, allowChats: ["oc_chat"], groupRules: { oc_chat: { policy: "allowlist", allowlist: ["ou_user", "ou_peer"] } } };
	rt.clarificationStore = new ClarificationStore();
	const routed: Array<{ text: string; senderId: string; conversationKey?: string }> = [];
	rt.convManager = { route: async (msg: { text: string; senderId: string }, options: { conversationKey?: string }) => { routed.push({ text: msg.text, senderId: msg.senderId, conversationKey: options.conversationKey }); return "queued"; } } as never;
	const log = { info() {}, warn() {}, error() {} };
	const op = clarifyCardOps({ rt, log, admins: () => [], runCommand: async () => undefined }).clarify as (action: unknown, value: Record<string, unknown>) => { toast?: { type: string; content: string } };
	const record = rt.clarificationStore.create(request());
	rt.clarificationStore.attachCard(record.id, "om_card");
	const press = (operator: string) => op({ messageId: "om_card", chatId: "oc_chat", operatorOpenId: operator, token: `tok-${operator}` }, { op: "clarify", clarificationId: record.id, token: record.token, choice: "方案B" });

	assert.equal(press("ou_outsider").toast?.content, "你在这里没有使用机器人的权限，不能作答", "群名单外的人不能作答（即使不看管理员名单）");
	assert.equal(press("ou_peer").toast?.type, "success", "群里其他有权限的人可以替发起人作答");
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(routed, [{ text: "[选择] 方案B\n（回答你的提问：选哪个方案？）", senderId: "ou_peer", conversationKey: "oc_chat#ou_user" }], "进入发起人的会话");
	assert.match(String(press("ou_user").toast?.content), /已过期/, "答过一次就失效");
});

test("超时之后才点卡：答案带「补充作答」标记（模型据此纠正，而不是当新指令重做）", async () => {
	const { BridgeRuntime } = await import("../src/runtime/bridge-runtime.js");
	const { DEFAULT_CONFIG } = await import("../src/types.js");
	const { clarifyCardOps } = await import("../src/interaction/card-ops.js");
	const rt = new BridgeRuntime();
	rt.config = { ...DEFAULT_CONFIG, allowChats: ["oc_chat"] };
	rt.clarificationStore = new ClarificationStore();
	const routed: string[] = [];
	rt.convManager = { route: async (msg: { text: string }) => { routed.push(msg.text); return "queued"; } } as never;
	const op = clarifyCardOps({ rt, log: { info() {}, warn() {}, error() {} }, admins: () => [], runCommand: async () => undefined }).clarify as (action: unknown, value: Record<string, unknown>) => { toast?: { type: string; content: string } };
	const record = rt.clarificationStore.create(request());
	rt.clarificationStore.attachCard(record.id, "om_card");

	// 等一次、超时（记录保留 + 打上超时痕迹）
	await rt.clarificationStore.waitForAnswer(record.id, 10);
	op({ messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_user" }, { op: "clarify", clarificationId: record.id, token: record.token, choice: "方案B" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.match(routed[0] ?? "", /^（补充作答：之前等作答超时了，当时没有按任何选项继续）/, "要标明这是补充作答");
	assert.match(routed[0] ?? "", /\[选择\] 方案B/);
});

test("工具正在等时点卡作答：答案只作为工具结果交回，不再发「[选择] …」进会话（否则模型收到两次）", async () => {
	const { BridgeRuntime } = await import("../src/runtime/bridge-runtime.js");
	const { DEFAULT_CONFIG } = await import("../src/types.js");
	const { clarifyCardOps } = await import("../src/interaction/card-ops.js");
	const rt = new BridgeRuntime();
	rt.config = { ...DEFAULT_CONFIG, allowChats: ["oc_chat"] };
	rt.clarificationStore = new ClarificationStore();
	const routed: string[] = [];
	rt.convManager = { route: async (msg: { text: string }) => { routed.push(msg.text); return "steered"; } } as never;
	const logs: Array<Record<string, unknown>> = [];
	const log = { info(event: string, meta?: Record<string, unknown>) { if (event === "feishu.clarify.answered") logs.push(meta ?? {}); }, warn() {}, error() {} };
	const ops = clarifyCardOps({ rt, log, admins: () => [], runCommand: async () => undefined });
	const press = ops.clarify as (action: unknown, value: Record<string, unknown>) => { toast?: { type: string }; card?: unknown };
	const submit = ops.clarify_submit as (action: unknown, value: Record<string, unknown>) => { toast?: { type: string }; card?: unknown };

	// 按钮卡
	const single = rt.clarificationStore.create(request());
	rt.clarificationStore.attachCard(single.id, "om_card");
	const waiting = rt.clarificationStore.waitForAnswer(single.id, 60_000);
	const pressed = press({ messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_user" }, { op: "clarify", clarificationId: single.id, token: single.token, choice: "方案B" });
	assert.equal(pressed.toast?.type, "success");
	assert.ok(pressed.card, "卡片照样变成已作答");
	assert.equal((await waiting).kind, "answered");

	// 表单卡
	const form = rt.clarificationStore.create({ conversationKey: "oc_chat", chatId: "oc_chat", chatType: "group", question: "要哪些？", options: ["名称", "价格"], multiSelect: true });
	rt.clarificationStore.attachCard(form.id, "om_form");
	const waitingForm = rt.clarificationStore.waitForAnswer(form.id, 60_000);
	const submitted = submit({ messageId: "om_form", chatId: "oc_chat", operatorOpenId: "ou_user", formValue: { q1__opt0: true } }, { op: "clarify_submit", clarificationId: form.id, token: form.token });
	assert.equal(submitted.toast?.type, "success");
	assert.equal((await waitingForm).kind, "answered");

	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(routed, [], "工具已经拿到答案，不能再注入一条重复消息");
	assert.deepEqual(logs.map((meta) => meta.result), ["tool_result", "tool_result"]);
});

test("澄清提问：过期记录在新建提问时清掉（没人点的提问不会一直留在内存里）", () => {
	let now = 1_000;
	const { store, audits } = makeStore({ ttlMs: 1_000, now: () => now });
	const first = store.create(request({ conversationKey: "oc_a#ou_user" }));
	assert.equal(store.pendingCount(), 1);

	now = 2_500; // 第一条已过期
	store.create(request({ conversationKey: "oc_b#ou_user" }));
	assert.equal(store.pendingCount(), 1, "过期的旧提问应被清掉，只剩新的");
	assert.ok(audits.some((event) => event.decision === "expired"), "清理要留审计");
	assert.equal(click(store, first).ok, false, "旧卡依然点不了");
});

test("澄清提问（新版）：一卡多题走表单，选项是平铺复选框，提交一次回传", () => {
	const { store } = makeStore();
	const record = store.create({
		conversationKey: "oc:u:ou", chatId: "oc_g", chatType: "group",
		questions: [
			{ question: "需要包含哪些字段？", options: ["产品名称", "价格区间", "库存状态"], multiSelect: true },
			{ question: "处理范围？", options: ["仅当前聊天", "群内最近 7 天"] },
		],
	});
	store.attachCard(record.id, "om_card");
	const card = buildClarificationCard(record) as { body: { elements: Array<Record<string, unknown>> } };
	const json = JSON.stringify(card);
	assert.match(json, /"tag":"collapsible_panel"/, "每题一个折叠面板");
	assert.match(json, /"tag":"checker"/, "多选题是平铺复选框");
	assert.ok(!json.includes("select_static") && !json.includes("multi_select_static"), "不用下拉：长选项在下拉里很难看");
	assert.equal((json.match(/"tag":"checker"/g) ?? []).length, 5, "单选 2 个 + 多选 3 个，全是平铺复选框");
	assert.match(json, /"name":"q1__opt0"/, "复选框按位置命名，服务端据此还原选项");
	assert.equal((json.match(/"tag":"hr"/g) ?? []).length, 1, "两题之间一条分割线");
	assert.match(json, /"form_action_type":"submit"/);
	assert.match(json, /"form_action_type":"reset"/, "带一个重置按钮（客户端本地清空，不花后端）");
	assert.equal((json.match(/"tag":"input"/g) ?? []).length, 2, "每道题都带一个自填框");
	assert.match(json, /（单选 · 只勾一个）/, "单选题标题要说明只能勾一个");

	// 按位置回传勾选结果
	const decided = store.decideForm({
		messageId: "om_card", chatId: "oc_g", operatorOpenId: "ou_user",
		values: { q1__opt0: true, q1__opt2: true, q2__opt1: true },
	});
	assert.equal(decided.ok, true);
	assert.deepEqual(decided.answers, [
		{ question: "需要包含哪些字段？", choices: ["产品名称", "库存状态"] },
		{ question: "处理范围？", choices: ["群内最近 7 天"] },
	]);
	assert.equal(store.pendingCount(), 0, "提交后卡片消费掉");
});

test("澄清提问（新版）：漏答/单选勾了多个/自填都按规则校验，被拒时不消费卡片", () => {
	let now = 0;
	const { store } = makeStore({ now: () => now });
	const record = store.create({
		conversationKey: "oc:u:ou", chatId: "oc_g", chatType: "group",
		questions: [
			{ question: "范围？", options: ["A", "B"] },
			{ question: "补充", options: ["无", "仅冒烟"] },
		],
	});
	store.attachCard(record.id, "om_card");
	const submit = (values: Record<string, unknown>) => store.decideForm({ messageId: "om_card", chatId: "oc_g", operatorOpenId: "ou_user", values });

	assert.equal(submit({ q1__opt0: true }).reason.includes("还有问题没作答"), true, "第二题漏答要拒绝");
	const tooMany = submit({ q1__opt0: true, q1__opt1: true, q2__opt0: true });
	assert.equal(tooMany.reason.includes("只能选一个"), true);
	assert.match(tooMany.reason, /现在勾了 2 个（A、B）/, "要说清勾了哪几个，toast 只闪一下");
	assert.equal(store.pendingCount(), 1, "被拒后卡片仍可继续作答");

	const ok = submit({ q1__other: "自定义范围", q2__other: " 只跑冒烟 " });
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.answers?.[0], { question: "范围？", choices: [], other: "自定义范围" }, "可以只自填不选");
	assert.deepEqual(ok.answers?.[1], { question: "补充", choices: [], other: "只跑冒烟" }, "每题都有自填框");
	assert.equal(store.pendingCount(), 0);
	now = 0;
});

test("澄清提问（新版）：panels=false 时平铺（老客户端没有折叠面板）", () => {
	const { store } = makeStore();
	const record = store.create({
		conversationKey: "oc:u:ou", chatId: "oc_g", chatType: "group", panels: false,
		questions: [{ question: "范围？", options: ["A", "B"] }, { question: "格式？", options: ["表格", "文档"] }],
	});
	const json = JSON.stringify(buildClarificationCard(record));
	assert.ok(!json.includes("collapsible_panel"), "不能出现折叠面板");
	assert.match(json, /"tag":"checker"/, "复选框保留");
});

test("澄清表单提交：整卡作答进会话、卡片变结果；被拒时不消费也不改卡", async () => {
	const { BridgeRuntime } = await import("../src/runtime/bridge-runtime.js");
	const { DEFAULT_CONFIG } = await import("../src/types.js");
	const { clarifyCardOps } = await import("../src/interaction/card-ops.js");
	const rt = new BridgeRuntime();
	rt.config = { ...DEFAULT_CONFIG, allowChats: ["oc_chat"] };
	rt.clarificationStore = new ClarificationStore();
	const routed: string[] = [];
	rt.convManager = { route: async (msg: { text: string }) => { routed.push(msg.text); return "queued"; } } as never;
	const logs: string[] = [];
	const log = { info(event: string) { logs.push(event); }, warn() {}, error() {} };
	const ops = clarifyCardOps({ rt, log, admins: () => [], runCommand: async () => undefined });
	const submit = ops.clarify_submit as (action: unknown, value: Record<string, unknown>) => { toast?: { type: string; content: string }; card?: unknown };
	const record = rt.clarificationStore.create({
		conversationKey: "oc_chat", chatId: "oc_chat", chatType: "group",
		questions: [
			{ question: "需要包含哪些字段？", options: ["产品名称", "价格库存"], multiSelect: true },
			{ question: "处理范围？", options: ["仅当前聊天", "群内最近 7 天"] },
		],
	});
	rt.clarificationStore.attachCard(record.id, "om_card");
	const action = { messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_user", token: "tok", formValue: {} };

	// 单选勾了两个 → 拒绝，卡片不消费
	const rejected = submit({ ...action, formValue: { q1__opt0: true, q2__opt0: true, q2__opt1: true } }, { op: "clarify_submit", clarificationId: record.id, token: record.token });
	assert.equal(rejected.toast?.type, "warning");
	assert.equal(rejected.card, undefined, "被拒不回结果卡");
	assert.equal(rt.clarificationStore.pendingCount(), 1, "还能继续作答");

	const ok = submit({ ...action, formValue: { q1__opt0: true, q1__opt1: true, q2__opt1: true } }, { op: "clarify_submit", clarificationId: record.id, token: record.token });
	assert.equal(ok.toast?.type, "success");
	assert.ok(ok.card, "提交后卡片变成结果卡");
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(routed, ["[选择] 共 2 题\n- 需要包含哪些字段：产品名称、价格库存\n- 处理范围：群内最近 7 天\n（以上是用户对提问的作答）"]);
	assert.ok(logs.includes("feishu.clarify.form_submit"), "提交要留痕（排障时能看到平台回传了哪些字段）");
	assert.equal(rt.clarificationStore.pendingCount(), 0);
});

test("澄清提问（新版）：推荐的选项打 ⭐，理由写在题目下面", () => {
	const { store } = makeStore();
	const record = store.create({
		conversationKey: "oc:u:ou", chatId: "oc_g", chatType: "group",
		questions: [{
			question: "输出成什么格式？", options: ["Markdown 表格", "飞书文档", "多维表格"],
			multiSelect: true, recommended: [0], reason: "群里直接看，表格最快",
		}],
	});
	const json = JSON.stringify(buildClarificationCard(record));
	assert.match(json, /⭐ Markdown 表格（推荐）/, "推荐项要打标");
	assert.ok(!json.includes("⭐ 飞书文档"), "只标推荐的");
	assert.match(json, /群里直接看，表格最快/, "理由要显示出来");
});

test("澄清表单提交：飞书不回传按钮 value 时，按卡片消息 id 认领并正常作答", async () => {
	const { CardRouter } = await import("../src/interaction/card-router.js");
	const { BridgeRuntime } = await import("../src/runtime/bridge-runtime.js");
	const { DEFAULT_CONFIG } = await import("../src/types.js");
	const { clarifyCardOps } = await import("../src/interaction/card-ops.js");
	const rt = new BridgeRuntime();
	rt.config = { ...DEFAULT_CONFIG, allowChats: ["oc_chat"] };
	rt.clarificationStore = new ClarificationStore();
	const routed: string[] = [];
	rt.convManager = { route: async (msg: { text: string }) => { routed.push(msg.text); return "queued"; } } as never;
	const log = { info() {}, warn() {}, error() {} };
	const record = rt.clarificationStore.create({
		conversationKey: "oc_chat", chatId: "oc_chat", chatType: "group",
		questions: [{ question: "范围？", options: ["仅当前聊天", "群内最近 7 天"] }],
	});
	rt.clarificationStore.attachCard(record.id, "om_card");
	const router = new CardRouter({
		log, admins: () => [],
		// 真机行为：表单提交的 value 为空，只有 formValue；靠这张卡属于哪个提问来认领
		fallbackOp: (action) => (action.formValue && rt.clarificationStore?.findByMessage(action.messageId) ? "clarify_submit" : undefined),
	}).register("clarify", clarifyCardOps({ rt, log, admins: () => [], runCommand: async () => undefined }));

	const result = await router.handle({
		messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_user", token: "tok-1",
		formValue: { q1__opt1: true },
	}) as { toast?: { type: string } } | undefined;
	assert.equal(result?.toast?.type, "success", "没有 op 也要认领成功");
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(routed.length, 1);
	assert.match(routed[0]!, /群内最近 7 天/);
	assert.equal(rt.clarificationStore.pendingCount(), 0);
});

test("澄清提问（新版）：单题多选也走表单卡（单题形态的顶层参数不能丢）", () => {
	const { store } = makeStore();
	const record = store.create({ conversationKey: "oc:u:ou", chatId: "oc_g", chatType: "group", question: "覆盖哪些？", options: ["登录", "下单"], multiSelect: true });
	const json = JSON.stringify(buildClarificationCard(record));
	assert.match(json, /"tag":"checker"/, "多选要有复选框");
	assert.match(json, /"tag":"form"/, "要有提交按钮");
	assert.match(json, /（多选）/, "标题要标多选");
	assert.ok(!json.includes('"op":"clarify"'), "不能再降级成点一下即答的按钮卡");
});

test("澄清提问（新版）：单题单选 + allowOther 走表单（可自填、可反悔）", () => {
	const { store } = makeStore();
	const record = store.create({
		conversationKey: "oc:u:ou", chatId: "oc_g", chatType: "group",
		question: "用哪个方案？", options: ["方案 A", "方案 B"], allowOther: true, recommended: [1], reason: "B 少改三处",
	});
	const json = JSON.stringify(buildClarificationCard(record));
	assert.match(json, /"tag":"form"/, "要能提交（可反悔）");
	assert.match(json, /"tag":"input"/, "要有自填框");
	assert.match(json, /⭐ 方案 B（推荐）/, "推荐项要打标");
	assert.match(json, /B 少改三处/, "理由要显示");
	assert.ok(!json.includes('"op":"clarify"'), "不能再是点一下即答的按钮卡");
});

test("澄清提问（新版）：文字回退也带推荐标记与理由（没有卡片权限时同样能决策）", () => {
	const { store } = makeStore();
	const record = store.create({
		conversationKey: "oc:u:ou", chatId: "oc_g", chatType: "group",
		question: "用哪个方案？", options: ["方案 A", "方案 B"], recommended: [1], reason: "B 少改三处",
	});
	const text = clarificationTextFallback(record);
	assert.match(text, /2\. ⭐ 方案 B（推荐）/);
	assert.match(text, /1\. 方案 A\n/, "没推荐的选项保持原样");
	assert.match(text, /💡 B 少改三处/);
});

test("作答后的卡片：原地变只读，保留题目与全部选项（不换成摘要）", async () => {
	const { store } = makeStore();
	const record = store.create({
		conversationKey: "oc:u:ou", chatId: "oc", chatType: "group", question: "需要包含哪些字段？",
		options: ["产品名称", "价格区间", "库存状态"], multiSelect: true,
	});
	store.attachCard(record.id, "om_card");
	const decided = store.decideForm({
		id: record.id, token: record.token, messageId: "om_card", chatId: "oc",
		operatorOpenId: "ou_x", values: { q1__opt0: true, q1__other: "还要 SKU" },
	});
	assert.equal(decided.ok, true);
	const card = JSON.stringify(answeredCardFor(decided.record!, decided.answers!, "ou_x"));
	assert.match(card, /已作答/);
	for (const option of ["产品名称", "价格区间", "库存状态"]) assert.ok(card.includes(option), `没选的选项也要留着：${option}`);
	assert.match(card, /"checked":true/);
	assert.match(card, /"disabled":true/, "复选框要禁用（只读）");
	assert.match(card, /其他：还要 SKU/, "自填内容要留在卡上");
	assert.doesNotMatch(card, /form_action_type/, "只读卡不该还有提交按钮");
});

test("勾选式单选（radio）：单题单选改成复选框，勾一个就回调作答", () => {
	const { store } = makeStore();
	const record = store.create({
		conversationKey: "oc:u:ou", chatId: "oc_g", chatType: "group", radio: true,
		question: "目标环境？", options: ["测试", "预发", "正式"], recommended: [2], reason: "已验证",
	});
	assert.equal(record.radio, true, "radio 要落进记录（重新读盘后还能画出同样的卡）");
	const json = JSON.stringify(buildClarificationCard(record));
	assert.match(json, /"tag":"checker"/, "选项是复选框");
	assert.equal((json.match(/"tag":"button"/g) ?? []).length, 0, "没有按钮：勾一个即答");
	assert.match(json, /"op":"clarify"/, "勾选带回调（和按钮卡同一条路径）");
	assert.match(json, /⭐ 正式（推荐）/, "推荐标记保留");
	assert.doesNotMatch(json, /form_action_type/, "不进表单");
});
