/**
 * 可选能力·会议邀请（meetingInvite.enabled）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { T, enabledIn, hasLogPrefix, withHarness } from "./helpers.js";

const inviteFrom = (inviter: string) => ({
	event_id: `ev_${inviter}`,
	meeting: { id: "m1", meeting_no: "123456789", topic: "周会" },
	inviter: { id: { open_id: inviter }, user_name: "某人" },
});

test("会议邀请·关：邀请事件被忽略，没有任何会议邀请日志", T, async () => {
	await withHarness({}, async (h) => {
		await h.event("vc.bot.meeting_invited_v1", inviteFrom("ou_stranger"));
		assert.ok(!hasLogPrefix(h, "feishu.meeting_invite"));
		assert.ok(!enabledIn(h).status.includes("meetingInvite"));
	});
});

test("会议邀请·开：邀请人未通过私聊准入时拒绝并说明原因", T, async () => {
	await withHarness({ meetingInvite: { enabled: true } }, async (h) => {
		assert.ok(enabledIn(h).status.includes("meetingInvite"));
		await h.event("vc.bot.meeting_invited_v1", inviteFrom("ou_stranger"));
		const denied = h.logs.find((l) => l.event === "feishu.meeting_invite.denied");
		assert.ok(denied, "应记录 feishu.meeting_invite.denied");
		assert.match(String((denied.meta as { hint?: string }).hint), /allowUsers/);
	});
});
