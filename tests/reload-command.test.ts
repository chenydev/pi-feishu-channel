/**
 * `/reload`（ConversationManager.reloadConversation）：
 * - 只重载已建立的会话，忙碌时拒绝；
 * - 回执列出数量、技能增减、加载问题；
 * - 重载后重新套用按群工具档位（pi 重建运行时会把扩展工具全部启用）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { reloadSession } from "../src/session/pi-session-backend.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type ReloadSummary, type SessionBackend } from "../src/types.js";

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		...DEFAULT_CONFIG, allowChats: ["oc_real_chat"],
		reaction: { ...DEFAULT_CONFIG.reaction, enabled: false },
		footer: { enabled: false, showCost: false },
		batch: { ...DEFAULT_CONFIG.batch, enabled: false },
		...over,
	};
}

function message(messageId: string): FeishuInboundMessage {
	return {
		messageId, chatId: "oc_real_chat", chatType: "p2p", senderId: "ou_user", isBot: false,
		msgType: "text", text: `prompt-${messageId}`, mentions: [], resources: [], raw: undefined, ts: Date.now(),
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("waitUntil timeout");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

interface Harness {
	manager: ConversationManager;
	reloads: () => number;
	toolCalls: string[][];
	release: () => void;
	prompted: () => number;
	cleanup: () => void;
}

function harness(opts: {
	reload?: (() => Promise<ReloadSummary>) | null;
	holdPrompt?: boolean;
	over?: Partial<BridgeConfig>;
} = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-reload-"));
	let reloads = 0;
	let prompted = 0;
	let release = () => {};
	const toolCalls: string[][] = [];
	const summary: ReloadSummary = { extensions: 3, skills: ["review", "skill-base-cli"], addedSkills: ["skill-base-cli"], removedSkills: [], prompts: 2, problems: [] };
	const reload = opts.reload === undefined ? async () => summary : opts.reload;
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-reload",
				async prompt() {
					prompted += 1;
					if (opts.holdPrompt) await new Promise<void>((resolve) => { release = resolve; });
					return "ok";
				},
				subscribe() { return () => {}; },
				async abort() { release(); },
				async dispose() {},
				modelId: "m",
				allToolNames: () => ["read", "bash", "edit", "skill_tool"],
				setActiveTools: (names: string[]) => { toolCalls.push(names); },
				...(reload ? { reload: async () => { reloads += 1; return reload(); } } : {}),
			};
		},
	};
	const manager = new ConversationManager({
		config: config(opts.over), sessionDir: dir, sessionBackend: backend,
		sender: { async send() { return { success: true, messageId: "om_x" }; } } as never,
		durableOutbox: { enqueue() { return ["1"]; } },
	});
	return {
		manager, toolCalls, reloads: () => reloads, prompted: () => prompted, release: () => release(),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** 等第一轮跑完：prompt 被调用过且队列里没有执行中的任务。 */
async function settled(h: Harness): Promise<void> {
	await waitUntil(() => h.prompted() === 1 && !h.manager.queueSnapshot(message("probe")).active);
}

test("/reload：会话还没建立时不重载，提示下一条消息直接用新内容", async () => {
	const h = harness();
	try {
		const text = await h.manager.reloadConversation(message("r0"));
		assert.match(text, /还没有加载/);
		assert.equal(h.reloads(), 0);
	} finally { h.cleanup(); }
});

test("/reload：空闲时重载，回执列出数量和新增技能，并重新套用按群工具档位", async () => {
	const h = harness({ over: { groupRules: { oc_real_chat: { tools: "readonly" } } } });
	try {
		await h.manager.route(message("r1"));
		await settled(h);
		assert.deepEqual(h.toolCalls, [["read"]]);
		const text = await h.manager.reloadConversation(message("r2"));
		assert.equal(h.reloads(), 1);
		assert.match(text, /^已重新加载：扩展 3 个、技能 2 个、提示模板 2 个/);
		assert.match(text, /新增技能：skill-base-cli/);
		assert.doesNotMatch(text, /移除技能|加载问题/);
		assert.deepEqual(h.toolCalls, [["read"], ["read"]], "重载后仍只开放 readonly 档位的工具");
	} finally { h.cleanup(); }
});

test("/reload：有任务在执行时拒绝", async () => {
	const h = harness({ holdPrompt: true });
	try {
		await h.manager.route(message("busy-1"));
		await waitUntil(() => h.prompted() === 1);
		const text = await h.manager.reloadConversation(message("busy-2"));
		assert.match(text, /仍在执行/);
		assert.equal(h.reloads(), 0);
		h.release();
	} finally { h.cleanup(); }
});

test("/reload：加载问题列进回执；重载抛错时说明失败；老 SDK 没有 reload 时说明不支持", async () => {
	const problems = harness({
		reload: async () => ({ extensions: 1, skills: [], addedSkills: [], removedSkills: ["old-skill"], prompts: 0, problems: ["扩展 /x/ext.ts：SyntaxError"] }),
	});
	const failing = harness({ reload: async () => { throw new Error("bad settings.json"); } });
	const legacy = harness({ reload: null });
	try {
		for (const h of [problems, failing, legacy]) {
			await h.manager.route(message("p1"));
			await settled(h);
		}
		const text = await problems.manager.reloadConversation(message("p2"));
		assert.match(text, /移除技能：old-skill/);
		assert.match(text, /有 1 处加载问题：\n· 扩展 \/x\/ext\.ts：SyntaxError/);
		assert.equal(await failing.manager.reloadConversation(message("p2")), "重新加载失败：bad settings.json");
		assert.equal(await legacy.manager.reloadConversation(message("p2")), "当前 Pi 版本不支持重新加载");
	} finally { problems.cleanup(); failing.cleanup(); legacy.cleanup(); }
});

test("/reload：后端按重载前后的技能名算出增减，只把 error / collision 和扩展加载错误算作问题", async () => {
	let skills = ["review", "old-skill"];
	const loader = {
		getExtensions: () => ({ extensions: [{}, {}], errors: [{ path: "/x/ext.ts", error: "SyntaxError" }] }),
		getSkills: () => ({
			skills: skills.map((name) => ({ name })),
			diagnostics: [
				{ type: "warning", message: "description 太长" },
				{ type: "collision", message: "技能重名：review", path: "/y/SKILL.md" },
			],
		}),
		getPrompts: () => ({ prompts: [{}], diagnostics: [{ type: "error", message: "模板解析失败" }] }),
	};
	const summary = await reloadSession({
		resourceLoader: loader,
		async reload() { skills = ["review", "skill-base-cli"]; },
	});
	assert.deepEqual(summary, {
		extensions: 2, skills: ["review", "skill-base-cli"], prompts: 1,
		addedSkills: ["skill-base-cli"], removedSkills: ["old-skill"],
		problems: ["扩展 /x/ext.ts：SyntaxError", "/y/SKILL.md：技能重名：review", "模板解析失败"],
	});
});
