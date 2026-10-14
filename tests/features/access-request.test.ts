/**
 * 可选能力·群开通申请（onboarding.accessRequest）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Harness } from "../integration/extension-harness.js";
import { ADMIN, GROUP, T, USER, enabledIn, hasLogPrefix, withHarness } from "./helpers.js";

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

const STRANGER = "ou_stranger";
const DM_STRANGER = "oc_dm_stranger";

/** 等到一条 `feishu.access_request.silent`（指定 reason）。 */
async function waitForSilent(h: Harness, reason: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!h.logs.some((l) => l.event === "feishu.access_request.silent" && (l.meta as { reason?: string } | undefined)?.reason === reason)) {
		if (Date.now() > deadline) throw new Error(`没有等到 feishu.access_request.silent（${reason}）`);
		await sleep(10);
	}
}

test("开通申请·关：群名单外的人 @、未放行的人私聊，都不发申请卡", T, async () => {
	await withHarness({ groupRules: { [GROUP]: { policy: "allowlist", allowlist: [ADMIN] } } }, async (h) => {
		await h.message({ chatId: GROUP, chatType: "group", sender: USER, text: "你好" });
		await h.message({ chatId: DM_STRANGER, sender: STRANGER, text: "你好" });
		await sleep(100);
		assert.equal(h.buttonValues((v) => typeof v.op === "string" && v.op.startsWith("user.")).length, 0);
		assert.ok(!hasLogPrefix(h, "feishu.access_request"));
	});
});

test("开通申请·开：群名单外的人 @ → 加入本群名单；未放行的群 → 全局放行此人，不放开私聊", T, async () => {
	await withHarness({ onboarding: { accessRequest: true, accessApprovers: "all" }, groupRules: { [GROUP]: { policy: "allowlist", allowlist: [ADMIN] } } }, async (h) => {
		await h.message({ chatId: GROUP, chatType: "group", sender: USER, text: "你好" });
		await h.waitForMessage(undefined, /"op":"user.allow_chat"/);
		const [allowChat] = h.buttonValues((v) => v.op === "user.allow_chat");
		assert.equal(allowChat.value.kind, "group_user");
		const byUser = await h.click({ messageId: allowChat.messageId, chatId: allowChat.chatId, operator: USER, value: allowChat.value }) as { toast?: { type?: string } };
		assert.equal(byUser?.toast?.type, "warning", "没有审批权的人点不动");
		await h.click({ messageId: allowChat.messageId, chatId: allowChat.chatId, operator: ADMIN, value: allowChat.value });
		assert.deepEqual((h.config().groupRules as Record<string, { allowlist?: string[] }>)[GROUP].allowlist, [ADMIN, USER]);
		await h.waitForMessage(GROUP, /已加入本群名单/);

		await h.message({ chatId: BLOCKED, chatType: "group", sender: STRANGER, text: "你好" });
		await h.waitForMessage(undefined, /"op":"user.allow_all_groups","chatId":"oc_blocked"/);
		const [allowAll] = h.buttonValues((v) => v.op === "user.allow_all_groups" && v.chatId === BLOCKED);
		await h.click({ messageId: allowAll.messageId, chatId: allowAll.chatId, operator: ADMIN, value: allowAll.value });
		assert.deepEqual(h.config().allowUsersAllGroups, [STRANGER]);
		assert.ok(!(h.config().allowChats as string[]).includes(BLOCKED), "没有放行整个群");
		assert.ok(h.hasLog("feishu.access_request.user_allowed"));

		// 全局放行不放开私聊：私聊仍走私聊申请
		await h.message({ chatId: DM_STRANGER, sender: STRANGER, text: "你好" });
		await h.waitForMessage(undefined, /"op":"user.allow_dm"/);
	});
});

test("开通申请·开：未放行的人私聊 → 审批人放行私聊；「暂不放行」后不再申请；每小时总量有上限", T, async () => {
	await withHarness({ onboarding: { accessRequest: true, accessApprovers: "all", accessRequestMaxPerHour: 2 } }, async (h) => {
		await h.message({ chatId: DM_STRANGER, sender: STRANGER, text: "你好" });
		await h.waitForMessage(undefined, /"op":"user.allow_dm"/);
		await h.waitForMessage(DM_STRANGER, /已把申请私聊发给/);
		const [allowDm] = h.buttonValues((v) => v.op === "user.allow_dm");
		await h.click({ messageId: allowDm.messageId, chatId: allowDm.chatId, operator: ADMIN, value: allowDm.value });
		assert.ok((h.config().allowUsers as string[]).includes(STRANGER));
		await h.waitForMessage(DM_STRANGER, /私聊已开通/);

		await h.message({ chatId: "oc_dm_b", sender: "ou_b", text: "你好" });
		await h.waitForMessage(undefined, /"requester":"ou_b"/);
		const [deny] = h.buttonValues((v) => v.op === "user.deny" && v.requester === "ou_b");
		await h.click({ messageId: deny.messageId, chatId: deny.chatId, operator: ADMIN, value: deny.value });
		await h.message({ chatId: "oc_dm_b", sender: "ou_b", text: "再试一次" });
		await waitForSilent(h, "ignored");

		await h.message({ chatId: "oc_dm_c", sender: "ou_c", text: "你好" });
		await waitForSilent(h, "rate_limited");
		assert.equal(h.buttonValues((v) => v.requester === "ou_c").length, 0, "超出上限不发卡");
	});
});
