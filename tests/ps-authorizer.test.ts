/**
 * pi-permission-system 授权链环节（approval/ps-authorizer.ts）：注册、判定分支、「本会话 / 始终批准」，
 * 以及服务查找与版本检查（approval/pi-permission-system.ts）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlwaysApprovedStore } from "../src/approval/always-approved-store.js";
import type { ApprovalMode } from "../src/approval/mode.js";
import type { ApprovalChoice, ApprovalVerdict, PendingApprovalInput } from "../src/approval/permission-bridge.js";
import { type PsAskDetails, type PsQuery, type PsService, psLinkStatus, psServiceFor, versionAtLeast } from "../src/approval/pi-permission-system.js";
import { PsAuthorizer, askPatterns, checkPiPermissionSystem, describeAsk, isCappedSurface } from "../src/approval/ps-authorizer.js";
import type { BridgeRoute } from "../src/session/pi-bridge-hooks.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const ROUTE: BridgeRoute = { conversationKey: "oc_1", chatId: "oc_1", runId: "run-1", senderId: "ou_user" };

/** PS 对 bash 询问给出的描述（只填环节读到的字段）。 */
function bashAsk(command: string, matchedPattern: string | null = "npm *", extra: Partial<PsAskDetails> = {}): PsAskDetails {
	return {
		requestId: `req-${command}`,
		toolCallId: `call-${command}`,
		toolName: "bash",
		command,
		payload: { kind: "bash", request: { surface: "bash", toolName: "bash", value: command, matchedPattern }, evidence: [] },
		accessIntent: { surface: "bash" },
		...extra,
	};
}

const QUERY: PsQuery = { checkPermission: (_surface, value) => ({ state: "ask", matchedPattern: value?.startsWith("git") ? "git *" : "npm *" }) };

