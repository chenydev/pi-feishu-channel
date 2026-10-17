import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionBridge, classifyToolCall, redactParams, type PendingApproval } from "../src/approval/permission-bridge.js";
import { holdEventLoop } from "./hold-event-loop.js";

function input(toolCallId = "tc1") {
	return { conversationKey: "oc:u:ou", sessionId: "sid", runId: toolCallId, toolCallId, toolName: "bash", paramsText: "{\"command\":\"git status\"}", chatId: "oc", sourceMessageId: "om", allowedOperatorIds: ["ou_admin", "admin"] };
}

test("审批：非管理员/跨群/token 错误不能消费，一次批准原子放行", async () => {
	let pendingId = "";
	let token = "";
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (pending) => { pendingId = pending.id; token = pending.token; return "card-1"; },
	});
	const gate = await bridge.gate(input());
	assert.equal(gate.decision, "ask");
	assert.equal(bridge.decide({ id: pendingId, token, messageId: "card-1", chatId: "oc", operatorOpenId: "ou_bad", choice: "once" }).ok, false);
	assert.equal(bridge.decide({ id: pendingId, token, messageId: "card-1", chatId: "other", operatorOpenId: "ou_admin", choice: "once" }).ok, false);
	assert.equal(bridge.pendingCount(), 1);
	assert.equal(bridge.decide({ id: pendingId, token, messageId: "card-1", chatId: "oc", operatorOpenId: "ou_admin", choice: "once" }).ok, true);
	assert.equal(await gate.verdict, "approved");
	assert.equal(bridge.pendingCount(), 0);
	assert.equal(bridge.decide({ id: pendingId, token, messageId: "card-1", chatId: "oc", operatorOpenId: "ou_admin", choice: "once" }).ok, false);
});

test("审批：session 仅当前 conversation 生效，always 回写全局", async () => {
	const always: string[] = [];
	let pending: { id: string; token: string } = { id: "", token: "" };
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (value) => { pending = value; return `card-${value.toolCallId}`; },
		onAlwaysAllow: (tool) => { always.push(tool); },
	});
	let gate = await bridge.gate(input("session-1"));
	bridge.decide({ id: pending.id, token: pending.token, messageId: "card-session-1", chatId: "oc", operatorOpenId: "admin", choice: "session" });
	assert.equal(await gate.verdict, "approved");
	assert.equal((await bridge.gate(input("session-2"))).decision, "allow");
	gate = await bridge.gate({ ...input("other"), conversationKey: "other" });
	assert.equal(gate.decision, "ask");
	bridge.decide({ id: pending.id, token: pending.token, messageId: "card-other", chatId: "oc", operatorOpenId: "admin", choice: "always" });
	assert.equal(await gate.verdict, "approved");
	assert.deepEqual(always, ["bash"]);
});

test("审批：超时默认拒绝，敏感参数审计脱敏", async () => {
	const bridge = new PermissionBridge({ getConfig: () => ({ autoApprove: [], timeoutMs: 5 }), onAsk: async () => "card" });
	const gate = await bridge.gate(input());
	assert.equal(await gate.verdict, "timeout");
	assert.equal(redactParams({ token: "abc", password: "p", command: "ok" }), "{\"token\":\"***\",\"password\":\"***\",\"command\":\"ok\"}");
});

test("审批：卡片发送挂起时仍按 TTL 返回 timeout", async () => {
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 5 }),
		onAsk: async () => new Promise<string>(() => {}),
	});
	const gate = await bridge.gate(input("hung-card"));
	assert.equal(await holdEventLoop(async () => gate.verdict), "timeout");
	assert.equal(bridge.pendingCount(), 0);
});

test("审批：重置会话使旧卡失效，本地文件外发默认需要审批", async () => {
	let pending: { id: string; token: string } | undefined;
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (value) => { pending = value; return "old-card"; },
	});
	const gate = await bridge.gate(input("old-run"));
	bridge.resetSession("oc:u:ou");
	assert.equal(await gate.verdict, "denied");
	assert.equal(bridge.decide({ id: pending!.id, token: pending!.token, messageId: "old-card", chatId: "oc", operatorOpenId: "admin", choice: "once" }).ok, false);
	assert.equal(classifyToolCall("feishu_send_local_file", [], new Set()), "ask");
	assert.equal(classifyToolCall("feishu_ask", [], new Set()), "allow", "提问本身就在等人回答，不再审批");
	assert.equal(redactParams({ command: "API_TOKEN=secret curl -H 'Authorization: Bearer abc'" }).includes("secret"), false);
	assert.equal(redactParams({ command: "API_TOKEN=secret curl -H 'Authorization: Bearer abc'" }).includes("abc"), false);
});

