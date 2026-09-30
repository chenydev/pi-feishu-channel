/**
 * 会议邀请（`meetingInvite.enabled`，默认关）：把机器人拉进视频会议时，
 * 在邀请人的私聊里开一轮任务（邀请人需通过私聊准入）。
 */
import { formatTimeInZone } from "../config.js";
import { effectiveAdmins } from "../inbound/admit.js";
import { buildMeetingInvitePrompt, meetingInviteKey, type MeetingInvite } from "../inbound/meeting-invite.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import type { BridgeFeature } from "./feature.js";
import { createFirstSeen } from "./first-seen.js";

export const meetingInviteFeature: BridgeFeature = {
	name: "meetingInvite",
	enabled: (config) => config.meetingInvite?.enabled === true,
	setup({ rt, log }) {
		const firstSeen = createFirstSeen();
		return {
			onLifecycleEvent: async (event) => {
				if (event.type === "meeting_invite") await handleMeetingInvite(rt, log, firstSeen, event.invite);
			},
		};
	},
};

/** 会议邀请 → 邀请人私聊里开一轮任务（邀请人需通过私聊准入）。 */
async function handleMeetingInvite(rt: BridgeRuntime, log: BridgeLogger, firstSeen: (key: string) => boolean, invite: MeetingInvite): Promise<void> {
	if (!rt.transport || !rt.convManager) return;
	const allowed = rt.config.allowUsers.includes(invite.inviterOpenId) || effectiveAdmins(rt.config).includes(invite.inviterOpenId);
	if (!allowed) {
		log.info("feishu.meeting_invite.denied", { meetingNo: invite.meetingNo, inviter: invite.inviterOpenId, hint: "邀请人不是管理员，也不在 allowUsers 里（回复要走私聊）" });
		return;
	}
	if (!firstSeen(meetingInviteKey(invite))) return;
	const sent = await rt.transport.sendToUserDetailed(invite.inviterOpenId, "text", { text: `收到会议邀请「${invite.topic ?? invite.meetingNo}」，正在处理…` });
	if (!sent.chatId) {
		log.warn("feishu.meeting_invite.no_p2p_chat", { meetingNo: invite.meetingNo });
		return;
	}
	log.info("feishu.meeting_invite.accepted", { meetingNo: invite.meetingNo, chatId: sent.chatId });
	await rt.convManager.route({
		messageId: `meeting:${meetingInviteKey(invite)}`,
		chatId: sent.chatId, chatType: "p2p",
		senderId: invite.inviterOpenId, ...(invite.inviterName ? { senderName: invite.inviterName } : {}),
		isBot: false, msgType: "text",
		text: buildMeetingInvitePrompt(invite, (ms) => formatTimeInZone(ms, rt.config.timezone)),
		mentions: [], resources: [], raw: undefined, ts: Date.now(),
		synthetic: true, replyTarget: sent.messageId,
	}, { behavior: "queue" });
}
