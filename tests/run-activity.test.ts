/**
 * 长任务：空闲超时分两段（工具执行中 / 等模型）、/progress 进度报告、工具执行中收到消息的忙碌提示。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { MODEL_QUIET_NOTICE_MS, RunActivity, busyNoticeText, describeProgress, durationLabel, modelWaitNotice } from "../src/session/run-activity.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type SessionBackend } from "../src/types.js";

const toolStart = (id: string, command: string) => ({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
const toolUpdate = (id: string, text: string) => ({ type: "tool_execution_update", toolCallId: id, toolName: "bash", partialResult: { content: [{ type: "text", text }] } });
const toolEnd = (id: string) => ({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: false });

test("运行状态：记录在跑的工具、最近几行输出；工具结束后回到等模型", () => {
	const activity = new RunActivity(0);
	activity.record(toolStart("t1", "npm test\n--verbose"), 1_000);
	assert.equal(activity.inTool, true);
	assert.deepEqual(activity.current(), { id: "t1", name: "bash", startedAt: 1_000, detail: "npm test" });
	activity.record(toolUpdate("t1", "a\nb\n\nc\nd\n"), 2_000);
	assert.equal(activity.lastOutput, "b\nc\nd", "只留最后 3 行非空输出");
	activity.record(toolEnd("t1"), 3_000);
	assert.equal(activity.inTool, false);
	assert.equal(activity.lastOutput, undefined);
	assert.equal(activity.toolCalls, 1);
	assert.equal(activity.lastEventAt, 3_000);
});

test("运行状态：时长写法、/progress 正文、忙碌提示", () => {
	assert.deepEqual([durationLabel(45_000), durationLabel(750_000), durationLabel(600_000), durationLabel(3_900_000)], ["45 秒", "12 分 30 秒", "10 分钟", "1 小时 5 分"]);
	const activity = new RunActivity(0);
	assert.equal(busyNoticeText(activity, 1_000), undefined, "等模型时不提示");
	assert.match(describeProgress({ activity, now: 40_000, steered: 0, queued: 0 }), /当前：等模型回复（40 秒没有新输出）/);
	activity.record(toolStart("t1", "npm run build"), 60_000);
	activity.record(toolUpdate("t1", "compiling…"), 70_000);
	const report = describeProgress({ activity, now: 200_000, task: "帮我实现\n登录功能", steered: 1, queued: 2 });
	assert.match(report, /已运行 3 分 20 秒/);
	assert.match(report, /任务：帮我实现 登录功能/);
	assert.match(report, /当前：bash `npm run build`，已执行 2 分 20 秒，2 分 10 秒没有新输出/);
	assert.match(report, /最近输出：\n```\ncompiling…\n```/);
	assert.match(report, /本轮已调用工具 1 次；待并入 1 条消息；排队 2 个任务/);
	assert.match(String(busyNoticeText(activity, 180_000)), /^正在执行 bash `npm run build`（已 2 分钟），你的消息会在这一步结束后交给模型。发 \/progress/);
});

const retryStart = (attempt: number) => ({
	type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 2_000,
	errorMessage: '503: {"message":"Service is too busy.","type":"service_unavailable_error"}',
});
const textDelta = (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });

test("等模型提示：pi 自动重试时说明状态码和第几次；收到模型输出后清掉", () => {
	const activity = new RunActivity(0);
	assert.equal(modelWaitNotice(activity, 1_000, 600_000), undefined, "一切正常时不提示");
	activity.record(retryStart(1), 1_000);
	assert.deepEqual(modelWaitNotice(activity, 2_000, 600_000), { kind: "retry", text: "⚠️ 模型服务暂时不可用（503），正在自动重试（第 1/3 次）…" });
	assert.match(describeProgress({ activity, now: 2_000, steered: 0, queued: 0 }), /模型服务暂时不可用（503），pi 正在自动重试（第 1\/3 次）/);
	activity.record(textDelta("答"), 3_000);
	assert.equal(activity.retry, undefined);
	assert.equal(modelWaitNotice(activity, 4_000, 600_000), undefined);
	activity.record(retryStart(2), 5_000);
	activity.record({ type: "auto_retry_end", success: false, attempt: 3, finalError: "503" }, 6_000);
	assert.equal(activity.retry, undefined, "重试结束（成败都算）后不再显示重试中");
});

test("等模型提示：长时间没有任何事件 → 提示可能在排队，并写明多久后自动中止；工具执行中不提示", () => {
	const activity = new RunActivity(0);
	assert.equal(modelWaitNotice(activity, MODEL_QUIET_NOTICE_MS - 1, 600_000), undefined);
	const quiet = modelWaitNotice(activity, MODEL_QUIET_NOTICE_MS, 600_000);
	assert.equal(quiet?.kind, "quiet");
	assert.match(String(quiet?.text), /^⏳ 已 1 分钟没有收到模型输出，模型服务可能在排队，10 分钟仍没有输出会自动中止。/);
	assert.equal(modelWaitNotice(activity, 150_000, 600_000)?.text, modelWaitNotice(activity, 179_000, 600_000)?.text, "按分钟取整：一分钟内文案不变（进度消息编辑次数有限）");
	assert.doesNotMatch(String(modelWaitNotice(activity, 120_000, 0)?.text), /自动中止/, "关闭空闲超时时不说会自动中止");
	activity.record(retryStart(1), 1_000);
	assert.equal(modelWaitNotice(activity, 1_000 + MODEL_QUIET_NOTICE_MS, 600_000)?.kind, "quiet", "重试后又挂住：排队提示优先");
	activity.record(toolStart("t1", "npm test"), 200_000);
	assert.equal(modelWaitNotice(activity, 900_000, 600_000), undefined, "工具执行中（包括等审批）不算等模型");
});

test("等模型提示：卡片模式下重试状态写进卡片，模型开始输出后被正文替换", async () => {
	const contents: string[] = [];
	const rawRequest = async (opts: { url: string; method: string; data?: unknown }) => {
		if (opts.url === "/open-apis/cardkit/v1/cards") return { data: { card_id: "card-wait" } };
		if (opts.url.startsWith("/open-apis/im/v1/messages")) return { data: { message_id: "om-card-wait" } };
		if (opts.url.endsWith("/elements/stream/content")) contents.push(String((opts.data as { content?: unknown }).content));
		return { data: {} };
	};
	let emit: (event: unknown) => void = () => {};
	let finish: (text: string) => void = () => {};
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-wait",
				prompt: () => new Promise<string>((resolve) => { finish = resolve; }),
				subscribe(listener: (event: unknown) => void) { emit = listener; return () => {}; },
				async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const logs: string[] = [];
	const manager = new ConversationManager({
		config: {
			...DEFAULT_CONFIG, allowChats: ["oc_chat"], streamingCard: { enabled: true, throttleMs: 0 },
			reaction: { ...DEFAULT_CONFIG.reaction, enabled: false }, footer: { enabled: false, showCost: false },
		},
		sessionDir: "/tmp/feishu-run-activity-wait", sessionBackend: backend, rawRequest,
		sender: { async send() { return { success: true, messageId: "om_text" }; } } as never,
		log: (_level, msg) => logs.push(msg),
	});
	await manager.route(message("wait"));
	await waitUntil(() => contents.length === 0 && logs.includes("feishu.stream_card.started"));
	emit(retryStart(1));
	await waitUntil(() => contents.some((text) => text.includes("正在自动重试（第 1/3 次）")));
	assert.ok(logs.includes("feishu.conv.model_retry"));
	emit(textDelta("答案开头"));
	await waitUntil(() => contents.at(-1) === "答案开头");
	finish("答案开头");
	await waitUntil(() => logs.includes("feishu.stream_card.finished"));
	await manager.shutdown();
});

function setup(over: Partial<BridgeConfig> & { runIdleTimeoutMs?: number; runToolIdleTimeoutMs?: number; now?: () => number } = {}) {
	const sent: string[] = [];
	const steered: string[] = [];
	let emit: (event: unknown) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-long",
				// 这一轮一直不结束，直到被中止（超时或 shutdown）
				prompt: () => new Promise<string>((_resolve, reject) => { fail = reject; }),
				async steer(text: string) { steered.push(text); },
				subscribe(listener: (event: unknown) => void) { emit = listener; return () => {}; },
				async abort() { fail(new Error("aborted")); }, async dispose() {}, modelId: "m",
			};
		},
	};
	const { runIdleTimeoutMs, runToolIdleTimeoutMs, now, ...config } = over;
	const manager = new ConversationManager({
		config: { ...DEFAULT_CONFIG, allowChats: ["oc_chat"], reaction: { ...DEFAULT_CONFIG.reaction, enabled: false }, footer: { enabled: false, showCost: false }, ...config },
		sessionDir: "/tmp/feishu-run-activity", sessionBackend: backend,
		sender: { async send(_chatId: string, text: string) { sent.push(text); return { success: true, messageId: `om_${sent.length}` }; } } as never,
		runIdleTimeoutMs, runToolIdleTimeoutMs, now,
	});
	return { manager, sent, steered, emit: (event: unknown) => emit(event), stop: () => manager.shutdown() };
}

function message(id: string, over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
	return { messageId: id, chatId: "oc_dm", chatType: "p2p", senderId: "ou_user", isBot: false, msgType: "text", text: `msg-${id}`, mentions: [], resources: [], raw: undefined, ts: Date.now(), ...over };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("waitUntil timeout");
		await sleep(2);
	}
}

test("空闲超时分两段：工具执行中按 runToolIdleTimeoutMs，不按等模型的时限；中止提示写明卡在哪个工具", async () => {
	const { manager, sent, emit, stop } = setup({ runIdleTimeoutMs: 40, runToolIdleTimeoutMs: 300 });
	await manager.route(message("long"));
	await sleep(5);
	emit(toolStart("t1", "npm test"));
	await sleep(150);
	assert.ok(!sent.some((text) => text.includes("已中止")), "工具执行中没超过工具时限，不能按等模型的 40ms 中止");
	await waitUntil(() => sent.some((text) => text.includes("已中止")));
	assert.match(sent.find((text) => text.includes("已中止")) ?? "", /工具 bash 已 0 秒没有输出.*runToolIdleTimeoutMs/);
	await stop();
});

test("空闲超时分两段：工具结束后回到等模型的时限", async () => {
	const { manager, sent, emit, stop } = setup({ runIdleTimeoutMs: 40, runToolIdleTimeoutMs: 10_000 });
	await manager.route(message("model"));
	await sleep(5);
	emit(toolStart("t1", "ls"));
	emit(toolEnd("t1"));
	await waitUntil(() => sent.some((text) => text.includes("已中止")));
	assert.match(sent.find((text) => text.includes("已中止")) ?? "", /没有收到模型的任何输出.*runIdleTimeoutMs/);
	await stop();
});

test("/progress：执行中报告当前工具和最近输出；空闲时说明没有任务", async () => {
	let clock = 1_000_000;
	const { manager, emit, stop } = setup({ runIdleTimeoutMs: 0, runToolIdleTimeoutMs: 0, now: () => clock });
	assert.equal(manager.progressReport(message("p0")), "当前没有执行中的任务");
	await manager.route(message("p1"));
	await sleep(5);
	emit(toolStart("t1", "npm run build"));
	emit(toolUpdate("t1", "step 3/5"));
	clock += 125_000;
	const report = manager.progressReport(message("p2"));
	assert.match(report, /^正在执行（已运行 2 分 5 秒）/);
	assert.match(report, /任务：msg-p1/);
	assert.match(report, /bash `npm run build`，已执行 2 分 5 秒/);
	assert.match(report, /step 3\/5/);
	await stop();
});

test("忙碌提示：工具执行超过 1 分钟时收到普通消息先回一句；5 分钟内只一次；卡片点击等合成消息不提示", async () => {
	let clock = 1_000_000;
	const { manager, sent, steered, emit, stop } = setup({ runIdleTimeoutMs: 0, runToolIdleTimeoutMs: 0, now: () => clock });
	await manager.route(message("b1"));
	await sleep(5);
	emit(toolStart("t1", "npm test"));
	clock += 30_000;
	assert.equal(await manager.route(message("b2")), "steered");
	assert.ok(!sent.some((text) => text.includes("正在执行")), "工具才跑 30 秒，不提示");
	clock += 60_000;
	await manager.route(message("b3", { synthetic: true }));
	assert.ok(!sent.some((text) => text.includes("正在执行")), "合成消息不提示");
	await manager.route(message("b4"));
	await waitUntil(() => sent.some((text) => text.includes("正在执行")));
	assert.match(sent.find((text) => text.includes("正在执行")) ?? "", /正在执行 bash `npm test`（已 1 分 30 秒）.*\/progress/);
	await manager.route(message("b5"));
	await sleep(20);
	assert.equal(sent.filter((text) => text.includes("正在执行")).length, 1, "5 分钟内只提示一次");
	assert.equal(steered.length, 4, "消息照常注入");
	await stop();
});

test("忙碌提示：关了 queueNotice 就不提示", async () => {
	let clock = 1_000_000;
	const { manager, sent, emit, stop } = setup({ queueNotice: false, runIdleTimeoutMs: 0, runToolIdleTimeoutMs: 0, now: () => clock });
	await manager.route(message("q1"));
	await sleep(5);
	emit(toolStart("t1", "npm test"));
	clock += 120_000;
	await manager.route(message("q2"));
	await sleep(20);
	assert.ok(!sent.some((text) => text.includes("正在执行")));
	await stop();
});

test("空闲超时（卡片模式）：中止说明写进卡片，不再另发一条文字；卡片写不进去才发文字", async () => {
	for (const cardWritable of [true, false]) {
		const contents: string[] = [];
		const rawRequest = async (opts: { url: string; method: string; data?: unknown }) => {
			if (opts.url === "/open-apis/cardkit/v1/cards") return { data: { card_id: "card-idle" } };
			if (opts.url.startsWith("/open-apis/im/v1/messages")) return { data: { message_id: "om-card-idle" } };
			if (!cardWritable) return { code: 300301, msg: "card not found" };
			contents.push(String((opts.data as { content?: unknown }).content));
			return { data: {} };
		};
		const sent: string[] = [];
		let fail: (error: Error) => void = () => {};
		const backend: SessionBackend = {
			async createSession() {
				return {
					sessionId: "sid-idle-card",
					prompt: () => new Promise<string>((_resolve, reject) => { fail = reject; }),
					subscribe: () => () => {},
					async abort() { fail(new Error("aborted")); }, async dispose() {}, modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: {
				...DEFAULT_CONFIG, allowChats: ["oc_chat"], streamingCard: { enabled: true, throttleMs: 0 },
				reaction: { ...DEFAULT_CONFIG.reaction, enabled: false }, footer: { enabled: false, showCost: false },
			},
			sessionDir: "/tmp/feishu-run-activity-idle-card", sessionBackend: backend, rawRequest, runIdleTimeoutMs: 40,
			sender: { async send(_chatId: string, text: string) { sent.push(text); return { success: true, messageId: `om_${sent.length}` }; } } as never,
		});
		await manager.route(message(`idle-${cardWritable}`));
		if (cardWritable) {
			await waitUntil(() => contents.some((text) => text.includes("没有收到模型的任何输出")));
			await sleep(20);
			assert.ok(!sent.some((text) => text.includes("没有收到模型的任何输出")), `已写进卡片就不再另发：${JSON.stringify(sent)}`);
		} else {
			await waitUntil(() => sent.some((text) => text.includes("没有收到模型的任何输出")));
		}
		await manager.shutdown();
	}
});
