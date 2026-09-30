/**
 * 可选能力·桥自身告警（alerts.enabled）：开、关两种配置。
 * 用「审批积压」触发：阈值设为 1，挂起一个等待审批的工具调用，等下一次心跳。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Harness } from "../integration/extension-harness.js";
import { T, USER, enabledIn, hasLogPrefix, withHarness } from "./helpers.js";

async function holdApproval(h: Harness): Promise<void> {
	const chatId = "oc_dm_alerts";
	await h.message({ chatId, sender: USER, text: "写个文件" });
	const deadline = Date.now() + 3_000;
	while (!h.sessions.prompts.some((p) => p.conversationKey === chatId)) {
		if (Date.now() > deadline) throw new Error("会话没有开始执行");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	// 不等待结果：审批卡一直挂着，形成积压
	void h.pi.emit("tool_call", { toolCallId: "c1", toolName: "write", input: { path: "a" } }, { cwd: "/", sessionManager: { getSessionId: () => h.sessions.sessionIdFor(chatId) } });
	await h.waitForMessage(chatId, /"op":"approval"/);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("告警·关：审批积压也不告警，不出现在已启用能力里", T, async () => {
	await withHarness({ allowUsers: [USER, "ou_admin"], statusHeartbeatMs: 30, alerts: { enabled: false, pendingApprovals: 1 } }, async (h) => {
		await holdApproval(h);
		await sleep(150);
		assert.ok(!hasLogPrefix(h, "feishu.alert"));
		assert.ok(!enabledIn(h).status.includes("alerts"));
	});
});

test("告警·开：审批积压越过阈值后在心跳里告警", T, async () => {
	await withHarness({ allowUsers: [USER, "ou_admin"], statusHeartbeatMs: 30, alerts: { enabled: true, pendingApprovals: 1 } }, async (h) => {
		assert.ok(enabledIn(h).status.includes("alerts"));
		await holdApproval(h);
		const deadline = Date.now() + 3_000;
		while (!h.hasLog("feishu.alert")) {
			if (Date.now() > deadline) throw new Error("没有等到告警");
			await sleep(20);
		}
		const alert = h.logs.find((l) => l.event === "feishu.alert");
		assert.equal((alert?.meta as { kind?: string })?.kind, "approvals_backlog");
	});
});
