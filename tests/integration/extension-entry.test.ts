/**
 * 扩展入口的行为锁定测试：从 `feishuBridgeExtension` 入口驱动真实组件（只替换飞书 SDK 与 pi 会话），
 * 锁住入口里与权限相关的行为 —— 卡片点击鉴权、工具审批检查、命令的管理员判定、群开通审批。
 *
 * 拆分入口（refactor-plan D1–D6）的每一步都必须让这里保持全绿。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startHarness, type Harness } from "./extension-harness.js";

const ADMIN = "ou_admin";
const USER = "ou_user";
const OTHER = "ou_other";
const GROUP = "oc_group";

const baseConfig = {
	admins: [ADMIN],
	allowUsers: [USER, OTHER],
	allowChats: [GROUP],
	groupPolicy: "mention",
	onboarding: { accessRequest: true, accessApprovers: "all" },
};

async function withHarness(config: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
	const h = await startHarness(config);
	try { await body(h); } finally { await h.stop(); }
}

type Toast = { toast?: { type?: string; content?: string } } | undefined;
const toastOf = (response: unknown) => (response as Toast)?.toast;

/** 审批类用例一旦判定走错分支就会一直等人点卡片：给每个用例设上限，失败而不是卡死。 */
const T = { timeout: 10_000 };

// ---------------------------------------------------------------- 卡片点击鉴权

test("入口·卡片鉴权：会话类按钮只允许发起人或管理员，其他人被拒并留下日志", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const value = { op: "thinking.set", level: "high", conversationKey: `${GROUP}:u:${USER}`, owner: USER };
		const denied = await h.click({ messageId: "om_card", chatId: GROUP, operator: OTHER, value });
		assert.equal(toastOf(denied)?.type, "warning");
		assert.equal(toastOf(denied)?.content, "只有发起人或管理员可以操作这张卡片");
		assert.ok(h.hasLog("feishu.card.unauthorized"), "拒绝必须有日志");

		const byOwner = await h.click({ messageId: "om_card", chatId: GROUP, operator: USER, value });
		assert.notEqual(toastOf(byOwner)?.content, "只有发起人或管理员可以操作这张卡片", "发起人可以操作");
		const byAdmin = await h.click({ messageId: "om_card", chatId: GROUP, operator: ADMIN, value });
		assert.notEqual(toastOf(byAdmin)?.content, "只有发起人或管理员可以操作这张卡片", "管理员可以操作");
	});
});

test("入口·卡片鉴权：卡片所属会话与点击所在的群不一致时拒绝，管理员也不例外", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const value = { op: "model.set", model: "x/y", conversationKey: "oc_elsewhere", owner: ADMIN };
		const response = await h.click({ messageId: "om_card", chatId: GROUP, operator: ADMIN, value });
		assert.equal(toastOf(response)?.content, "卡片与当前会话不匹配");
	});
});

test("入口·卡片鉴权：没有发起人信息的旧卡片只允许管理员", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const value = { op: "models.toggle", conversationKey: GROUP };
		const byUser = await h.click({ messageId: "om_card", chatId: GROUP, operator: USER, value });
		assert.equal(toastOf(byUser)?.content, "这张卡片已过期，请重新发送命令获取新卡片");
		const byAdmin = await h.click({ messageId: "om_card", chatId: GROUP, operator: ADMIN, value });
		assert.notEqual(toastOf(byAdmin)?.content, "这张卡片已过期，请重新发送命令获取新卡片");
	});
});

test("入口·卡片鉴权：同一个回调 token 重复投递只处理一次", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const value = { op: "thinking.set", level: "high", conversationKey: GROUP, owner: USER };
		const first = await h.click({ messageId: "om_card", chatId: GROUP, operator: OTHER, value, token: "tok-1" });
		assert.ok(first, "第一次有应答");
		const second = await h.click({ messageId: "om_card", chatId: GROUP, operator: OTHER, value, token: "tok-1" });
		assert.equal(second, undefined, "重复投递不再处理");
		assert.ok(h.hasLog("feishu.card.duplicate_token"));
	});
});

test("入口·卡片鉴权：命令按钮只允许发起人或管理员", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const value = { op: "command", command: "/new", owner: USER, chatType: "group" };
		const response = await h.click({ messageId: "om_card", chatId: GROUP, operator: OTHER, value });
		assert.equal(toastOf(response)?.content, "只有发起人或管理员可以操作这张卡片");
	});
});

