/**
 * 群开通申请（`onboarding.accessRequest`，默认关）：未放行的群里有人 @ 机器人时，
 * 给有审批权的人发一张开通申请卡（审批人在群里就在群里 @ 他们，否则私聊），
 * 同一个群在冷却期内只申请一次；审批人可以「放行」或「暂不放行」。
 *
 * 关闭时沿用旧行为：只有有审批权的人 @ 机器人，才私聊他一张放行卡（由入口处理）。
 */
import { buildAccessNoticeCard, buildAccessRequestCard, buildResultCard, atList } from "../commands/cards.js";
import { effectiveAdmins } from "../inbound/admit.js";
import { AccessRequestTracker, planAccessRequest } from "../runtime/access-request.js";
import { accessApproverHint, accessApprovers, canApproveAccess } from "../runtime/admin-roles.js";
import type { FeishuInboundMessage } from "../types.js";
import type { BridgeFeature, FeatureContext } from "./feature.js";

export const accessRequestFeature: BridgeFeature = {
	name: "accessRequest",
	enabled: (config) => config.onboarding?.accessRequest === true,
	setup(ctx) {
		const { rt, log, onboarding } = ctx;
		// 限流状态跨重启保留（放行卡与退群时入口也会清理它）
		rt.accessRequests ??= new AccessRequestTracker({ cooldownMs: rt.config.onboarding?.accessRequestCooldownMs });
		const tracker = rt.accessRequests;
		return {
			onAdmissionDrop: async (msg) => {
				await requestChatAccess(ctx, tracker, msg);
				return true;
			},
			cardOps: {
				// 开通申请：暂不放行（忽略期内该群不再发申请）
				"chat.deny": async (action, value) => {
					if (typeof value.chatId !== "string" || !value.chatId.startsWith("oc_")) return undefined;
					if (!canApproveAccess(rt.config, action.operatorOpenId, onboarding.approverPolicy())) return { toast: { type: "warning", content: `${accessApproverHint(onboarding.approverPolicy())}可以操作` } };
					rt.accessRequests ??= new AccessRequestTracker({ cooldownMs: rt.config.onboarding?.accessRequestCooldownMs });
					rt.accessRequests.markIgnored(value.chatId);
					log.info("feishu.access_request.denied", { chatId: value.chatId, operator: action.operatorOpenId });
					const requester = typeof value.requester === "string" && value.requester.startsWith("ou_") ? value.requester : undefined;
					// 私聊审批时申请人看不到这张卡 → 在群里告诉他；群里审批时卡片本身就会变成结果
					if (requester && action.chatId !== value.chatId) {
						void onboarding.sendChatCard(value.chatId, buildAccessNoticeCard(`${atList([requester])} ${onboarding.operatorByRole(action.operatorOpenId)} 暂未开通本群。`, "grey"), {}, "denied_notice");
					}
					return {
						toast: { type: "info", content: "已暂不放行" },
						card: { type: "raw", data: buildResultCard(`已暂不放行群 \`${value.chatId}\`（24 小时内该群的开通申请不再提醒）。`, "grey") },
					};
				},
			},
		};
	},
};

/**
 * 开通申请：未放行的群里有人 @ 机器人。
 * 管理员（归属人/协作者/admins）有人在群里 → 群里弹审批卡并 @ 他们（回复申请人那条消息）；
 * 否则私聊应用归属人，群里回告申请人"已发给谁"。同一个群冷却期内只申请一次。
 */
async function requestChatAccess({ rt, log, onboarding }: FeatureContext, tracker: AccessRequestTracker, msg: FeishuInboundMessage): Promise<void> {
	if (!rt.transport) return;
	const replyOpts = { replyTo: msg.messageId, ...(msg.threadId ? { threadId: msg.threadId } : {}) };
	const decision = tracker.decide(msg.chatId, msg.senderId);
	if (decision.action === "silent") {
		log.info("feishu.access_request.silent", { chatId: msg.chatId, requester: msg.senderId, reason: decision.reason });
		return;
	}
	if (decision.action === "remind") {
		const whom = decision.mode === "group" ? onboarding.atByRole(decision.approvers) : await onboarding.approverNames(decision.approvers);
		await onboarding.sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群的开通申请已发给 ${whom}${decision.mode === "dm" ? "（私聊）" : ""}，正在等待审批，通过后我会在群里通知。`), replyOpts, "remind");
		return;
	}
	const members = await rt.transport.listChatMemberIds(msg.chatId);
	const policy = onboarding.approverPolicy();
	const eligible = accessApprovers(rt.config, effectiveAdmins(rt.config), policy);
	const plan = planAccessRequest({
		admins: eligible,
		ownerId: rt.config.appOwnerId && eligible.includes(rt.config.appOwnerId) ? rt.config.appOwnerId : undefined,
		collaboratorIds: rt.config.appCollaboratorIds?.filter((id) => eligible.includes(id)),
		groupMembers: members, requesterId: msg.senderId,
	});
	if (plan.mode === "none") {
		log.warn("feishu.access_request.no_approver", {
			chatId: msg.chatId, policy,
			hint: policy === "owner"
				? "accessApprovers=owner 但没有查到应用归属人（需要 application:application:readonly 权限）；或把 onboarding.accessApprovers 放宽"
				: "按 onboarding.accessApprovers 没有任何可审批的人（查询归属人/协作者失败且 config.admins 为空）",
		});
		await onboarding.sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群还没有开通机器人，暂时找不到可以审批的人，请联系应用归属人开通。`, "grey"), replyOpts, "no_approver");
		return;
	}
	tracker.markRequested(msg.chatId, msg.senderId, plan);
	if (plan.mode === "group") {
		const ok = await onboarding.sendChatCard(msg.chatId, buildAccessRequestCard({ mode: "group", chatId: msg.chatId, requesterId: msg.senderId, approvers: plan.approvers, approverLabel: onboarding.atByRole(plan.approvers), approverHint: accessApproverHint(policy) }), replyOpts, "request_in_group");
		if (!ok) tracker.clear(msg.chatId);
		log.info("feishu.access_request.sent", { chatId: msg.chatId, mode: "group", approvers: plan.approvers.length, ok, membersKnown: Boolean(members) });
		return;
	}
	const chatName = await rt.transport.getChatName(msg.chatId);
	const sent = await onboarding.dmAdmins(plan.approvers, buildAccessRequestCard({ mode: "dm", chatId: msg.chatId, chatName, requesterId: msg.senderId, approvers: plan.approvers, approverLabel: onboarding.atByRole(plan.approvers), approverHint: accessApproverHint(policy) }), "access_request");
	if (sent === 0) {
		tracker.clear(msg.chatId);
		await onboarding.sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群还没有开通机器人，暂时联系不上管理员，请直接联系管理员开通。`, "grey"), replyOpts, "request_failed");
		return;
	}
	await onboarding.sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群还没有开通机器人，已把开通申请私聊发给 ${await onboarding.approverNames(plan.approvers)}，审批通过后我会在群里通知你。`), replyOpts, "request_notice");
	log.info("feishu.access_request.sent", { chatId: msg.chatId, mode: "dm", approvers: plan.approvers.length, delivered: sent, membersKnown: Boolean(members) });
}
