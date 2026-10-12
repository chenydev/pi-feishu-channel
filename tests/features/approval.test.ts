/**
 * 工具审批（approval.mode，默认 off）：关 / 开两种配置，以及 `/feishu approvals` 的会话覆盖与 `-g` 持久化。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Harness } from "../integration/extension-harness.js";
import { ADMIN, T, USER, enabledIn, withHarness } from "./helpers.js";

const dmOf = (sender: string) => `oc_dm_${sender}`;

/** 让 sender 的私聊会话开始一轮执行（工具调用只在有活动轮次时才经过审批）。 */
async function startRun(h: Harness, sender: string): Promise<string> {
	const chatId = dmOf(sender);
	await h.message({ chatId, sender, text: "帮我写一个文件" });
	const deadline = Date.now() + 3_000;
	while (!h.sessions.prompts.some((p) => p.conversationKey === chatId)) {
		if (Date.now() > deadline) throw new Error("会话没有开始执行");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return h.sessions.sessionIdFor(chatId);
}

function writeCall(h: Harness, sessionId: string, id = "call-1") {
	return h.pi.emit("tool_call", { toolCallId: id, toolName: "write", input: { path: "a.txt", content: "x" } }, { cwd: "/", sessionManager: { getSessionId: () => sessionId } });
}

/** 工具调用是否停在审批卡上（放行 = false，出现新的审批卡 = true）。 */
async function waitsForCard(h: Harness, sender: string, sessionId: string, id: string): Promise<boolean> {
	const cards = () => h.sent(dmOf(sender)).filter((m) => m.includes('"op":"approval"')).length;
	const before = cards();
	let settled = false;
	void writeCall(h, sessionId, id).then(() => { settled = true; });
	const deadline = Date.now() + 3_000;
	for (;;) {
		if (cards() > before) return true;
		if (settled) return false;
		if (Date.now() > deadline) throw new Error("工具调用既没有放行也没有弹卡");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function command(h: Harness, sender: string, text: string, expect: RegExp): Promise<void> {
	await h.message({ chatId: dmOf(sender), sender, text });
	await h.waitForMessage(dmOf(sender), expect);
}

const users = { allowUsers: [USER, ADMIN] };

test("审批·关（默认）：不写配置时工具调用直接放行，不弹卡，不出现在已启用能力里", T, async () => {
	await withHarness(users, async (h) => {
		const sessionId = await startRun(h, USER);
		assert.equal(await writeCall(h, sessionId), undefined);
		assert.equal(h.sent(dmOf(USER)).filter((m) => m.includes('"op":"approval"')).length, 0);
		assert.ok(!enabledIn(h).status.includes("approval"));
		assert.deepEqual(h.logs.find((l) => l.event === "feishu.approval.mode")?.meta, { mode: "off", source: "default" });
		await command(h, USER, "/feishu approvals", /模式：关闭（默认）/);
	});
});

test("审批·开：mode=builtin 时需要审批的工具调用弹卡，并列在已启用能力里", T, async () => {
	await withHarness({ ...users, approval: { mode: "builtin" } }, async (h) => {
		const sessionId = await startRun(h, USER);
		void writeCall(h, sessionId);
		await h.waitForMessage(dmOf(USER), /"op":"approval"/);
		assert.ok(enabledIn(h).status.includes("approval"));
		await command(h, USER, "/feishu approvals", /模式：内置（配置文件）/);
	});
});

test("审批·会话覆盖：只改发命令的会话，其他会话仍按全局；reset 恢复", T, async () => {
	await withHarness(users, async (h) => {
		await command(h, ADMIN, "/feishu approvals 内置", /本会话审批模式：内置（临时/);
		const adminSession = await startRun(h, ADMIN);
		const userSession = await startRun(h, USER);
		assert.equal(await waitsForCard(h, ADMIN, adminSession, "call-a1"), true, "管理员的会话已切到内置审批");
		assert.equal(await waitsForCard(h, USER, userSession, "call-u1"), false, "其他会话仍是全局的关闭");
		assert.equal(h.config().approval, undefined, "会话覆盖不写配置文件");

		await command(h, ADMIN, "/feishu approvals reset", /已清除本会话的临时设置，当前按全局：关闭/);
		assert.equal(await writeCall(h, adminSession, "call-a2"), undefined);
	});
});

test("审批·-g：写进配置文件并立即对所有会话生效", T, async () => {
	await withHarness(users, async (h) => {
		await command(h, ADMIN, "/feishu approvals builtin -g", /已写入配置：审批模式 内置/);
		assert.deepEqual(h.config().approval, { mode: "builtin" });
		const userSession = await startRun(h, USER);
		assert.equal(await waitsForCard(h, USER, userSession, "call-u1"), true);
		await command(h, USER, "/feishu approvals", /模式：内置（配置文件）/);

		await command(h, ADMIN, "/feishu approvals off --global", /已写入配置：审批模式 关闭/);
		assert.deepEqual(h.config().approval, { mode: "off" });
	});
});

test("审批·权限：非管理员能查看不能切换；取值不对时给出用法", T, async () => {
	await withHarness(users, async (h) => {
		await command(h, USER, "/feishu approvals builtin", /仅管理员或应用归属人可切换审批模式/);
		await command(h, USER, "/feishu approvals off -g", /仅管理员或应用归属人可切换审批模式/);
		await command(h, ADMIN, "/feishu approvals bridge", /用法：\/feishu approvals/);
		assert.equal(h.config().approval, undefined);
	});
});
