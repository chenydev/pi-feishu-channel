/**
 * 扩展入口的测试装置：用假 pi + 假飞书 SDK（底层是 FakeFeishu）+ 假会话后端，
 * 从 `feishuBridgeExtension` 入口把真实的 transport / 流水线 / 命令 / 卡片回调 / 审批检查整条跑起来。
 *
 * 用法：
 *   const h = await startHarness({ admins: ["ou_admin"] });
 *   await h.message({ chatId: "oc_dm", sender: "ou_user", text: "/feishu policy oc_x open" });
 *   await h.waitForText("oc_dm", /仅管理员/);
 *   await h.stop();
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import feishuBridgeExtension from "../../src/index.js";
import type { LarkSdkLike } from "../../src/inbound/transport.js";
import type { ExtensionAPI, ExtensionRuntimeContext } from "../../src/pi-types.js";
import type { SessionBackend } from "../../src/types.js";
import { FakeFeishu } from "./fake-feishu.js";

export const BOT_OPEN_ID = "ou_bot";

type Handler = (event: unknown, ctx: ExtensionRuntimeContext) => unknown | Promise<unknown>;

/** 最小的假 pi：记录注册的命令、事件与工具，并能按名字触发事件。 */
export class FakePi {
	readonly commands = new Map<string, { handler: (args: string, ctx: never, list: string[]) => string | Promise<string> }>();
	readonly handlers = new Map<string, Handler[]>();
	readonly statuses = new Map<string, string>();
	constructor(private agentDir: string) {}
	getAgentDir() { return this.agentDir; }
	getPackageDir() { return this.agentDir; }
	ui = {
		setStatus: (key: string, text: string) => { this.statuses.set(key, text); },
		notify: () => {},
	};
	on(event: string, handler: Handler) {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
	}
	registerTool() {}
	registerCommand(name: string, opts: { handler: (args: string, ctx: never, list: string[]) => string | Promise<string> }) {
		this.commands.set(name, opts);
	}
	appendEntry() {}
	getCommands() { return []; }
	/** 依次调用该事件的处理函数，返回最后一个非 undefined 的结果（pi 的 tool_call 语义）。 */
	async emit(event: string, payload: unknown = {}, ctx: Partial<ExtensionRuntimeContext> = {}): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			const value = await handler(payload, ctx as ExtensionRuntimeContext);
			if (value !== undefined) result = value;
		}
		return result;
	}
}

/** 一轮执行可以被测试「停住」的假会话：prompt() 在 release() 之前不返回。 */
export class HeldSessions {
	private waiting: Array<() => void> = [];
	readonly prompts: Array<{ conversationKey: string; text: string }> = [];
	sessionIdFor = (conversationKey: string) => `sid:${conversationKey}`;

	readonly backend: SessionBackend = {
		createSession: async ({ conversationKey }) => ({
			sessionId: this.sessionIdFor(conversationKey),
			prompt: async (text: string) => {
				this.prompts.push({ conversationKey, text });
				await new Promise<void>((resolve) => this.waiting.push(resolve));
				return `完成：${conversationKey}`;
			},
			subscribe: () => () => {},
			abort: async () => {},
			dispose: async () => {},
			modelId: "fake-model",
		}),
	};

	/** 放行所有停住的轮次。 */
	release(): void {
		for (const resolve of this.waiting.splice(0)) resolve();
	}
}

export interface LogLine { level: string; event: string; meta: unknown }

export interface Harness {
	home: string;
	fake: FakeFeishu;
	pi: FakePi;
	sessions: HeldSessions;
	logs: LogLine[];
	/** 投递一条入站文本消息（群消息默认 @ 机器人）。 */
	message(input: { chatId: string; sender: string; text: string; chatType?: "p2p" | "group"; mention?: boolean; id?: string }): Promise<string>;
	/** 模拟点击卡片按钮；返回回调给飞书的应答（toast / 新卡片）。 */
	click(input: { messageId: string; chatId: string; operator: string; value: Record<string, unknown>; token?: string }): Promise<unknown>;
	/** 发给某个会话的全部消息内容（文本与卡片 JSON 原文）。 */
	sent(chatId?: string): string[];
	/** 等到某个会话出现匹配的消息，返回该消息。 */
	waitForMessage(chatId: string | undefined, pattern: RegExp, timeoutMs?: number): Promise<{ id: string; chatId: string; content: string }>;
	/** 投递一个平台事件（事件名同 SDK 订阅名，如 `drive.notice.comment_add_v1`）。 */
	event(name: string, data: unknown): Promise<void>;
	/** 在所有已发出的卡片里找按钮值（深度搜索 `value` 对象）。 */
	buttonValues(filter: (value: Record<string, unknown>) => boolean): Array<{ messageId: string; chatId: string; value: Record<string, unknown> }>;
	config(): Record<string, unknown>;
	hasLog(event: string): boolean;
	stop(): Promise<void>;
}

async function waitUntil<T>(probe: () => T | undefined, timeoutMs = 3_000, label = "条件"): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function collectValues(node: unknown, out: Array<Record<string, unknown>>): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) { for (const item of node) collectValues(item, out); return; }
	const record = node as Record<string, unknown>;
	if (record.value && typeof record.value === "object" && !Array.isArray(record.value)) out.push(record.value as Record<string, unknown>);
	for (const child of Object.values(record)) collectValues(child, out);
}

