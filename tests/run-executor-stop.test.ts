/**
 * 执行器的 /stop 语义：标记只对按下时那一轮有效。
 *
 * 复现的是「上一轮收尾期间到达的 /stop 毒化下一条排队任务」：会话上的 `stopRequested`
 * 原本只在**当前那一轮**的收尾里复位，收尾已经走过复位点之后设置的标记没人清，
 * 下一条任务会被当成「用户主动停止」（不打完成表情）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RunExecutor, type RunHost } from "../src/session/run-executor.js";
import { ProgressTracker } from "../src/session/progress-tracker.js";
import { RateBudget } from "../src/runtime/rate-budget.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../src/types.js";
import type { BridgeSession, QueuedMessage } from "../src/session/conversation-manager.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function config(): BridgeConfig {
	return {
		...DEFAULT_CONFIG,
		reaction: { ...DEFAULT_CONFIG.reaction, enabled: true, doneEmoji: "DONE" },
		batch: { ...DEFAULT_CONFIG.batch, enabled: false },
		footer: { enabled: false, showCost: false },
	};
}

test("/stop 的标记不会毒化下一轮：新一轮开始就清掉", async () => {
	const cfg = config();
	const doneEmojis: Array<{ messageId: string; emoji: string }> = [];
	const handle = {
		sessionId: "sid", modelId: "m",
		async prompt() { return "答案"; },
		subscribe: () => () => {},
		async abort() {}, async dispose() {},
	};
	const progress = new ProgressTracker({ config: cfg, sender: { send: async () => ({ success: true, messageId: "om_progress" }) } as never });
	const host = {
		shuttingDown: false, runIdleTimeoutMs: 60_000, runMaxDurationMs: 600_000,
		progress, rateBudget: new RateBudget(),
		now: () => Date.now(),
		ensureAgentSession: async (sess: BridgeSession) => { sess.agent = handle as never; return handle as never; },
		prepareAgentInput: async (item: QueuedMessage) => ({ text: item.text }),
		touchRunActivity: () => {}, footerFor: () => "", rememberSentFooter: () => {},
		recordRunUsage: async () => {}, removeProcessingReaction: async () => {}, clearPending: () => {},
		notify: async () => true,
	} as unknown as RunHost;
	const executor = new RunExecutor({
		config: cfg,
		sender: { send: async () => ({ success: true, messageId: "om_1" }) } as never,
		sessionBackend: { async createSession() { return handle; } } as never,
		reactions: { add: async (messageId: string, emoji: string) => { doneEmojis.push({ messageId, emoji }); return "reaction_1"; } } as never,
		log: () => {},
	} as never, host);

	const sess = {
		conversationKey: "oc_g", chatId: "oc_g", queue: [], steered: [], activeRun: true, createdAt: Date.now(),
		// 上一轮收尾时留下的标记
		stopRequested: true,
	} as unknown as BridgeSession;
	const item = { messageId: "om_task", text: "跑一下", chatId: "oc_g", conversationKey: "oc_g", runId: "run-1" } as unknown as QueuedMessage;
	await executor.run(sess, item);
	await tick();

	assert.equal(sess.stopRequested, false, "跑完要复位");
	assert.deepEqual(doneEmojis, [{ messageId: "om_task", emoji: "DONE" }], "这一轮不是被停止的，必须打完成表情");
});
