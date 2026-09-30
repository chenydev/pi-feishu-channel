/** E/F 系列：队列、模型模糊匹配、重试/回退/分叉、导出、撤回取消、直接执行、预算、自动命名、长回答转文件。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationManager, matchModels, stripContextPrefix, transcriptMarkdown, type ConversationManagerDeps } from "../src/session/conversation-manager.js";
import { createReplyAsFile } from "../src/features/long-reply.js";
import { UsageLedger } from "../src/runtime/usage-ledger.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type SessionBackend } from "../src/types.js";

type Handle = Awaited<ReturnType<SessionBackend["createSession"]>>;

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		...DEFAULT_CONFIG,
		reaction: { ...DEFAULT_CONFIG.reaction, enabled: false },
		footer: { enabled: false, showCost: false },
		progress: { ...DEFAULT_CONFIG.progress, mode: "off" },
		...over,
	};
}

function message(messageId: string, text = `prompt-${messageId}`, over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
	return {
		messageId, chatId: "oc_chat", chatType: "p2p", senderId: "ou_user", isBot: false, msgType: "text",
		text, mentions: [], resources: [], raw: undefined, ts: Date.now(), ...over,
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("waitUntil timeout");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

interface Harness {
	manager: ConversationManager;
	sent: Array<{ text: string; opts?: { replyTo?: string } }>;
	durable: Array<{ text: string; dedupeKey: string; replyTo?: string }>;
	files: Array<{ path: string; dedupeKey: string; content: string }>;
	reactions: Array<{ op: "add" | "remove"; messageId: string; emoji?: string }>;
	prompts: string[];
	release: () => void;
	handle: Handle;
	dir: string;
}

function harness(opts: { config?: Partial<BridgeConfig>; handle?: Partial<Handle>; blockPrompt?: boolean; ledger?: UsageLedger; reply?: string } = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "conv-features-"));
	const sent: Harness["sent"] = [];
	const durable: Harness["durable"] = [];
	const files: Harness["files"] = [];
	const reactions: Harness["reactions"] = [];
	const prompts: string[] = [];
	let release: () => void = () => {};
	let listener: ((event: unknown) => void) | undefined;
	let name: string | undefined;
	const handle: Handle = {
		sessionId: "sid",
		async prompt(text) {
			prompts.push(text);
			if (opts.blockPrompt) await new Promise<void>((resolve) => { release = resolve; });
			listener?.({ type: "message_end", message: { role: "assistant", id: `a${prompts.length}`, content: opts.reply ?? `answer-${prompts.length}`, stopReason: "stop", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } }, model: "m" } });
			return undefined;
		},
		async steer() { throw new Error("no steer"); },
		subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
		async abort() { release(); },
		async dispose() {},
		modelId: "m",
		sessionName: () => name,
		setSessionName: (value: string) => { name = value; },
		...opts.handle,
	};
	const backend: SessionBackend = { async createSession() { return handle; } };
	const sendLocalFile: NonNullable<ConversationManagerDeps["sendLocalFile"]> = (_chatId, path, _o, meta) => { files.push({ path, dedupeKey: meta.dedupeKey, content: readFileSync(path, "utf8") }); return { ok: true }; };
	const manager = new ConversationManager({
		config: config(opts.config), sessionDir: dir, sessionBackend: backend,
		sender: { async send(_chatId: string, text: string, sendOpts?: { replyTo?: string }) { sent.push({ text, opts: sendOpts }); return { success: true, messageId: `om_${sent.length}` }; } } as never,
		durableOutbox: { enqueue(_chatId, text, sendOpts, meta) { durable.push({ text, dedupeKey: meta.dedupeKey, replyTo: sendOpts.replyTo }); return [`e${durable.length}`]; } },
		reactions: {
			async add(messageId, emoji) { reactions.push({ op: "add", messageId, emoji }); return `r-${messageId}`; },
			async remove(messageId) { reactions.push({ op: "remove", messageId }); return true; },
		},
		conversationFile: join(dir, "conversations.jsonl"),
		exportsDir: join(dir, "exports"),
		sendLocalFile,
		...(opts.config?.longReply?.asFile ? { replyAsFile: createReplyAsFile({ options: opts.config.longReply, exportsDir: join(dir, "exports"), sendLocalFile, log: () => {} }) } : {}),
		usageLedger: opts.ledger,
	});
	return { manager, sent, durable, files, reactions, prompts, release: () => release(), handle, dir };
}

test("模型匹配：模型模糊匹配 —— 精确 > 前缀 > 包含，多个命中时不猜", () => {
	const models = [
		{ id: "deepseek-chat", provider: "deepseek" },
		{ id: "deepseek-reasoner", provider: "deepseek" },
		{ id: "gemini-2.5-flash", provider: "google" },
		{ id: "gpt-5", provider: "openai" },
	];
	assert.deepEqual(matchModels(models, "flash").map((m) => m.id), ["gemini-2.5-flash"]);
	assert.deepEqual(matchModels(models, "deepseek").map((m) => m.id), ["deepseek-chat", "deepseek-reasoner"]);
	assert.deepEqual(matchModels(models, "openai/gpt-5").map((m) => m.id), ["gpt-5"]);
	assert.deepEqual(matchModels(models, "GPT").map((m) => m.id), ["gpt-5"]);
	assert.deepEqual(matchModels(models, "nothing"), []);
});

test("模型匹配：/model 片段唯一命中直接切换并记入最近使用；多个命中列候选", async () => {
	const switched: string[] = [];
	const h = harness({ handle: {
		async listModels() { return [{ id: "deepseek-chat", provider: "deepseek" }, { id: "deepseek-reasoner", provider: "deepseek" }, { id: "gemini-2.5-flash", provider: "google" }]; },
		async setModel(id: string) { switched.push(id); return true; },
	} });
	try {
		assert.equal(await h.manager.commands.modelConversation(message("m1"), "flash"), "已切换模型：google/gemini-2.5-flash（按「flash」匹配）");
		assert.deepEqual(switched, ["google/gemini-2.5-flash"]);
		const ambiguous = await h.manager.commands.modelConversation(message("m2"), "deepseek");
		assert.match(ambiguous, /匹配到 2 个模型/);
		assert.deepEqual(switched, ["google/gemini-2.5-flash"], "多个命中不切换");
		assert.deepEqual(h.manager.commands.recentModelLabels(), ["google/gemini-2.5-flash"]);
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("忙碌提示：/queue list 与 clear；忙碌时进队的普通消息提示排第几（10 秒内只提示一次）", async () => {
	const h = harness({ blockPrompt: true });
	try {
		await h.manager.route(message("m1"));
		await waitUntil(() => h.prompts.length === 1);
		await h.manager.route(message("m2", "第二个任务"));
		await h.manager.route(message("m3", "第三个任务"));
		const notices = h.durable.filter((entry) => entry.dedupeKey.endsWith(":queued"));
		assert.equal(notices.length, 1);
		assert.match(notices[0].text, /已排队，第 1 个/);
		const snap = h.manager.queueSnapshot(message("x"));
		assert.equal(snap.active, "prompt-m1");
		assert.deepEqual(snap.queued, ["第二个任务", "第三个任务"]);
		assert.equal(await h.manager.clearQueued(message("x")), 2);
		assert.deepEqual(h.manager.queueSnapshot(message("x")).queued, []);
		h.release();
		await waitUntil(() => h.durable.some((entry) => entry.dedupeKey === "m1:final"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(h.prompts.length, 1, "清掉的任务不再执行");
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("忙碌提示：并入当前任务的消息换成 steer 表情", async () => {
	const h = harness({ blockPrompt: true, config: { reaction: { ...DEFAULT_CONFIG.reaction, enabled: true } }, handle: { async steer() {} } });
	try {
		await h.manager.route(message("m1"));
		await waitUntil(() => h.prompts.length === 1);
		assert.equal(await h.manager.route(message("m2")), "steered");
		assert.deepEqual(h.reactions.filter((r) => r.messageId === "m2"), [
			{ op: "add", messageId: "m2", emoji: "Typing" },
			{ op: "remove", messageId: "m2" },
			{ op: "add", messageId: "m2", emoji: "JIAYI" },
		]);
		h.release();
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("撤回：撤回排队中的消息 → 出队；撤回执行中的 → 只停本轮", async () => {
	const h = harness({ blockPrompt: true });
	try {
		await h.manager.route(message("m1"));
		await waitUntil(() => h.prompts.length === 1);
		await h.manager.route(message("m2"));
		assert.equal((await h.manager.cancelByMessageId("m2")).status, "dequeued");
		assert.deepEqual(h.manager.queueSnapshot(message("x")).queued, []);
		await h.manager.route(message("m3"));
		const aborted = await h.manager.cancelByMessageId("m1");
		assert.equal(aborted.status, "aborted");
		assert.equal(aborted.chatId, "oc_chat");
		await waitUntil(() => h.prompts.length === 2, 1_000);
		assert.equal(h.prompts[1], "prompt-m3", "后面的任务继续执行");
		h.release();
		assert.equal((await h.manager.cancelByMessageId("nope")).status, "none");
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("回退与分叉：/undo 回到上一条用户消息之前；/retry 用原文重发（不带注入的上下文行）", async () => {
	const navigated: string[] = [];
	const h = harness({ handle: {
		userMessages: () => [{ entryId: "u1", text: "第一问" }, { entryId: "u2", text: "[发言人：张三（open_id=ou）]\n\n第二问" }],
		async navigateTo(entryId: string) { navigated.push(entryId); return { cancelled: false, editorText: "[发言人：张三（open_id=ou）]\n\n第二问" }; },
	} });
	try {
		assert.match(await h.manager.undoConversation(message("u")), /已撤销最近一轮：「第二问」[\s\S]*不会回滚/);
		assert.deepEqual(navigated, ["u2"]);
		// retry：没有桥侧记录时用 editorText 去掉上下文行
		assert.match(await h.manager.retryConversation(message("r")), /正在重试/);
		await waitUntil(() => h.prompts.length === 1);
		assert.equal(h.prompts[0], "第二问");
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("回退与分叉：忙碌时拒绝 /undo、/retry、/fork", async () => {
	const h = harness({ blockPrompt: true, handle: { userMessages: () => [{ entryId: "u1", text: "x" }], async navigateTo() { return { cancelled: false }; } } });
	try {
		await h.manager.route(message("m1"));
		await waitUntil(() => h.prompts.length === 1);
		for (const reply of [await h.manager.undoConversation(message("a")), await h.manager.retryConversation(message("b")), await h.manager.forkConversation(message("c"))]) {
			assert.match(reply, /仍在执行/);
		}
		h.release();
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("回退与分叉：/fork #N 从第 N 条消息之前分叉，接入会话指针（旧会话可 /resume）", async () => {
	const branched: string[] = [];
	let disposed = 0;
	let h!: Harness;
	h = harness({ handle: {
		userMessages: () => [{ entryId: "u1", text: "第一问" }, { entryId: "u2", text: "第二问" }],
		entryParentId: (id: string) => (id === "u1" ? null : id === "u2" ? "a1" : undefined),
		leafId: () => "a2",
		branchedSessionFile: (leaf: string) => { branched.push(leaf); const file = join(h.dir, `fork-${leaf}.jsonl`); writeFileSync(file, "{}\n"); return file; },
		async dispose() { disposed += 1; },
	} });
	try {
		assert.match(await h.manager.forkConversation(message("f1"), "#1"), /直接 \/new/);
		assert.match(await h.manager.forkConversation(message("f2"), "#9"), /没有第 9 条/);
		const reply = await h.manager.forkConversation(message("f3"), "#2");
		assert.match(reply, /已分叉出新会话[\s\S]*第二问/);
		assert.deepEqual(branched, ["a1"]);
		assert.equal(disposed, 1, "旧句柄释放，下一条消息在分叉文件上重开");
		const files = h.manager.referencedSessionFiles();
		assert.ok(files.has(join(h.dir, "fork-a1.jsonl")));
		assert.match(await h.manager.forkCandidates(message("l")), /#1 第一问\n#2 第二问/);
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("导出：/export md 生成只含对话文本的 markdown 并经 outbox 发文件", async () => {
	const h = harness();
	try {
		await h.manager.route(message("m1"));
		await waitUntil(() => h.durable.some((entry) => entry.dedupeKey === "m1:final"));
		// 模拟 Pi 会话文件
		const sessionFile = [...h.manager.referencedSessionFiles()][0];
		writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", id: "s" }),
			JSON.stringify({ type: "message", timestamp: "t1", message: { role: "user", content: "你好" } }),
			JSON.stringify({ type: "message", message: { role: "toolResult", content: "secret tool output" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "你好呀" }] } }),
		].join("\n"));
		assert.match(await h.manager.exportConversation(message("e1"), "md"), /已导出（md）/);
		assert.equal(h.files.length, 1);
		assert.equal(h.files[0].dedupeKey, "e1:export");
		assert.match(h.files[0].content, /## 用户 · t1\n\n你好/);
		assert.match(h.files[0].content, /## 助手\n\n你好呀/);
		assert.doesNotMatch(h.files[0].content, /secret tool output/);
		assert.match(await h.manager.exportConversation(message("e2"), "html"), /不支持导出 HTML/);
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("直接执行命令：直接执行命令：结果带退出码；执行中 /stop 调 abortBash", async () => {
	let aborted = 0;
	let finish: (value: { output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean }) => void = () => {};
	const h = harness({ handle: {
		executeBash: () => new Promise((resolve) => { finish = resolve; }),
		abortBash: () => { aborted += 1; finish({ output: "partial", exitCode: undefined, cancelled: true, truncated: false }); },
	} });
	try {
		const running = h.manager.runDirectBash(message("b1"), "sleep 10", 60_000);
		await waitUntil(() => h.manager.queueSnapshot(message("x")) !== undefined);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(await h.manager.stopConversation(message("s")), true);
		const result = await running;
		assert.equal(aborted, 1);
		assert.ok(result.ok && result.cancelled);
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("群预算：记账、80% 提醒一次、超限拒绝新任务", async () => {
	const ledger = new UsageLedger({ timeZone: "UTC" });
	const h = harness({ ledger, config: { groupRules: { oc_chat: { dailyBudgetUsd: 1 } } } });
	try {
		await h.manager.route(message("m1"));
		await waitUntil(() => h.durable.some((entry) => entry.dedupeKey === "m1:final"));
		await waitUntil(() => ledger.costToday("oc_chat") === 0.5);
		await h.manager.route(message("m2"));
		await waitUntil(() => h.durable.some((entry) => entry.text.includes("本群今日费用已达上限")));
		assert.equal(await h.manager.route(message("m3")), "rejected");
		assert.equal(h.prompts.length, 2, "超限后不再执行");
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("会话命名：第一轮成功后按首条消息自动命名；已命名的不覆盖", async () => {
	const h = harness();
	try {
		await h.manager.route(message("m1", "[发言人：张三（open_id=ou）]\n\n帮我看看线上告警为什么这么多，顺便统计一下"));
		await waitUntil(() => h.durable.some((entry) => entry.dedupeKey === "m1:final"));
		assert.equal(h.handle.sessionName?.(), "帮我看看线上告警为什么这么多，顺便统计一");
		await h.manager.route(message("m2", "别的"));
		await waitUntil(() => h.durable.some((entry) => entry.dedupeKey === "m2:final"));
		assert.equal(h.handle.sessionName?.(), "帮我看看线上告警为什么这么多，顺便统计一");
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("长回答转文件：超长回答（开启时）正文只放开头，全文作为 .md 附件", async () => {
	const long = `开头${"很长的内容".repeat(2_000)}结尾`;
	const h = harness({ reply: long, config: { longReply: { asFile: true, thresholdChars: 1_000, previewChars: 100 } } });
	try {
		await h.manager.route(message("m1"));
		await waitUntil(() => h.durable.some((entry) => entry.dedupeKey === "m1:final"));
		const final = h.durable.find((entry) => entry.dedupeKey === "m1:final")!;
		assert.ok(final.text.length < 300);
		assert.match(final.text, /完整内容见附件 reply-.*\.md/);
		assert.equal(h.files.length, 1);
		assert.equal(h.files[0].content, long, "附件与全文逐字一致");
		assert.equal(h.files[0].dedupeKey, "m1:final-file");
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("合成消息（定时任务）：不加表情、不挂回复", async () => {
	const h = harness({ config: { reaction: { ...DEFAULT_CONFIG.reaction, enabled: true } } });
	try {
		await h.manager.route(message("cron:j1:1", "定时任务", { synthetic: true, replyTarget: null }));
		await waitUntil(() => h.durable.some((entry) => entry.dedupeKey === "cron:j1:1:final"));
		assert.equal(h.reactions.length, 0);
		assert.equal(h.durable.find((entry) => entry.dedupeKey === "cron:j1:1:final")?.replyTo, undefined);
	} finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("stripContextPrefix / transcriptMarkdown 边界", () => {
	assert.equal(stripContextPrefix("[发言人：a]\n[提及：b]\n\n正文\n[不是前缀]"), "正文\n[不是前缀]");
	assert.equal(stripContextPrefix("没有前缀"), "没有前缀");
	assert.match(transcriptMarkdown("/nonexistent/file.jsonl", "标题"), /# 标题[\s\S]*会话文件不存在/);
	assert.equal(existsSync("/nonexistent/file.jsonl"), false);
});