test("审批：审计记录包含 run/tool/card/operator 关联字段", async () => {
	const audits: Array<Record<string, unknown>> = [];
	let pending: { id: string; token: string } | undefined;
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (value) => { pending = value; return "audit-card"; },
		onAudit: (event) => audits.push(event),
	});
	const gate = await bridge.gate(input("audit-tool-call"));
	bridge.decide({ id: pending!.id, token: pending!.token, messageId: "audit-card", chatId: "oc", operatorOpenId: "admin", choice: "once" });
	assert.equal(await gate.verdict, "approved");
	const final = audits.at(-1);
	assert.equal(final?.runId, "audit-tool-call");
	assert.equal(final?.toolCallId, "audit-tool-call");
	assert.equal(final?.cardMessageId, "audit-card");
	assert.equal(final?.operatorOpenId, "admin");
});

test("外部审批源（PS 授权链）：选项可以收窄，且选择要带回给调用方", async () => {
	let pending: { id: string; token: string; choices?: string[] } | undefined;
	const audits: Array<Record<string, unknown>> = [];
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (value) => { pending = value; return "fwd-card"; },
		onAudit: (event) => audits.push(event),
	});
	const work = bridge.requestExternal({
		conversationKey: "oc:u:ou_admin", sessionId: "sess-child", runId: "run-child",
		toolCallId: "req-1", toolName: "bash", paramsText: "echo hi", chatId: "oc",
		allowedOperatorIds: ["ou_admin"], choices: ["once", "session", "deny"],
	});
	assert.deepEqual(pending?.choices, ["once", "session", "deny"], "选项必须被收窄");
	assert.equal(bridge.pendingCount(), 1);
	// 等卡片结果落位（cardMessageId 是 decide 的上下文校验项之一）
	await new Promise((resolve) => setTimeout(resolve, 0));

	// 不给的选项必须被拒，且不消费审批（卡片回调可被重放，白名单要在消费之前校验）
	const rejected = bridge.decide({
		id: pending!.id, token: pending!.token, messageId: "fwd-card", chatId: "oc",
		operatorOpenId: "ou_admin", choice: "always",
	});
	assert.equal(rejected.ok, false);
	assert.match(rejected.reason, /不支持此选项/);
	assert.equal(bridge.pendingCount(), 1);

	assert.equal(bridge.decide({
		id: pending!.id, token: pending!.token, messageId: "fwd-card", chatId: "oc",
		operatorOpenId: "ou_admin", choice: "session",
	}).ok, true);
	const result = await work;
	assert.equal(result.verdict, "approved");
	assert.equal(result.choice, "session", "调用方要靠它区分「仅本次」与「本会话」");
	assert.equal(audits[0]?.decision, "external_ask", "外部来源在审计里可区分（PS 授权链传 ps_ask）");
	assert.deepEqual(bridge.sessionAllowList("oc:u:ou_admin"), [], "外部来源的「本会话批准」由它自己记，不进桥的会话授权");
});

test("外部审批源：「始终批准」不把工具名写进 autoApprove（否则切回内置审批后该工具全部免审）", async () => {
	let pending: { id: string; token: string } | undefined;
	const persisted: string[] = [];
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (value) => { pending = value; return "ps-card"; },
		onAlwaysAllow: (toolName) => { persisted.push(toolName); return true; },
	});
	const work = bridge.requestExternal({
		conversationKey: "oc", sessionId: "s", runId: "r", toolCallId: "req-always",
		toolName: "bash", paramsText: "npm test", chatId: "oc", allowedOperatorIds: ["ou_admin"],
		choices: ["once", "session", "always", "deny"],
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(bridge.decide({ id: pending!.id, token: pending!.token, messageId: "ps-card", chatId: "oc", operatorOpenId: "ou_admin", choice: "always" }).ok, true);
	const result = await work;
	assert.equal(result.choice, "always");
	assert.deepEqual(persisted, []);
	assert.deepEqual(bridge.sessionAllowList("oc"), []);
});

test("外部审批源：卡片发送失败按拒绝收尾（与自研路径一致）", async () => {
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async () => undefined,
	});
	const result = await bridge.requestExternal({
		conversationKey: "oc:u:ou_admin", sessionId: "s", runId: "r", toolCallId: "req-2",
		toolName: "bash", paramsText: "echo hi", chatId: "oc", allowedOperatorIds: ["ou_admin"],
		choices: ["once", "deny"],
	});
	assert.equal(result.verdict, "denied");
	assert.equal(bridge.pendingCount(), 0);
});

test("外部审批源：审批卡等待上限可以单独指定", async () => {
	const bridge = new PermissionBridge({ getConfig: () => ({ autoApprove: [], timeoutMs: 60_000 }), onAsk: async () => "card" });
	const result = await holdEventLoop(() => bridge.requestExternal({
		conversationKey: "oc:u:ou_admin", sessionId: "s", runId: "r", toolCallId: "req-3",
		toolName: "bash", paramsText: "echo hi", chatId: "oc", allowedOperatorIds: ["ou_admin"],
		choices: ["once", "deny"],
	}, { timeoutMs: 5 }));
	assert.equal(result.verdict, "timeout", "用 5ms 上限而不是全局的 60s");
});