// ---------------------------------------------------------------- 工具审批检查

/** 让 USER 在私聊里发起一轮对话并停住，返回这一轮的会话 id。 */
async function startRun(h: Harness, sender = USER): Promise<{ chatId: string; sessionId: string }> {
	const chatId = `oc_dm_${sender}`;
	await h.message({ chatId, sender, text: "帮我写一个文件" });
	await (async () => {
		const deadline = Date.now() + 3_000;
		while (!h.sessions.prompts.some((p) => p.conversationKey === chatId)) {
			if (Date.now() > deadline) throw new Error("会话没有开始执行");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	})();
	return { chatId, sessionId: h.sessions.sessionIdFor(chatId) };
}

function toolCall(h: Harness, sessionId: string, toolName: string, input: Record<string, unknown>, id = "call-1") {
	return h.pi.emit("tool_call", { toolCallId: id, toolName, input }, { cwd: "/", sessionManager: { getSessionId: () => sessionId } });
}

test("入口·审批检查：需要审批的工具调用发出审批卡；非管理员点击无效，管理员批准后放行", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const { chatId, sessionId } = await startRun(h);
		const verdict = toolCall(h, sessionId, "write", { path: "a.txt", content: "x" });

		await h.waitForMessage(chatId, /"op":"approval"/);
		const [once] = h.buttonValues((v) => v.op === "approval" && v.choice === "once");
		assert.ok(once, "审批卡上有「批准一次」按钮");

		const byUser = await h.click({ messageId: once.messageId, chatId, operator: USER, value: once.value });
		assert.equal(toastOf(byUser)?.type, "warning", "非管理员不能批准自己的调用");

		const byAdmin = await h.click({ messageId: once.messageId, chatId, operator: ADMIN, value: once.value });
		assert.equal(toastOf(byAdmin)?.type, "success");
		assert.equal(await verdict, undefined, "批准后工具调用放行（不返回 block）");
		assert.ok(h.hasLog("feishu.approval.audit"), "审批过程有审计日志");
	});
});

test("入口·审批检查：管理员拒绝后工具调用被阻断", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const { chatId, sessionId } = await startRun(h);
		const verdict = toolCall(h, sessionId, "write", { path: "a.txt", content: "x" });
		await h.waitForMessage(chatId, /"op":"approval"/);
		const [deny] = h.buttonValues((v) => v.op === "approval" && v.choice === "deny");
		await h.click({ messageId: deny.messageId, chatId, operator: ADMIN, value: deny.value });
		assert.deepEqual(await verdict, { block: true, reason: "飞书审批已拒绝" });
	});
});

test("入口·审批检查：危险命令直接拒绝，不弹卡", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const { chatId, sessionId } = await startRun(h);
		const verdict = await toolCall(h, sessionId, "bash", { command: "rm -rf /" }) as { block?: boolean };
		assert.equal(verdict?.block, true);
		assert.ok(h.hasLog("feishu.approval.command_deny"));
		assert.equal(h.buttonValues((v) => v.op === "approval").length, 0, "不得弹出审批卡");
		assert.ok(!h.sent(chatId).some((c) => c.includes('"op":"approval"')));
	});
});

test("入口·审批检查：只读命令直接放行，不弹卡", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const { sessionId } = await startRun(h);
		assert.equal(await toolCall(h, sessionId, "bash", { command: "ls -la" }), undefined);
		assert.ok(h.hasLog("feishu.approval.command_allow"));
		assert.equal(h.buttonValues((v) => v.op === "approval").length, 0);
	});
});

test("入口·审批检查：命令分级看的是完整原始命令，而不是卡片上截断、打码后的文本", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const { sessionId } = await startRun(h);
		// 前 1500 个字符都是无害的只读命令：只看展示文本就会漏掉末尾的危险部分
		const command = `${"echo ok; ".repeat(200)}rm -rf /`;
		const verdict = await toolCall(h, sessionId, "bash", { command }) as { block?: boolean };
		assert.equal(verdict?.block, true, "危险部分在截断位置之后也必须被拒绝");
	});
});

