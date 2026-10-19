/**
 * 桥侧内联扩展：注入子会话的 tool_call 审批 gate 与文件工具，
 * 以及从子会话扩展发现中剔除网关扩展（避免重复启动飞书 WS）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createBridgeInlineExtension,
	PACKAGE_ROOT,
	stripGatewayExtensions,
	type BridgeGateInput,
	type BridgeHookContext,
	type BridgeRoute,
} from "../src/session/pi-bridge-hooks.js";
import type { ExtensionAPI } from "../src/pi-types.js";
import { PiSessionBackend } from "../src/session/pi-session-backend.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const tools: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) {
			tools.push(tool);
		},
		registerCommand() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { api, tools, handlers };
}

function fakeCtx(route: BridgeRoute | undefined) {
	const calls = { gated: [] as BridgeGateInput[], marked: [] as string[], sent: [] as Record<string, unknown>[] };
	const ctx: BridgeHookContext = {
		gateToolCall: async (input) => {
			calls.gated.push(input);
			return input.toolName === "bash" ? { block: true, reason: "blocked-by-test" } : undefined;
		},
		markToolBoundary: (sessionId) => { calls.marked.push(sessionId); },
		routeForSessionId: () => route,
		sendLocalFile: async (input) => {
			calls.sent.push(input as unknown as Record<string, unknown>);
			return { content: [{ type: "text", text: "sent" }] };
		},
		allowedOperatorIds: () => ["ou_admin"],
		redactParams: () => "[redacted]",
	};
	return { ctx, calls };
}

const RUNTIME = { cwd: "/workspace", sessionManager: { getSessionId: () => "sess-1" } };
const ROUTE: BridgeRoute = {
	conversationKey: "oc_group:u:ou_user",
	chatId: "oc_group",
	threadId: "om_thread",
	sourceMessageId: "om_src",
	runId: "run-1",
	senderId: "ou_user",
};

test("子会话钩子：内联扩展注册 tool_call hook 与文件工具", () => {
	const { api, tools, handlers } = fakePi();
	const { ctx } = fakeCtx(ROUTE);
	createBridgeInlineExtension(ctx)(api);

assert.deepEqual(tools.map((tool) => tool.name), ["feishu_send_local_file", "feishu_notify", "feishu_ask"], "新增澄清提问与会话内通知工具");
	assert.equal(handlers.get("tool_call")?.length, 1);
});

test("子会话钩子：tool_call 在有路由时经审批 gate，并原样返回阻断结果", async () => {
	const { api, handlers } = fakePi();
	const { ctx, calls } = fakeCtx(ROUTE);
	createBridgeInlineExtension(ctx)(api);
	const handler = handlers.get("tool_call")![0];

	const blocked = await handler({ toolCallId: "tc1", toolName: "bash", input: { command: "rm -rf /" } }, RUNTIME);
	assert.deepEqual(blocked, { block: true, reason: "blocked-by-test" });
	assert.equal(calls.gated.length, 1);
	assert.deepEqual(calls.gated[0], {
		conversationKey: "oc_group:u:ou_user",
		sessionId: "sess-1",
		runId: "run-1",
		toolCallId: "tc1",
		toolName: "bash",
		paramsText: "[redacted]",
		command: "rm -rf /",
		chatId: "oc_group",
		threadId: "om_thread",
		sourceMessageId: "om_src",
		senderId: "ou_user",
		allowedOperatorIds: ["ou_admin"],
	});
	assert.deepEqual(calls.marked, ["sess-1"], "工具边界必须先标记（pending replayPolicy=manual）");

	const allowed = await handler({ toolCallId: "tc2", toolName: "read", input: {} }, RUNTIME);
	assert.equal(allowed, undefined);
	assert.equal(calls.gated.length, 2);
});

test("子会话钩子：无路由的会话不拦截（不越权管其他工具的调用）", async () => {
	const { api, handlers } = fakePi();
	const { ctx, calls } = fakeCtx(undefined);
	createBridgeInlineExtension(ctx)(api);
	const handler = handlers.get("tool_call")![0];

	const result = await handler({ toolCallId: "tc9", toolName: "bash", input: {} }, RUNTIME);
	assert.equal(result, undefined);
	assert.equal(calls.gated.length, 0);
	assert.equal(calls.marked.length, 0);
});

test("子会话钩子：缺少 toolCallId/toolName 的事件直接放行", async () => {
	const { api, handlers } = fakePi();
	const { ctx, calls } = fakeCtx(ROUTE);
	createBridgeInlineExtension(ctx)(api);
	const handler = handlers.get("tool_call")![0];

	assert.equal(await handler({ toolName: "bash" }, RUNTIME), undefined);
	assert.equal(await handler({ toolCallId: "tc" }, RUNTIME), undefined);
	assert.equal(calls.gated.length, 0);
});

test("子会话钩子：文件工具把当前路由与 cwd 交给 outer 发送链路", async () => {
	const { api, tools } = fakePi();
	const { ctx, calls } = fakeCtx(ROUTE);
	createBridgeInlineExtension(ctx)(api);
	const tool = tools[0];

	const result = await tool.execute("tc-file", { path: "out/report.pdf", caption: "报表" }, undefined, undefined, RUNTIME);
	assert.deepEqual(result, { content: [{ type: "text", text: "sent" }] });
	assert.equal(calls.sent.length, 1);
	assert.deepEqual(calls.sent[0], {
		toolCallId: "tc-file",
		path: "out/report.pdf",
		caption: "报表",
		cwd: "/workspace",
		route: ROUTE,
	});
});

test("子会话钩子：stripGatewayExtensions 剔除网关扩展且不误伤其他扩展", () => {
	const gateways = [
		{ path: "/workspace/pi-agent/npm/node_modules/pi-feishu-bridge/src/index.ts", resolvedPath: "/x/pi-feishu-bridge/src/index.ts" },
		{ path: "/workspace/pi-agent/npm/node_modules/@tunglam/pi-lark-cli/src/index.ts", resolvedPath: "/x/pi-lark-cli/src/index.ts" },
		{ path: "/workspace/some-other/bridge.ts", resolvedPath: "/x/bridge.ts" },
	];
	const result = stripGatewayExtensions({ extensions: gateways });
	assert.equal(result.extensions.length, 2, "只应剔除 pi-feishu-bridge 自身");
	assert.ok(!result.extensions.some((e) => e.path?.includes("pi-feishu-bridge")));
	assert.ok(result.extensions.some((e) => e.path?.includes("pi-lark-cli")), "其他扩展必须保留");

	// 更名后的路径同样被剔除
	const renamed = stripGatewayExtensions({ extensions: [{ path: "/home/u/.pi/agent/git/github.com/chenydev/pi-feishu-channel/src/index.ts" }, ...gateways.slice(1)] });
	assert.equal(renamed.extensions.length, 2, "新名字 pi-feishu-channel 也必须被识别为网关扩展");

	// 自定义标记
	const custom = stripGatewayExtensions({ extensions: gateways }, ["some-other"]);
	assert.equal(custom.extensions.length, 2);
	assert.ok(!custom.extensions.some((e) => e.path?.includes("some-other")));
});

test("子会话钩子：stripGatewayExtensions 无匹配时原样返回（不复制对象）", () => {
	const input = { extensions: [{ path: "/a/pi-lark-cli/index.ts" }] };
	assert.equal(stripGatewayExtensions(input), input);
});

test("内联扩展注册压缩与终局事件（用户侧可见性）", () => {
	const registered: string[] = [];
	const fakePi = {
		registerTool: () => {},
		on: (name: string) => { registered.push(name); },
	} as never;
	const ctx = {
		gateToolCall: async () => undefined,
		markToolBoundary: () => {},
		routeForSessionId: () => undefined,
		sendLocalFile: async () => ({ ok: true }),
		allowedOperatorIds: () => [],
		redactParams: () => "",
	} as never;
	createBridgeInlineExtension(ctx)(fakePi);
	// 压缩期间 Pi 不产出任何事件，不显式告知用户就只看到"莫名卡住"
	assert.ok(registered.includes("session_before_compact"), "必须订阅压缩开始");
	assert.ok(registered.includes("session_compact"), "必须订阅压缩结束");
	assert.ok(registered.includes("session_compact_failed"), "压缩失败也要说明");
	// agent_end 之后 Pi 可能继续 auto-retry/compact/follow-up，只有 agent_settled 是终局
	assert.ok(registered.includes("agent_settled"), "必须订阅终局信号");
	assert.ok(registered.includes("tool_call"), "原有的工具审批检查不能丢");
});

test("子会话钩子：gate 输入带上完整的原始 bash 命令（不截断、不打码），供命令分级使用", async () => {
	const { api, handlers } = fakePi();
	const { ctx, calls } = fakeCtx(ROUTE);
	createBridgeInlineExtension(ctx)(api);
	const handler = handlers.get("tool_call")![0];
	const command = `${"echo ok; ".repeat(200)}TOKEN=abc rm -rf /`;
	await handler({ toolCallId: "tc1", toolName: "bash", input: { command } }, RUNTIME);
	assert.equal(calls.gated[0].command, command);
	await handler({ toolCallId: "tc2", toolName: "read", input: { command: "x" } }, RUNTIME);
	assert.equal(calls.gated[1].command, undefined, "非 bash 工具不带 command");
});

test("子会话钩子：按包根目录识别桥自身，与安装目录名无关；前缀相同的其他目录不误伤", () => {
	const root = mkdtempSync(join(tmpdir(), "any-name-"));
	try {
		mkdirSync(join(root, "src"));
		const extensions = [
			{ path: join(root, "src", "index.ts") },
			{ path: `${root}-sibling/src/index.ts` },
			{ path: "/opt/pi/extensions/other/index.ts" },
		];
		const result = stripGatewayExtensions({ extensions }, [], [root]);
		assert.deepEqual(result.extensions.map((e) => e.path), [`${root}-sibling/src/index.ts`, "/opt/pi/extensions/other/index.ts"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("子会话钩子：通过软链接加载的桥自身也能识别", () => {
	const root = mkdtempSync(join(tmpdir(), "real-"));
	const link = `${root}-link`;
	try {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "index.ts"), "");
		symlinkSync(root, link);
		const result = stripGatewayExtensions({ extensions: [{ path: join(link, "src", "index.ts") }] }, [], [root]);
		assert.equal(result.extensions.length, 0);
	} finally { rmSync(link, { force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("子会话钩子：默认包根目录就是本仓库", () => {
	assert.ok(existsSync(join(PACKAGE_ROOT, "package.json")));
	assert.equal(stripGatewayExtensions({ extensions: [{ path: join(PACKAGE_ROOT, "src", "index.ts") }] }, []).extensions.length, 0);
});

test("子会话会话后端：resource_loader_ready 记录剔除的网关扩展数", async () => {
	const logs: Array<{ msg: string; meta: unknown }> = [];
	const backend = new PiSessionBackend({ sessionDir: tmpdir(), log: (_level, msg, meta) => { logs.push({ msg, meta }); } });
	class FakeLoader {
		constructor(private readonly options: { extensionsOverride?: (base: unknown) => unknown }) {}
		async reload() {
			this.options.extensionsOverride?.({ extensions: [{ path: join(PACKAGE_ROOT, "src", "index.ts") }, { path: "/opt/other/index.ts" }] });
		}
	}
	const sdk = { DefaultResourceLoader: FakeLoader, getAgentDir: () => tmpdir() };
	await (backend as unknown as { buildResourceLoader(sdk: unknown, cwd: string): Promise<unknown> }).buildResourceLoader(sdk, "/");
	const ready = logs.find((l) => l.msg === "feishu.session.resource_loader_ready");
	assert.equal((ready?.meta as { strippedGateways?: number })?.strippedGateways, 1);
});

test("桥侧内联扩展：每个子会话都挂上 pi-permission-system 授权链环节", () => {
	const { api } = fakePi();
	const { ctx } = fakeCtx(ROUTE);
	const attached: ExtensionAPI[] = [];
	createBridgeInlineExtension({ ...ctx, attachPermissions: (pi) => { attached.push(pi); } })(api);
	assert.deepEqual(attached, [api]);
});

test("子会话钩子：feishu_ask 发出提问就返回并结束本轮（terminate），不等待选择", async () => {
	const { api, tools } = fakePi();
	const { ctx } = fakeCtx(ROUTE);
	const asked: unknown[] = [];
	ctx.askChoice = async (input) => { asked.push(input); return { status: "card" }; };
	createBridgeInlineExtension(ctx)(api);
	const ask = tools.find((tool) => tool.name === "feishu_ask")!;
	const result = await ask.execute("tc-1", { question: "选哪个？", options: ["A", "B"] }, undefined, undefined, RUNTIME) as { terminate?: boolean; isError?: boolean; content: Array<{ text: string }> };
	assert.equal(result.terminate, true);
	assert.ok(!result.isError);
	assert.match(result.content[0].text, /本轮到此结束/);
	assert.equal((asked[0] as { route: BridgeRoute }).route.senderId, "ou_user", "带上发起人");

	// 等到答案：当作普通工具结果，同一轮继续（不 terminate）
	ctx.askChoice = async () => ({ status: "answered", text: "[选择] A\n（回答你的提问：选哪个？）" });
	const answered = await ask.execute("tc-3", { question: "选哪个？", options: ["A", "B"] }, undefined, undefined, RUNTIME) as { terminate?: boolean; isError?: boolean; content: Array<{ text: string }> };
	assert.equal(answered.terminate, undefined, "拿到答案就继续，不结束本轮");
	assert.match(answered.content[0].text, /用户已作答[\s\S]*\[选择\] A/);

	// 超时：不替用户选择，明确让模型不要假设答案
	ctx.askChoice = async () => ({ status: "pending", waitedMs: 60_000 });
	const pending = await ask.execute("tc-4", { question: "选哪个？", options: ["A", "B"] }, undefined, undefined, RUNTIME) as { content: Array<{ text: string }> };
	assert.match(pending.content[0].text, /还没作答（已等 60 秒）/);
	assert.match(pending.content[0].text, /不要重复提问，也不要假设答案/);

	// 用户没答、去说别的事：不是错误，让模型按那条新消息继续
	ctx.askChoice = async () => ({ status: "skipped" });
	const skipped = await ask.execute("tc-7", { question: "选哪个？", options: ["A", "B"] }, undefined, undefined, RUNTIME) as { isError?: boolean; terminate?: boolean; content: Array<{ text: string }> };
	assert.deepEqual([skipped.isError, skipped.terminate], [undefined, undefined]);
	assert.match(skipped.content[0].text, /没有作答[\s\S]*按用户的新消息继续/);

	// 其它失效原因（/new 等）：不能再说成「超时」
	ctx.askChoice = async () => ({ status: "abandoned", detail: "提问已失效（conversation_reset）" });
	const abandoned = await ask.execute("tc-8", { question: "选哪个？", options: ["A", "B"] }, undefined, undefined, RUNTIME) as { content: Array<{ text: string }> };
	assert.doesNotMatch(abandoned.content[0].text, /超时/);

	// 中止：告诉模型别再发同样的提问
	ctx.askChoice = async () => ({ status: "cancelled" });
	const cancelled = await ask.execute("tc-5", { question: "选哪个？", options: ["A", "B"] }, undefined, undefined, RUNTIME) as { isError?: boolean; content: Array<{ text: string }> };
	assert.equal(cancelled.isError, true);
	assert.match(cancelled.content[0].text, /被中止/);

	// 参数透传：waitSeconds 交给桥去决定等多久
	ctx.askChoice = async (input) => { asked.push(input); return { status: "card" }; };
	await ask.execute("tc-6", { question: "选哪个？", options: ["A", "B"], waitSeconds: 5 }, undefined, undefined, RUNTIME);
	assert.equal((asked.at(-1) as { waitSeconds?: number }).waitSeconds, 5);

	ctx.askChoice = async () => ({ status: "unavailable", detail: "没有活动会话" });
	const failed = await ask.execute("tc-2", { question: "选哪个？", options: ["A", "B"] }, undefined, undefined, RUNTIME) as { terminate?: boolean; isError?: boolean };
	assert.deepEqual([failed.isError, failed.terminate], [true, undefined], "提问失败时不结束本轮，让模型改用文字");
});
