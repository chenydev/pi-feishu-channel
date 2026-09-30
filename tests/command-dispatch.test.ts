/**
 * 命令分发（commands/dispatch.ts）与各组处理函数（commands/handlers/）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandConflictError, CommandDispatcher, type CommandReplier } from "../src/commands/dispatch.js";
import { adminCommands } from "../src/commands/handlers/admin.js";
import { infoCommands } from "../src/commands/handlers/info.js";
import { modelCommands } from "../src/commands/handlers/model.js";
import { sessionCommands } from "../src/commands/handlers/session.js";
import type { CommandServices } from "../src/commands/handlers/services.js";
import { COMMANDS } from "../src/commands/registry.js";
import type { ConversationManager } from "../src/session/conversation-manager.js";
import { BridgeRuntime } from "../src/runtime/bridge-runtime.js";
import type { UsageProvider } from "../src/outbound/usage-provider.js";
import { DEFAULT_CONFIG, type FeishuInboundMessage } from "../src/types.js";

function setup(opts: { cardOk?: boolean; convManager?: Partial<ConversationManager> } = {}) {
	const home = mkdtempSync(join(tmpdir(), "cmd-dispatch-"));
	const rt = new BridgeRuntime();
	rt.homeDir = home;
	rt.config = structuredClone({ ...DEFAULT_CONFIG, admins: ["ou_admin"] });
	if (opts.convManager) rt.convManager = opts.convManager as ConversationManager;
	const logs: Array<{ msg: string; meta: unknown }> = [];
	const push = (msg: string, meta?: unknown) => { logs.push({ msg, meta }); };
	const log = { debug: push, info: push, warn: push, error: push };
	const replies: string[] = [];
	const cards: string[] = [];
	const replier = (): CommandReplier => ({
		reply: (text) => { replies.push(text); },
		trySendCard: async (_card, what) => { cards.push(what); return opts.cardOk ?? false; },
	});
	const svc: CommandServices = {
		rt, log,
		piCommands: () => [{ name: "review", source: "prompt" }],
		statusText: () => "STATUS",
		diagnosticsContext: () => ({}) as ReturnType<CommandServices["diagnosticsContext"]>,
		usageProvider: () => ({}) as UsageProvider,
	};
	const dispatcher = new CommandDispatcher({ log, isAdmin: (msg) => rt.config.admins.includes(msg.senderId), replier, piCommands: svc.piCommands })
		.register("info", infoCommands(svc))
		.register("admin", adminCommands(svc))
		.register("session", sessionCommands(svc))
		.register("model", modelCommands(svc));
	const send = (text: string, over: Partial<FeishuInboundMessage> = {}) => dispatcher.dispatch({
		messageId: "om_1", chatId: "oc_g", chatType: "group", senderId: "ou_user", isBot: false, msgType: "text",
		text, mentions: [], resources: [], raw: undefined, ts: Date.now(), ...over,
	} as FeishuInboundMessage);
	const savedConfig = () => JSON.parse(readFileSync(join(home, "feishu-channel", "config.json"), "utf8"));
	return { rt, dispatcher, send, replies, cards, logs, savedConfig, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("命令分发：注册表里的命令除 /cron（随定时任务能力登记）外都有处理函数", () => {
	const { dispatcher, cleanup } = setup();
	try {
		const handled = new Set(Object.keys(dispatcher.commands()));
		const missing = COMMANDS.map((spec) => spec.name).filter((name) => !handled.has(name));
		assert.deepEqual(missing, ["/cron"]);
	} finally { cleanup(); }
});

test("命令分发：登记注册表外的命令名、重复登记同一命令都在启动时报错", () => {
	const { dispatcher, logs, cleanup } = setup();
	try {
		assert.throws(() => dispatcher.register("x", { "/nope": () => undefined }), /不在注册表里/);
		assert.throws(() => dispatcher.register("x", { "/new": () => undefined }), (error: unknown) => error instanceof CommandConflictError && error.owners[0] === "session");
		assert.ok(logs.some((l) => l.msg === "feishu.command.handler_conflict"));
	} finally { cleanup(); }
});

test("命令分发：普通消息不处理；打错的命令给纠错提示；pi 自己的命令不误伤", async () => {
	const { send, replies, cleanup } = setup();
	try {
		assert.equal(await send("你好"), false);
		assert.equal(await send("/hlep"), true);
		assert.match(replies[0], /是否想用 \/help/);
		assert.equal(await send("/review"), false, "pi 的命令交给会话");
	} finally { cleanup(); }
});

test("命令分发：别名解析到规范名并记录 feishu.command", async () => {
	const { send, replies, logs, cleanup } = setup({ convManager: { stopConversation: async () => false } as Partial<ConversationManager> });
	try {
		await send("/stop");
		assert.equal(replies[0], "当前没有正在执行的任务");
		await send("/h");
		assert.ok(logs.filter((l) => l.msg === "feishu.command").map((l) => (l.meta as { command: string }).command).includes("/help"));
	} finally { cleanup(); }
});

test("命令分发：拦截器先于命令解析", async () => {
	const { dispatcher, send, replies, cleanup } = setup();
	try {
		dispatcher.intercept("bang", (msg) => { if (!msg.text.startsWith("!")) return false; replies.push("intercepted"); return true; });
		assert.equal(await send("!ls"), true);
		assert.deepEqual(replies, ["intercepted"]);
	} finally { cleanup(); }
});

test("查看类命令：/help 卡片发送失败时退回文本", async () => {
	const { send, replies, cards, cleanup } = setup({ cardOk: false });
	try {
		await send("/help");
		assert.deepEqual(cards, ["help"]);
		assert.match(replies[0], /\/new/);
	} finally { cleanup(); }
});

test("管理类命令：群策略只有管理员能改，改动写入配置文件；私聊里不能改", async () => {
	const { send, replies, rt, savedConfig, cleanup } = setup();
	try {
		await send("/feishu policy admin_only");
		assert.equal(replies.at(-1), "仅管理员或应用归属人可修改群策略");
		await send("/feishu policy admin_only", { chatType: "p2p", senderId: "ou_admin" });
		assert.equal(replies.at(-1), "群策略只能在群聊或话题中修改");
		await send("/feishu policy bogus", { senderId: "ou_admin" });
		assert.match(replies.at(-1) ?? "", /^用法/);
		await send("/feishu policy admin_only", { senderId: "ou_admin" });
		assert.equal(replies.at(-1), "已设置本群策略：admin_only");
		assert.equal(rt.config.groupPolicyByChat.oc_g, "admin_only");
		assert.equal(savedConfig().groupPolicyByChat.oc_g, "admin_only");
	} finally { cleanup(); }
});

test("管理类命令：费用上限的设置与取消", async () => {
	const { send, replies, rt, cleanup } = setup({ convManager: { budgetStatus: () => ({ spent: 0, limit: undefined }) } as unknown as Partial<ConversationManager> });
	try {
		await send("/feishu budget 5");
		assert.equal(replies.at(-1), "仅管理员或应用归属人可设置费用上限");
		await send("/feishu budget -1", { senderId: "ou_admin" });
		assert.match(replies.at(-1) ?? "", /^用法/);
		await send("/feishu budget 5", { senderId: "ou_admin" });
		assert.equal(rt.config.groupRules.oc_g?.dailyBudgetUsd, 5);
		await send("/feishu budget off", { senderId: "ou_admin" });
		assert.equal(rt.config.groupRules.oc_g?.dailyBudgetUsd, undefined);
	} finally { cleanup(); }
});

test("管理类命令：私聊改个人提示词不需要管理员，群提示词需要", async () => {
	const { send, replies, rt, cleanup } = setup();
	try {
		await send("/feishu prompt set 用中文回答", { chatType: "p2p" });
		assert.equal(rt.config.userPrompts?.ou_user, "用中文回答");
		await send("/feishu prompt set 群设定");
		assert.equal(replies.at(-1), "仅管理员或应用归属人可修改本群提示词");
	} finally { cleanup(); }
});

test("会话类命令：多人共用的会话导出需要非管理员确认", async () => {
	const exported: string[] = [];
	const { send, replies, rt, cleanup } = setup({ convManager: { exportConversation: async (_m: unknown, f: string) => { exported.push(f); return "ok"; } } as unknown as Partial<ConversationManager> });
	try {
		rt.config.groupSessionsPerUser = false; // 群里所有人共用一个会话
		await send("/export md");
		assert.match(replies.at(-1) ?? "", /确认导出请发送 \/export md confirm/);
		await send("/export md confirm");
		await send("/export md", { chatType: "p2p", chatId: "oc_dm" });
		assert.deepEqual(exported, ["md", "md"]);
	} finally { cleanup(); }
});

test("模型类命令：/model -g 对非管理员只提示需要管理员", async () => {
	const { send, replies, cleanup } = setup({ convManager: { commands: { modelConversation: async () => "已切换模型：p/m" } } as unknown as Partial<ConversationManager> });
	try {
		await send("/model p/m -g");
		assert.equal(replies.at(-1), "已切换模型：p/m\n（--global/-g 需要管理员或应用归属人）");
	} finally { cleanup(); }
});