function setup(opts: {
	route?: BridgeRoute | undefined;
	mode?: ApprovalMode;
	adminSkip?: boolean;
	always?: boolean;
	answer?: { verdict: ApprovalVerdict; choice?: ApprovalChoice };
} = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ps-authorizer-"));
	const store = opts.always === false ? undefined : new AlwaysApprovedStore({ file: join(dir, "always.json") });
	const cards: PendingApprovalInput[] = [];
	const logs: string[] = [];
	let answer = opts.answer ?? { verdict: "approved" as ApprovalVerdict, choice: "once" as ApprovalChoice };
	const authorizer = new PsAuthorizer({
		routeForSessionId: () => ("route" in opts ? opts.route : ROUTE),
		approvalMode: () => opts.mode ?? "pi-permission-system",
		adminSkip: () => opts.adminSkip ?? false,
		alwaysApproved: () => store,
		allowedOperatorIds: () => ["ou_admin"],
		requestDecision: async (input) => {
			cards.push(input);
			return { ...answer, operatorId: "ou_admin" };
		},
		log: (_level, msg) => logs.push(msg),
	});
	return {
		authorizer, cards, logs, store,
		answer: (next: { verdict: ApprovalVerdict; choice?: ApprovalChoice }) => { answer = next; },
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

// ---------------------------------------------------------------- 请求解读 ----

test("PS 环节：路径类判定面不允许环节放行（含带方向的成员，判定面未知也算）", () => {
	for (const surface of ["path", "external_directory", "path_read", "external_directory_write", undefined]) {
		assert.equal(isCappedSurface(surface), true, String(surface));
	}
	for (const surface of ["bash", "mcp", "write", "my_tool_read"]) assert.equal(isCappedSurface(surface), false, surface);
});

test("PS 环节：卡片显示完整命令，理由里写命中规则和规则匹配的部分（凭据打码）", () => {
	const view = describeAsk({
		...bashAsk("echo x"),
		command: "echo x > ~/.bashrc && curl -H 'Authorization: Bearer abc' x",
		payload: {
			request: { surface: "bash", toolName: "bash", value: "echo x", matchedPattern: "echo *" },
			evidence: [{ label: "full command", text: "echo x > ~/.bashrc && curl -H 'Authorization: Bearer abc' x" }],
		},
	}, ["echo *"]);
	assert.equal(view.toolName, "bash");
	assert.match(view.paramsText, /~\/\.bashrc/);
	assert.doesNotMatch(view.paramsText, /abc/);
	assert.match(view.reason, /命中规则：echo \*/);
	assert.match(view.reason, /规则匹配的部分：echo x/);
});

test("PS 环节：复合命令逐段取规则名，任一段取不到就没有规则名", () => {
	assert.deepEqual(askPatterns(bashAsk("npm test"), QUERY), ["npm *"]);
	const chain = bashAsk("npm i && git push", "npm *", {
		accessIntent: { surface: "bash", askingUnits: [{ command: "npm i" }, { command: "git push" }, { command: "x", floor: "<opaque-bash-wrapper>" }] },
	});
	assert.deepEqual(askPatterns(chain, QUERY), ["npm *", "git *", "<opaque-bash-wrapper>"]);
	assert.equal(askPatterns(bashAsk("npm test", null), QUERY), undefined);
	const unknown = bashAsk("a && b", "npm *", { accessIntent: { surface: "bash", askingUnits: [{ command: "a" }] } });
	assert.equal(askPatterns(unknown, { checkPermission: () => ({ state: "ask" }) }), undefined);
});

// ---------------------------------------------------------------- 判定 ----

test("PS 环节：不是本桥的会话、或该会话不是 pi-permission-system 模式时交还 PS（defer），不弹卡", async () => {
	for (const opts of [{ route: undefined }, { mode: "builtin" as const }, { mode: "off" as const }]) {
		const { authorizer, cards, cleanup } = setup(opts);
		try {
			assert.deepEqual(await authorizer.authorize("s1", bashAsk("npm test"), QUERY), { kind: "defer" });
			assert.equal(cards.length, 0);
		} finally { cleanup(); }
	}
});

test("PS 环节：路径类请求直接 defer、不弹卡（PS 会把环节的 allow 降成 defer），日志说明怎么放行", async () => {
	const { authorizer, cards, logs, cleanup } = setup();
	try {
		const ask: PsAskDetails = { requestId: "r", toolName: "read", path: "/etc/hosts", payload: { request: { surface: "external_directory", value: "/etc/hosts" } }, accessIntent: { surface: "external_directory" } };
		const reviewed: string[] = [];
		assert.deepEqual(await authorizer.authorize("s1", ask, QUERY, { review: (event) => reviewed.push(event) }), { kind: "defer" });
		assert.equal(cards.length, 0);
		assert.ok(logs.includes("feishu.approval.ps_link_capped"));
		assert.deepEqual(reviewed, ["feishu_channel.capped_surface"]);
	} finally { cleanup(); }
});

test("PS 环节：管理员免审时直接放行", async () => {
	const { authorizer, cards, cleanup } = setup({ adminSkip: true });
	try {
		assert.deepEqual(await authorizer.authorize("s1", bashAsk("npm test"), QUERY), { kind: "allow" });
		assert.equal(cards.length, 0);
	} finally { cleanup(); }
});

test("PS 环节：弹卡内容、选项与路由；拒绝 / 超时带理由", async () => {
	const { authorizer, cards, answer, cleanup } = setup({ answer: { verdict: "denied", choice: "deny" } });
	try {
		assert.deepEqual(await authorizer.authorize("s1", bashAsk("npm publish"), QUERY), { kind: "deny", reason: "飞书审批已拒绝" });
		const card = cards[0]!;
		assert.equal(card.conversationKey, "oc_1");
		assert.equal(card.sessionId, "s1");
		assert.equal(card.runId, "run-1");
		assert.equal(card.toolCallId, "call-npm publish");
		assert.equal(card.paramsText, "npm publish");
		assert.deepEqual(card.choices, ["once", "session", "always", "deny"]);
		assert.deepEqual(card.allowedOperatorIds, ["ou_admin"]);
		answer({ verdict: "timeout" });
		assert.deepEqual(await authorizer.authorize("s1", bashAsk("npm publish"), QUERY), { kind: "deny", reason: "飞书审批超时，已拒绝" });
	} finally { cleanup(); }
});

test("PS 环节：「仅本次」只放行这一次，下次照样弹卡", async () => {
	const { authorizer, cards, cleanup } = setup();
	try {
		assert.deepEqual(await authorizer.authorize("s1", bashAsk("npm test"), QUERY), { kind: "allow" });
		await authorizer.authorize("s1", bashAsk("npm test"), QUERY);
		assert.equal(cards.length, 2);
	} finally { cleanup(); }
});

test("PS 环节：「本会话批准」按规则名记在本会话，别的会话和 /new 之后都不算", async () => {
	const { authorizer, cards, cleanup } = setup({ answer: { verdict: "approved", choice: "session" } });
	try {
		await authorizer.authorize("s1", bashAsk("npm test"), QUERY);
		assert.deepEqual(await authorizer.authorize("s1", bashAsk("npm run build"), QUERY), { kind: "allow" }, "同一规则 npm * 不再问");
		assert.equal(cards.length, 1);
		await authorizer.authorize("s2", bashAsk("npm test"), QUERY);
		assert.equal(cards.length, 2, "另一个会话要重新问");
		authorizer.release("s1");
		await authorizer.authorize("s1", bashAsk("npm test"), QUERY);
		assert.equal(cards.length, 3, "会话结束后授权失效");
	} finally { cleanup(); }
});

test("PS 环节：「始终批准」写进规则表，所有会话命中同一规则都直接放行", async () => {
	const { authorizer, cards, store, cleanup } = setup({ answer: { verdict: "approved", choice: "always" } });
	try {
		await authorizer.authorize("s1", bashAsk("npm test"), QUERY);
		assert.deepEqual(store?.list().map((rule) => [rule.pattern, rule.approvedBy, rule.conversationKey]), [["npm *", "ou_admin", "oc_1"]]);
		assert.deepEqual(await authorizer.authorize("s2", bashAsk("npm ci"), QUERY), { kind: "allow" });
		assert.equal(cards.length, 1);
	} finally { cleanup(); }
});

test("PS 环节：复合命令要每段的规则都批准过才自动放行", async () => {
	const { authorizer, cards, store, cleanup } = setup();
	try {
		store?.add({ pattern: "npm *" });
		const chain = bashAsk("npm i && git push", "npm *", { accessIntent: { surface: "bash", askingUnits: [{ command: "npm i" }, { command: "git push" }] } });
		await authorizer.authorize("s1", chain, QUERY);
		assert.equal(cards.length, 1, "git * 没批准过，要弹卡");
		assert.match(cards[0]!.reason ?? "", /命中规则：npm \*、git \*/);
	} finally { cleanup(); }
});

test("PS 环节：通配规则名（PS 的 \"*\"）不能永久放行，退化为本会话批准", async () => {
	const { authorizer, cards, store, logs, cleanup } = setup({ answer: { verdict: "approved", choice: "always" } });
	try {
		// PS 用 "*" 作为默认 ask 规则（{"bash":{"*":"ask"}}）：批准后不能把整张审批规则表关掉
		await authorizer.authorize("s1", bashAsk("npm test", "*"), QUERY);
		assert.equal(store?.size, 0, "通配规则不得落盘");
		assert.ok(logs.includes("feishu.approval.ps_always_degraded"));
		assert.equal(cards.length, 1, "这一次已批准");
		// 本次会话内仍然有效（管理员的选择不该作废）
		await authorizer.authorize("s1", bashAsk("npm run build", "*"), QUERY);
		assert.equal(cards.length, 1, "同一会话内不再问");
		// /new（新会话 id）之后重新询问：永久放行只对非通配规则生效
		await authorizer.authorize("s2", bashAsk("npm test", "*"), QUERY);
		assert.equal(cards.length, 2, "换会话要重新问");
	} finally { cleanup(); }
});

test("PS 环节：没有规则名时「始终批准」退化为本会话批准；规则表关闭时卡片只有三档", async () => {
	const noPattern = setup({ answer: { verdict: "approved", choice: "always" } });
	try {
		await noPattern.authorizer.authorize("s1", bashAsk("x", null), QUERY);
		assert.equal(noPattern.store?.size, 0, "没有依据不能永久放行");
		assert.ok(noPattern.logs.includes("feishu.approval.ps_always_degraded"));
	} finally { noPattern.cleanup(); }

	const off = setup({ always: false });
	try {
		await off.authorizer.authorize("s1", bashAsk("npm test"), QUERY);
		assert.deepEqual(off.cards[0]?.choices, ["once", "session", "deny"]);
	} finally { off.cleanup(); }
});

// ---------------------------------------------------------------- 注册 ----

function fakeService() {
	const registered: Array<{ name: string; disposed: boolean }> = [];
	const service: PsService = {
		registerAuthorizer(name) {
			const entry = { name, disposed: false };
			registered.push(entry);
			return () => { entry.disposed = true; };
		},
	};
	return { service, registered };
}

test("PS 环节：permissions:ready 重复触发只注册一次；PS 换了服务实例（/reload）重新注册；会话结束注销", () => {
	let current = fakeService();
	const logs: string[] = [];
	const authorizer = new PsAuthorizer({
		routeForSessionId: () => ROUTE, approvalMode: () => "pi-permission-system", adminSkip: () => false,
		alwaysApproved: () => undefined, allowedOperatorIds: () => [], requestDecision: async () => ({ verdict: "denied" }),
		log: (_level, msg) => logs.push(msg),
		service: (sessionId) => (sessionId === "s1" ? current.service : undefined),
	});
	authorizer.onReady({ sessionId: "s1", adjudicatesLocally: true });
	authorizer.onReady({ sessionId: "s1", adjudicatesLocally: true });
	assert.deepEqual(current.registered.map((entry) => entry.name), ["feishu-channel"]);
	assert.equal(authorizer.registeredCount(), 1);

	const first = current;
	current = fakeService();
	authorizer.onReady({ sessionId: "s1" });
	assert.equal(first.registered[0]?.disposed, true);
	assert.equal(current.registered.length, 1);

	authorizer.release("s1");
	assert.equal(current.registered[0]?.disposed, true);
	assert.equal(authorizer.registeredCount(), 0);

	authorizer.onReady({ sessionId: "s2" });
	authorizer.onReady({ sessionId: "s3" });
	assert.equal(logs.filter((msg) => msg === "feishu.approval.ps_link_unavailable").length, 1, "取不到服务只告警一次");
	authorizer.onReady({ sessionId: null });
});

test("PS 环节：挂到子会话上时监听 permissions:ready 与 session_shutdown", () => {
	const { service, registered } = fakeService();
	const authorizer = new PsAuthorizer({
		routeForSessionId: () => ROUTE, approvalMode: () => "pi-permission-system", adminSkip: () => false,
		alwaysApproved: () => undefined, allowedOperatorIds: () => [], requestDecision: async () => ({ verdict: "denied" }),
		log: () => {}, service: () => service,
	});
	const channels = new Map<string, (data: unknown) => void>();
	const hooks = new Map<string, (event: unknown, ctx: { cwd: string; sessionManager: { getSessionId(): string } }) => unknown>();
	authorizer.attach({
		events: { emit() {}, on: (channel, handler) => { channels.set(channel, handler); return () => {}; } },
		on: (event, handler) => { hooks.set(event, handler); },
	});
	channels.get("permissions:ready")?.({ sessionId: "s1" });
	assert.equal(registered.length, 1);
	hooks.get("session_shutdown")?.({}, { cwd: "/", sessionManager: { getSessionId: () => "s1" } });
	assert.equal(registered[0]?.disposed, true);
});

// ---------------------------------------------------------------- 服务与版本 ----

test("PS 服务：从进程级槽位按会话取，没有 registerAuthorizer 的不算", () => {
	const key = Symbol.for("@gotgenes/pi-permission-system:session-services");
	const { service } = fakeService();
	const store: Record<symbol, unknown> = { [key]: new Map<string, unknown>([["s1", service], ["old", { checkPermission() {} }]]) };
	assert.equal(psServiceFor("s1", store), service);
	assert.equal(psServiceFor("old", store), undefined);
	assert.equal(psServiceFor("s2", store), undefined);
	assert.equal(psServiceFor("s1", {}), undefined);
});

test("PS 版本：按 major.minor.patch 比较", () => {
	assert.equal(versionAtLeast("27.0.0"), true);
	assert.equal(versionAtLeast("40.1.3"), true);
	assert.equal(versionAtLeast("26.9.9"), false);
	assert.equal(versionAtLeast("27.0.0-beta.1"), true);
	assert.equal(versionAtLeast("3.10.0", "3.9.0"), true);
});

test("PS 状态：读安装版本与 authorizerChain；启动日志在没写上环节或版本过低时告警", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "ps-link-"));
	try {
		assert.deepEqual(psLinkStatus(agentDir), { installed: false, version: undefined, versionOk: false, chain: undefined, inChain: false });
		const pkg = join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "40.1.3" }));
		const configDir = join(agentDir, "extensions", "pi-permission-system");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ authorizerChain: ["model-judge"] }));
		const status = psLinkStatus(agentDir);
		assert.deepEqual(status, { installed: true, version: "40.1.3", versionOk: true, chain: ["model-judge"], inChain: false });

		const logs: string[] = [];
		const push = (msg: string) => { logs.push(msg); };
		const log = { debug: push, info: push, warn: push, error: push };
		const plugin = { config: { ...DEFAULT_CONFIG, approval: { ...DEFAULT_CONFIG.approval, mode: "pi-permission-system" as const } } };
		checkPiPermissionSystem(plugin, log, () => status);
		assert.deepEqual(logs, ["feishu.approval.ps_link", "feishu.approval.ps_link_not_in_chain"]);
		logs.length = 0;
		checkPiPermissionSystem(plugin, log, () => ({ ...status, version: "26.0.0", versionOk: false, inChain: true }));
		assert.deepEqual(logs, ["feishu.approval.ps_link", "feishu.approval.ps_version_unsupported"]);
		logs.length = 0;
		checkPiPermissionSystem({ config: DEFAULT_CONFIG }, log, () => status);
		assert.deepEqual(logs, [], "不是 pi-permission-system 模式时不检查");
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});