/** 启动一个完整的扩展实例。`config` 写入 `<home>/feishu-channel/config.json`。 */
export async function startHarness(config: Record<string, unknown>): Promise<Harness> {
	const home = mkdtempSync(join(tmpdir(), "pi-feishu-channel-entry-"));
	mkdirSync(join(home, "feishu-channel"), { recursive: true });
	const configFile = join(home, "feishu-channel", "config.json");
	writeFileSync(configFile, JSON.stringify({ appId: "cli_test", appSecret: "secret", batch: { enabled: false }, ...config }, null, 2));
	for (const key of Object.keys(process.env)) if (key.startsWith("FEISHU_") || key.startsWith("LARK_")) delete process.env[key];
	process.env.FEISHU_CHANNEL_HOME = home;

	const fake = new FakeFeishu();
	const handlers: Record<string, (data: unknown) => unknown> = {};
	const request = async (opts: { url: string; method: string; params?: unknown; data?: unknown }) => {
		if (opts.url === "/open-apis/bot/v3/info") return { code: 0, bot: { open_id: BOT_OPEN_ID, app_name: "Bot", bot_name: "Bot" } };
		if (/^\/open-apis\/im\/v1\/chats\/[^/]+$/.test(opts.url)) return { code: 0, data: { name: "测试群" } };
		if (/^\/open-apis\/im\/v1\/chats\/[^/]+\/members$/.test(opts.url)) return { code: 0, data: { items: [], has_more: false } };
		if (/^\/open-apis\/contact\/v3\/users\//.test(opts.url)) return { code: 0, data: { user: { name: "某人" } } };
		if (/\/reactions/.test(opts.url)) return { code: 0, data: { reaction_id: "r1" } };
		return fake.rawRequest(opts);
	};
	class Client {
		im = { v1: {} };
		request = request;
	}
	class Dispatcher {
		register(next: Record<string, (data: unknown) => unknown>) { Object.assign(handlers, next); return this; }
	}
	class Ws {
		status = "idle";
		constructor(readonly opts: { onReady?: () => void }) {}
		start() { this.status = "connected"; this.opts.onReady?.(); }
		close() { this.status = "idle"; }
		getConnectionStatus() { return this.status; }
	}
	const larkSdk = { Domain: { Feishu: "feishu", Lark: "lark" }, Client, WSClient: Ws, EventDispatcher: Dispatcher } as unknown as LarkSdkLike;

	// 扩展日志走 console；收集结构化事件，便于断言「可观测信号」，也让测试输出保持安静
	const logs: LogLine[] = [];
	const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
	const capture = (level: string) => (first: unknown, meta?: unknown) => {
		const text = String(first ?? "");
		logs.push({ level, event: text.replace(/^\[feishu-channel\] /, ""), meta });
	};
	console.log = capture("info"); console.info = capture("info"); console.warn = capture("warn"); console.error = capture("error"); console.debug = capture("debug");

	const pi = new FakePi(home);
	const sessions = new HeldSessions();
	feishuBridgeExtension(pi as unknown as ExtensionAPI, { larkSdk, sessionBackend: sessions.backend });
	await pi.emit("session_start");
	await waitUntil(() => logs.some((line) => line.event === "bridge started"), 3_000, "bridge started");

	let seq = 0;
	const harness: Harness = {
		home, fake, pi, sessions, logs,
		async message({ chatId, sender, text, chatType = "p2p", mention = chatType === "group", id }) {
			const messageId = id ?? `om_in_${++seq}`;
			fake.messages.set(messageId, { id: messageId, chatId, msgType: "text", content: JSON.stringify({ text }), edits: 0, recalled: false });
			const body = mention ? `@_user_1 ${text}` : text;
			handlers["im.message.receive_v1"]?.({
				event: {
					sender: { sender_id: { open_id: sender }, sender_type: "user" },
					message: {
						message_id: messageId, chat_id: chatId, chat_type: chatType, message_type: "text",
						content: JSON.stringify({ text: body }),
						mentions: mention ? [{ key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "Bot" }] : [],
					},
				},
			});
			return messageId;
		},
		async click({ messageId, chatId, operator, value, token }) {
			return handlers["card.action.trigger"]?.({
				context: { open_message_id: messageId, open_chat_id: chatId },
				operator: { open_id: operator },
				action: { value },
				...(token ? { token } : {}),
			});
		},
		async event(name, data) {
			if (!handlers[name]) throw new Error(`没有订阅事件 ${name}`);
			await handlers[name](data);
			// 生命周期事件在后台串行处理：让出几轮事件循环，等它处理完
			for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		},
		sent(chatId) {
			return [...fake.messages.values()].filter((m) => !m.id.startsWith("om_in_") && (!chatId || m.chatId === chatId)).map((m) => m.content);
		},
		async waitForMessage(chatId, pattern, timeoutMs = 3_000) {
			return waitUntil(() => [...fake.messages.values()].find((m) =>
				!m.id.startsWith("om_in_") && (!chatId || m.chatId === chatId) && pattern.test(m.content)), timeoutMs, `消息 ${pattern}`);
		},
		buttonValues(filter) {
			const out: Array<{ messageId: string; chatId: string; value: Record<string, unknown> }> = [];
			for (const m of fake.messages.values()) {
				if (m.msgType !== "interactive") continue;
				const values: Array<Record<string, unknown>> = [];
				try { collectValues(JSON.parse(m.content), values); } catch { continue; }
				for (const value of values) if (filter(value)) out.push({ messageId: m.id, chatId: m.chatId, value });
			}
			return out;
		},
		config() { return JSON.parse(readFileSync(configFile, "utf8")); },
		hasLog(event) { return logs.some((line) => line.event === event); },
		async stop() {
			sessions.release();
			await pi.emit("session_shutdown");
			Object.assign(console, original);
			delete process.env.FEISHU_CHANNEL_HOME;
			rmSync(home, { recursive: true, force: true });
		},
	};
	return harness;
}
