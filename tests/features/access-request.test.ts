/**
 * 可选能力·群开通申请（onboarding.accessRequest）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN, T, USER, enabledIn, hasLogPrefix, withHarness } from "./helpers.js";

const BLOCKED = "oc_blocked";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("群开通申请·关：普通成员 @ 不发申请卡；有审批权的人 @ 时私聊他放行卡（旧行为）", T, async () => {
	await withHarness({ onboarding: { accessApprovers: "all" } }, async (h) => {
		await h.message({ chatId: BLOCKED, chatType: "group", sender: USER, text: "你好" });
		await sleep(100);
		assert.equal(h.buttonValues((v) => v.op === "chat.allow").length, 0);
		assert.ok(!hasLogPrefix(h, "feishu.access_request"));

		await h.message({ chatId: BLOCKED, chatType: "group", sender: ADMIN, text: "你好" });
		await h.waitForMessage(undefined, /"op":"chat.allow"/);
		assert.ok(h.hasLog("feishu.onboarding.allow_prompt"));
		assert.equal(h.buttonValues((v) => v.op === "chat.deny").length, 0, "旧行为的放行卡没有「暂不放行」");
		assert.ok(!enabledIn(h).status.includes("accessRequest"));
	});
});

test("群开通申请·开：普通成员 @ 发出申请卡；审批人「暂不放行」后冷却期内不再申请", T, async () => {
	await withHarness({ onboarding: { accessRequest: true, accessApprovers: "all" } }, async (h) => {
		assert.ok(enabledIn(h).status.includes("accessRequest"));
		await h.message({ chatId: BLOCKED, chatType: "group", sender: USER, text: "你好" });
		await h.waitForMessage(undefined, /"op":"chat.deny"/);
		assert.ok(h.hasLog("feishu.access_request.sent"));

		const [deny] = h.buttonValues((v) => v.op === "chat.deny");
		const byAdmin = await h.click({ messageId: deny.messageId, chatId: deny.chatId, operator: ADMIN, value: deny.value }) as { toast?: { content?: string } };
		assert.equal(byAdmin?.toast?.content, "已暂不放行");
		assert.ok(h.hasLog("feishu.access_request.denied"));

		await h.message({ chatId: BLOCKED, chatType: "group", sender: USER, text: "再试一次" });
		const deadline = Date.now() + 3_000;
		while (!h.hasLog("feishu.access_request.silent")) {
			if (Date.now() > deadline) throw new Error("没有等到 feishu.access_request.silent");
			await sleep(10);
		}
	});
});
