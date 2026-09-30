import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAllowChatCard, buildHelpCard, buildNewSessionCard, buildSessionsCard, buildWelcomeCard } from "../src/commands/cards.js";
import { buildModelStatusCard } from "../src/commands/models-card.js";
import { parseLifecycleEvent } from "../src/inbound/transport.js";
import { psBashVerdict, summarizeApprovalPolicy } from "../src/approval/policy-summary.js";
import { formatStepSummary, renderProgressText } from "../src/outbound/progress-render.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function buttons(card: unknown): Array<{ text: string; value: Record<string, unknown> }> {
	const out: Array<{ text: string; value: Record<string, unknown> }> = [];
	const walk = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (record.tag === "button") out.push({ text: (record.text as { content: string }).content, value: record.value as Record<string, unknown> });
		for (const value of Object.values(record)) {
			if (Array.isArray(value)) value.forEach(walk);
			else if (value && typeof value === "object") walk(value);
		}
	};
	walk(card);
	return out;
}

test("帮助卡：帮助卡分组、无参命令做成按钮（带发起人），管理命令只对管理员给按钮", () => {
	const ctx = { chatType: "group" as const, ownerOpenId: "ou_me" };
	const user = buttons(buildHelpCard({ ...ctx, isAdmin: false, piCommands: [{ name: "skill:review", description: "代码审查", source: "skill" }, { name: "feishu:status", source: "extension" }] }));
	assert.ok(user.some((b) => b.value.command === "/new" && b.value.owner === "ou_me" && b.value.op === "command"));
	const json = JSON.stringify(buildHelpCard({ ...ctx, isAdmin: false, piCommands: [{ name: "skill:review", description: "代码审查", source: "skill" }, { name: "feishu:status", source: "extension" }] }));
	assert.match(json, /skill:review/);
	assert.doesNotMatch(json, /feishu:status`/, "扩展自己的 TUI 命令不列");
	for (const title of ["对话", "模型", "会话", "管理"]) assert.match(json, new RegExp(`\\*\\*${title}\\*\\*`));
	const admin = buttons(buildHelpCard({ ...ctx, isAdmin: true }));
	assert.ok(admin.length >= user.length);
});

test("会话卡：会话卡当前会话不给恢复按钮；/new 回执带恢复按钮", () => {
	const card = buildSessionsCard([
		{ selector: "#1", name: "当前", when: "刚刚", count: "3 条", isCurrent: true },
		{ selector: "#2", name: "旧的", when: "1 天前", count: "9 条", isCurrent: false },
	], { chatType: "p2p", ownerOpenId: "ou" }, "共 2 段");
	assert.deepEqual(buttons(card).map((b) => b.value.command), ["/resume #2"]);
	assert.deepEqual(buttons(buildNewSessionCard("已创建", { name: "旧", selector: "#2" }, { chatType: "p2p" })).map((b) => b.value.command), ["/resume #2"]);
	assert.deepEqual(buttons(buildNewSessionCard("已创建", undefined, { chatType: "p2p" })), []);
});

test("模型状态卡：状态卡最近使用与展开后的快速切换按钮（当前模型不出现）", () => {
	const card = buildModelStatusCard({
		currentLabel: "a/x", conversationKey: "oc", ownerOpenId: "ou", recentModels: ["a/x", "b/y"], contextInfo: "上下文窗口 128k",
		expanded: true, models: [{ id: "x", provider: "a" }, { id: "z", provider: "c" }],
	});
	const models = buttons(card).filter((b) => b.value.op === "model.set").map((b) => b.value.model);
	assert.deepEqual(models, ["b/y", "c/z"]);
	assert.match(JSON.stringify(card), /上下文窗口 128k/);
});

test("入群与准入：欢迎卡与放行卡", () => {
	assert.deepEqual(buttons(buildWelcomeCard({ trigger: "@ 我", ctx: { chatType: "group" } })).map((b) => b.value.command), ["/help", "/model"]);
	assert.deepEqual(buttons(buildAllowChatCard({ chatId: "oc_1", reason: "x" })).map((b) => b.value), [{ op: "chat.allow", chatId: "oc_1" }]);
});

test("入群与准入：生命周期事件整理", () => {
	assert.deepEqual(parseLifecycleEvent("recalled", { message_id: "om_1", chat_id: "oc" }), { type: "recalled", messageId: "om_1", chatId: "oc" });
	assert.deepEqual(parseLifecycleEvent("bot_added", { chat_id: "oc", name: "群", operator_id: { open_id: "ou" } }), { type: "bot_added", chatId: "oc", chatName: "群", operatorOpenId: "ou" });
	assert.deepEqual(parseLifecycleEvent("bot_removed", { chat_id: "oc" }), { type: "bot_removed", chatId: "oc" });
	assert.deepEqual(parseLifecycleEvent("p2p_entered", { chat_id: "oc", operator_id: { open_id: "ou" } }), { type: "p2p_entered", chatId: "oc", operatorOpenId: "ou" });
	assert.deepEqual(parseLifecycleEvent("reaction_created", { message_id: "om", reaction_type: { emoji_type: "THUMBSUP" }, user_id: { open_id: "ou" }, operator_type: "user" }), {
		type: "reaction", action: "created", messageId: "om", emoji: "THUMBSUP", operatorOpenId: "ou", operatorType: "user",
	});
	assert.equal(parseLifecycleEvent("recalled", {}), undefined);
	assert.equal(parseLifecycleEvent("unknown", { chat_id: "oc" }), undefined);
});

test("审批策略摘要：审批策略摘要（桥内置与 PS 两种引擎）", () => {
	const bridge = summarizeApprovalPolicy({ config: DEFAULT_CONFIG, psInstalled: false, pendingApprovals: 2 });
	assert.match(bridge, /引擎：桥内置/);
	assert.match(bridge, /当前待审批：2 条/);
	const ps = summarizeApprovalPolicy({
		config: { ...DEFAULT_CONFIG, approval: { ...DEFAULT_CONFIG.approval, policyEngine: "pi-permission-system" } },
		psInstalled: true, pendingApprovals: 0, alwaysRules: [{ pattern: "git push*" }],
		ps: { permission: { "*": "allow", bash: { "*": "allow", "rm -rf *": "deny", "echo PS-TEST-*": "ask" }, read: "allow" } },
	});
	assert.match(ps, /bash：默认放行；需审批 1 条：echo PS-TEST-\*；禁止 1 条：rm -rf \*/);
	assert.match(ps, /「始终批准」规则：git push\*/);
	const missing = summarizeApprovalPolicy({ config: { ...DEFAULT_CONFIG, approval: { ...DEFAULT_CONFIG.approval, policyEngine: "pi-permission-system" } }, psInstalled: false, pendingApprovals: 0 });
	assert.match(missing, /未安装/);
});

test("直接执行命令：PS bash 规则的保守判定（任一 deny 优先，其次 ask）", () => {
	const ps = { permission: { bash: { "*": "allow" as const, "rm -rf *": "deny" as const, "git *": "ask" as const, "git status": "allow" as const } } };
	assert.deepEqual(psBashVerdict(ps, "rm -rf /tmp/x"), { verdict: "deny", rule: "rm -rf *" });
	assert.deepEqual(psBashVerdict(ps, "git push"), { verdict: "ask", rule: "git *" });
	assert.equal(psBashVerdict(ps, "ls")?.verdict, "allow");
	assert.equal(psBashVerdict(undefined, "ls"), undefined);
	assert.equal(psBashVerdict({ permission: { "*": "deny" } }, "ls")?.verdict, "deny");
});

test("完成页脚：终态页脚带步骤摘要", () => {
	assert.equal(formatStepSummary({ bash: 6, read: 3 }), "共 9 步（bash×6、read×3）");
	assert.equal(formatStepSummary({ a: 1, b: 1, c: 1, d: 1, e: 2, f: 1 }, 2), "共 7 步（e×2、a×1、b×1、c×1、其他×2） · 2 步失败");
	assert.equal(formatStepSummary({}), undefined);
	const text = renderProgressText([{ text: "💻 ls", count: 1 }], undefined, { mode: "all", maxLines: 6, previewChars: 40 }, {
		startedAt: 0, finishedAt: 12_400, now: 12_400, outcome: "ok", stepSummary: "共 1 步（bash×1）",
	});
	assert.match(text, /✅ 完成 · 12\.4s · 共 1 步（bash×1）/);
});