test("审批合并与提醒：同一 run 的同类请求并到一张卡，旧卡 token 失效，点一次一并放行", async () => {
	const asked: string[] = [];
	const refreshed: number[] = [];
	let leader: { id: string; token: string; followers?: unknown[] } = { id: "", token: "" };
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 60_000 }),
		onAsk: async (pending) => { asked.push(pending.toolCallId); leader = pending; return "card-1"; },
		onCardRefresh: (pending) => { refreshed.push(pending.followers?.length ?? 0); },
	});
	const run = (toolCallId: string) => ({ ...input(toolCallId), runId: "run-1" });
	const first = await bridge.gate(run("a"));
	const staleToken = leader.token;
	const second = await bridge.gate(run("b"));
	assert.deepEqual(asked, ["a"], "第二个请求不再弹卡");
	assert.deepEqual(refreshed, [1]);
	assert.equal(bridge.decide({ id: leader.id, token: staleToken, messageId: "card-1", chatId: "oc", operatorOpenId: "admin", choice: "once" }).ok, false, "旧卡不能批新请求");
	assert.equal(bridge.decide({ id: leader.id, token: leader.token, messageId: "card-1", chatId: "oc", operatorOpenId: "admin", choice: "once" }).ok, true);
	assert.equal(await first.verdict, "approved");
	assert.equal(await second.verdict, "approved");
	assert.equal(bridge.pendingCount(), 0);
});

test("审批合并：重绘卡片失败时撤销合并，两个请求各弹一张卡（不留点不动的卡）", async () => {
	const asked: string[] = [];
	const pendings: PendingApproval[] = [];
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 60_000 }),
		onAsk: async (pending) => { asked.push(pending.toolCallId); pendings.push(pending); return `card-${pending.toolCallId}`; },
		// 重绘失败（网络抖动 / 编辑配额用尽）
		onCardRefresh: () => false,
	});
	const run = (toolCallId: string) => ({ ...input(toolCallId), runId: "run-1" });
	const first = await bridge.gate(run("a"));
	const firstToken = pendings[0]!.token;
	const second = await bridge.gate(run("b"));
	assert.deepEqual(asked, ["a", "b"], "重绘失败不能再合并：各弹一张卡");
	assert.equal(pendings[0]!.token, firstToken, "主卡 token 必须还原，否则屏幕上那张卡点不动");
	assert.equal(bridge.pendingCount(), 2);
	assert.equal(bridge.decide({ id: pendings[0]!.id, token: firstToken, messageId: "card-a", chatId: "oc", operatorOpenId: "admin", choice: "once" }).ok, true);
	assert.equal(await first.verdict, "approved");
	assert.equal(bridge.decide({ id: pendings[1]!.id, token: pendings[1]!.token, messageId: "card-b", chatId: "oc", operatorOpenId: "admin", choice: "once" }).ok, true);
	assert.equal(await second.verdict, "approved");
	assert.equal(bridge.pendingCount(), 0);
});

test("审批合并与提醒：主卡失效时跟随者一并拒绝；不同 run 不合并", async () => {
	const asked: string[] = [];
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 60_000 }),
		onAsk: async (pending) => { asked.push(pending.toolCallId); return `card-${pending.toolCallId}`; },
	});
	const a = await bridge.gate({ ...input("a"), runId: "run-1" });
	const b = await bridge.gate({ ...input("b"), runId: "run-1" });
	await bridge.gate({ ...input("c"), runId: "run-2" });
	assert.deepEqual(asked, ["a", "c"]);
	bridge.cancelRun("oc:u:ou", "run-1");
	assert.equal(await a.verdict, "denied");
	assert.equal(await b.verdict, "denied");
	assert.equal(bridge.pendingCount(), 1);
});

test("审批合并与提醒：超时前 1 分钟提醒一次", async () => {
	const reminded: string[] = [];
	let now = 0;
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 100_000 }),
		onAsk: async () => "card",
		onReminder: (pending) => reminded.push(pending.toolCallId),
		now: () => now,
	});
	const original = globalThis.setTimeout;
	const scheduled: Array<{ fn: () => void; ms: number }> = [];
	globalThis.setTimeout = ((fn: () => void, ms: number) => { scheduled.push({ fn, ms }); return { unref() {} } as never; }) as never;
	try {
		await bridge.gate(input("r"));
	} finally {
		globalThis.setTimeout = original;
	}
	const reminder = scheduled.find((item) => item.ms === 40_000);
	assert.ok(reminder, "提醒定时器 = timeout - 60s");
	now = 40_000;
	reminder.fn();
	assert.deepEqual(reminded, ["r"]);
	assert.equal(bridge.oldestPendingAgeMs(), 40_000);
});