test("入口·审批检查：开启管理员免审时，管理员自己发起的调用不弹卡", T, async () => {
	await withHarness({ ...baseConfig, approval: { adminSkipApproval: true } }, async (h) => {
		const { sessionId } = await startRun(h, ADMIN);
		assert.equal(await toolCall(h, sessionId, "write", { path: "a.txt", content: "x" }), undefined);
		assert.ok(h.hasLog("feishu.approval.admin_skip"));
		assert.equal(h.buttonValues((v) => v.op === "approval").length, 0);
	});
});

test("入口·审批检查：没有活动会话的工具调用不拦截", T, async () => {
	await withHarness(baseConfig, async (h) => {
		assert.equal(await toolCall(h, "sid:unknown", "write", { path: "a.txt" }), undefined);
		assert.equal(h.buttonValues((v) => v.op === "approval").length, 0);
	});
});

// ---------------------------------------------------------------- 命令的管理员判定

test("入口·命令权限：群策略只有管理员能改，改动写入配置文件", T, async () => {
	await withHarness(baseConfig, async (h) => {
		await h.message({ chatId: GROUP, chatType: "group", sender: USER, text: "/feishu policy open" });
		await h.waitForMessage(GROUP, /仅管理员或应用归属人可修改群策略/);
		assert.equal((h.config().groupPolicyByChat as Record<string, string> | undefined)?.[GROUP], undefined, "被拒时配置不变");

		await h.message({ chatId: GROUP, chatType: "group", sender: ADMIN, text: "/feishu policy open" });
		await h.waitForMessage(GROUP, /已设置本群策略：open/);
		assert.equal((h.config().groupPolicyByChat as Record<string, string>)[GROUP], "open");
	});
});

test("入口·命令权限：管理类命令对非管理员一律拒绝", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const cases: Array<[string, RegExp]> = [
			["/feishu always", /仅管理员或应用归属人可查看或撤销「始终批准」规则/],
			["/feishu export", /仅管理员或应用归属人可导出诊断包/],
			["/feishu budget 10", /仅管理员或应用归属人可设置费用上限/],
			["/feishu footer off", /仅管理员或应用归属人可修改本会话页脚设置/],
		];
		for (const [text, expected] of cases) {
			await h.message({ chatId: GROUP, chatType: "group", sender: USER, text });
			await h.waitForMessage(GROUP, expected);
		}
	});
});

test("入口·命令权限：/model -g 对非管理员只提示需要管理员，不改全局默认", T, async () => {
	await withHarness(baseConfig, async (h) => {
		await h.message({ chatId: `oc_dm_${USER}`, sender: USER, text: "/model -g x/y" });
		await h.waitForMessage(`oc_dm_${USER}`, /--global\/-g 需要管理员或应用归属人/);
	});
});

// ---------------------------------------------------------------- 群开通审批

test("入口·开通审批：未放行的群里 @ 机器人会发出放行卡；只有审批人能放行，放行后写入配置", T, async () => {
	await withHarness(baseConfig, async (h) => {
		const blocked = "oc_blocked";
		await h.message({ chatId: blocked, chatType: "group", sender: USER, text: "你好" });
		await h.waitForMessage(undefined, /"op":"chat.allow"/);
		const [allow] = h.buttonValues((v) => v.op === "chat.allow");
		assert.equal(allow.value.chatId, blocked);

		const byUser = await h.click({ messageId: allow.messageId, chatId: allow.chatId, operator: USER, value: allow.value });
		assert.equal(toastOf(byUser)?.type, "warning", "普通成员不能放行");
		assert.ok(!(h.config().allowChats as string[]).includes(blocked));

		const byAdmin = await h.click({ messageId: allow.messageId, chatId: allow.chatId, operator: ADMIN, value: allow.value });
		assert.equal(toastOf(byAdmin)?.content, "已放行");
		assert.ok((h.config().allowChats as string[]).includes(blocked), "放行结果写入配置文件");
	});
});

// ---------------------------------------------------------------- 可观测信号

test("入口·可观测：启动日志与 status.json 列出已打开的能力", T, async () => {
	await withHarness({ ...baseConfig, cron: { enabled: true } }, async (h) => {
		const line = h.logs.find((l) => l.event === "feishu.bridge.features");
		assert.deepEqual((line?.meta as { enabled?: string[] })?.enabled, ["cron", "accessRequest"]);
		const status = JSON.parse(readFileSync(join(h.home, "feishu-channel", "status.json"), "utf8"));
		assert.deepEqual(status.features, ["cron", "accessRequest"]);
	});
});
