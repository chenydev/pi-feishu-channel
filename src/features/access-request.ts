/**
 * 开通申请（`onboarding.accessRequest`，默认关）：没有权限的人找机器人时，给有审批权的人发一张开通申请卡
 * （审批人在群里就在群里 @ 他们，否则私聊），审批后回告申请人。三种申请，审批人可选的放行方式不同：
 * - 未放行的群里 @ 机器人：放行此群 / 全局放行此人 / 暂不放行；
 * - 群名单（`groupRules.<id>.allowlist`）外的人 @ 机器人：加入本群名单 / 全局放行此人 / 暂不放行；
 * - 未放行的人私聊机器人：放行私聊 / 暂不放行。
 * 「全局放行此人」写入 `allowUsersAllGroups`：所有群都能用，私聊不放开。
 *
 * 限流见 `runtime/access-request.ts`：同一项申请冷却期内只发一次，「暂不放行」后忽略 24 小时，每小时总量有上限。
 *
 * 关闭时沿用旧行为：只有有审批权的人在未放行的群里 @ 机器人，才私聊他一张放行卡（由入口处理）。
 */
import { buildAccessNoticeCard, buildAccessRequestCard, buildResultCard, atList } from "../commands/cards.js";
import { saveConfigFields } from "../config.js";
import { effectiveAdmins } from "../inbound/admit.js";
import { AccessRequestTracker, accessRequestKey, planAccessRequest, type AccessRequestKind } from "../runtime/access-request.js";
import { accessApproverHint, accessApprovers, canApproveAccess } from "../runtime/admin-roles.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { FeishuInboundMessage } from "../types.js";
import type { BridgeFeature, FeatureContext } from "./feature.js";

export const accessRequestFeature: BridgeFeature = {
	name: "accessRequest",
	enabled: (config) => config.onboarding?.accessRequest === true,
	setup(ctx) {
		const { rt, log, onboarding } = ctx;
		const denied = (operator: string) => canApproveAccess(rt.config, operator, onboarding.approverPolicy())
			? undefined
			: { toast: { type: "warning", content: `${accessApproverHint(onboarding.approverPolicy())}可以操作` } };
		return {
			onAdmissionDrop: async (msg, kind) => {
				await requestAccess(ctx, trackerOf(rt), msg, kind);
				return true;
			},
			cardOps: {
				// 群开通申请：暂不放行（忽略期内该群不再发申请）
				"chat.deny": async (action, value) => {
					if (typeof value.chatId !== "string" || !value.chatId.startsWith("oc_")) return undefined;
					const refused = denied(action.operatorOpenId);
					if (refused) return refused;
					trackerOf(rt).markIgnored(value.chatId);
					log.info("feishu.access_request.denied", { chatId: value.chatId, kind: "chat", operator: action.operatorOpenId });
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
				// 个人申请（群名单外 / 私聊）：暂不放行（忽略期内这个人的这项申请不再发）
				"user.deny": async (action, value) => {
					const req = requestOf(value);
					if (!req || req.kind === "chat") return undefined;
					const refused = denied(action.operatorOpenId);
					if (refused) return refused;
					trackerOf(rt).markIgnored(accessRequestKey(req.kind, req.chatId, req.requester));
					log.info("feishu.access_request.denied", { chatId: req.chatId, kind: req.kind, requester: req.requester, operator: action.operatorOpenId });
					if (action.chatId !== req.chatId) {
						const text = req.kind === "dm"
							? `${onboarding.operatorByRole(action.operatorOpenId)} 暂未开通你的私聊。`
							: `${atList([req.requester])} ${onboarding.operatorByRole(action.operatorOpenId)} 暂未放行你在本群使用机器人。`;
						void onboarding.sendChatCard(req.chatId, buildAccessNoticeCard(text, "grey", noticeTitle(req.kind)), {}, "denied_notice");
					}
					return {
						toast: { type: "info", content: "已暂不放行" },
						card: { type: "raw", data: buildResultCard(`已暂不放行 ${atList([req.requester])}（24 小时内这项申请不再提醒）。`, "grey") },
					};
				},
				// 全局放行此人：所有群都能用（写入 allowUsersAllGroups），私聊不放开
				"user.allow_all_groups": async (action, value) => {
					const req = requestOf(value);
					if (!req || req.kind === "dm") return undefined;
					const refused = denied(action.operatorOpenId);
					if (refused) return refused;
					const result = addUser(rt, "allowUsersAllGroups", req.requester);
					if (result === "failed") return { toast: { type: "error", content: "写入配置失败，未放行" } };
					trackerOf(rt).clear(accessRequestKey(req.kind, req.chatId, req.requester));
					if (result === "exists") return { card: { type: "raw", data: buildResultCard(`${atList([req.requester])} 已在全局放行名单中。`, "grey") } };
					log.info("feishu.access_request.user_allowed", { scope: "all_groups", chatId: req.chatId, requester: req.requester, operator: action.operatorOpenId });
					void onboarding.sendChatCard(req.chatId, buildAccessNoticeCard(`${atList([req.requester])} 已被全局放行（由 ${onboarding.operatorByRole(action.operatorOpenId)} 放行），现在在任何群里 @ 我都可以使用。`, "green", "已开通"), {}, "allowed_notice");
					return {
						toast: { type: "success", content: "已全局放行" },
						card: { type: "raw", data: buildResultCard(`已全局放行 ${atList([req.requester])}（写入 allowUsersAllGroups）：他在所有群里 @ 机器人都能用，私聊不放开。`) },
					};
				},
				// 加入本群名单（groupRules.<群id>.allowlist）
				"user.allow_chat": async (action, value) => {
					const req = requestOf(value);
					if (req?.kind !== "group_user") return undefined;
					const refused = denied(action.operatorOpenId);
					if (refused) return refused;
					const result = addToChatAllowlist(rt, req.chatId, req.requester);
					if (result === "failed") return { toast: { type: "error", content: "写入配置失败，未放行" } };
					trackerOf(rt).clear(accessRequestKey(req.kind, req.chatId, req.requester));
					if (result === "exists") return { card: { type: "raw", data: buildResultCard(`${atList([req.requester])} 已在本群名单中。`, "grey") } };
					log.info("feishu.access_request.user_allowed", { scope: "chat", chatId: req.chatId, requester: req.requester, operator: action.operatorOpenId });
					void onboarding.sendChatCard(req.chatId, buildAccessNoticeCard(`${atList([req.requester])} 已加入本群名单（由 ${onboarding.operatorByRole(action.operatorOpenId)} 放行），现在 @ 我就可以使用了。`, "green", "已开通"), {}, "allowed_notice");
					return {
						toast: { type: "success", content: "已加入本群名单" },
						card: { type: "raw", data: buildResultCard(`已把 ${atList([req.requester])} 加入群 \`${req.chatId}\` 的名单（写入 groupRules）。`) },
					};
				},
				// 放行私聊（allowUsers）
				"user.allow_dm": async (action, value) => {
					const req = requestOf(value);
					if (req?.kind !== "dm") return undefined;
					const refused = denied(action.operatorOpenId);
					if (refused) return refused;
					const result = addUser(rt, "allowUsers", req.requester);
					if (result === "failed") return { toast: { type: "error", content: "写入配置失败，未放行" } };
					trackerOf(rt).clear(accessRequestKey(req.kind, req.chatId, req.requester));
					if (result === "exists") return { card: { type: "raw", data: buildResultCard(`${atList([req.requester])} 的私聊已开通。`, "grey") } };
					log.info("feishu.access_request.user_allowed", { scope: "dm", requester: req.requester, operator: action.operatorOpenId });
					void onboarding.sendChatCard(req.chatId, buildAccessNoticeCard(`私聊已开通（由 ${onboarding.operatorByRole(action.operatorOpenId)} 放行），直接发消息给我就行，/help 查看可用命令。`, "green", "私聊已开通"), {}, "allowed_notice");
					return {
						toast: { type: "success", content: "已放行私聊" },
						card: { type: "raw", data: buildResultCard(`已放行 ${atList([req.requester])} 私聊机器人（写入 allowUsers）。`) },
					};
				},
			},
		};
	},
};

/** 限流状态挂在运行时上，跨桥重启保留（放行群、退群时入口也会清理它）。 */
function trackerOf(rt: BridgeRuntime): AccessRequestTracker {
	rt.accessRequests ??= new AccessRequestTracker({
		cooldownMs: rt.config.onboarding?.accessRequestCooldownMs,
		maxPerHour: rt.config.onboarding?.accessRequestMaxPerHour,
	});
	return rt.accessRequests;
}

/** 按钮值里的申请信息（缺省 kind 按群申请处理：旧卡片没有这个字段）。 */
function requestOf(value: Record<string, unknown>): { chatId: string; requester: string; kind: AccessRequestKind } | undefined {
	const { chatId, requester } = value;
	if (typeof chatId !== "string" || !chatId.startsWith("oc_") || typeof requester !== "string" || !requester.startsWith("ou_")) return undefined;
	const kind = value.kind === "group_user" || value.kind === "dm" ? value.kind : "chat";
	return { chatId, requester, kind };
}

function noticeTitle(kind: AccessRequestKind): string {
	return kind === "dm" ? "私聊开通申请" : "机器人开通申请";
}

/** 把 open_id 加进名单并写回配置；写失败时恢复内存里的值。 */
function addUser(rt: BridgeRuntime, field: "allowUsers" | "allowUsersAllGroups", openId: string): "added" | "exists" | "failed" {
	const previous = rt.config[field] ?? [];
	if (previous.includes(openId)) return "exists";
	rt.config[field] = [...previous, openId];
	if (saveConfigFields(rt.homeDir, rt.config, [field])) return "added";
	rt.config[field] = previous;
	return "failed";
}

function addToChatAllowlist(rt: BridgeRuntime, chatId: string, openId: string): "added" | "exists" | "failed" {
	const previous = rt.config.groupRules;
	const rule = previous[chatId] ?? {};
	if (rule.allowlist?.includes(openId)) return "exists";
	rt.config.groupRules = { ...previous, [chatId]: { ...rule, allowlist: [...(rule.allowlist ?? []), openId] } };
	if (saveConfigFields(rt.homeDir, rt.config, ["groupRules"])) return "added";
	rt.config.groupRules = previous;
	return "failed";
}

/** 三种申请在回告里的说法。 */
const SUBJECT: Record<AccessRequestKind, { blocked: string; request: string }> = {
	chat: { blocked: "本群还没有开通机器人", request: "本群的开通申请" },
	group_user: { blocked: "你还不在本群的使用名单里", request: "你的使用申请" },
	dm: { blocked: "私聊还没有开通", request: "你的私聊开通申请" },
};

/**
 * 发出开通申请：
 * 管理员（归属人/应用管理员/admins）有人在群里 → 群里弹审批卡并 @ 他们（回复申请人那条消息）；
 * 否则（私聊申请总是如此）私聊应用归属人，并告诉申请人"已发给谁"。同一项申请冷却期内只发一次。
 */
async function requestAccess({ rt, log, onboarding }: FeatureContext, tracker: AccessRequestTracker, msg: FeishuInboundMessage, kind: AccessRequestKind): Promise<void> {
	if (!rt.transport) return;
	const key = accessRequestKey(kind, msg.chatId, msg.senderId);
	const inGroup = kind !== "dm";
	const replyOpts = inGroup ? { replyTo: msg.messageId, ...(msg.threadId ? { threadId: msg.threadId } : {}) } : {};
	// 群里回告要 @ 申请人（不 @ 他看不到提醒）；私聊不用
	const toRequester = inGroup ? `${atList([msg.senderId])} ` : "";
	const subject = SUBJECT[kind];
	const title = noticeTitle(kind);
	const decision = tracker.decide(key, msg.senderId);
	if (decision.action === "silent") {
		log.info("feishu.access_request.silent", { chatId: msg.chatId, kind, requester: msg.senderId, reason: decision.reason });
		return;
	}
	if (decision.action === "remind") {
		const whom = decision.mode === "group" ? onboarding.atByRole(decision.approvers) : await onboarding.approverNames(decision.approvers);
		await onboarding.sendChatCard(msg.chatId, buildAccessNoticeCard(`${toRequester}${subject.request}已发给 ${whom}${decision.mode === "dm" ? "（私聊）" : ""}，正在等待审批，通过后我会通知你。`, "blue", title), replyOpts, "remind");
		return;
	}
	const members = inGroup ? await rt.transport.listChatMemberIds(msg.chatId) : undefined;
	const policy = onboarding.approverPolicy();
	const eligible = accessApprovers(rt.config, effectiveAdmins(rt.config), policy);
	const plan = planAccessRequest({
		admins: eligible,
		ownerId: rt.config.appOwnerId && eligible.includes(rt.config.appOwnerId) ? rt.config.appOwnerId : undefined,
		appAdminIds: rt.config.appAdminIds?.filter((id) => eligible.includes(id)),
		groupMembers: members, requesterId: msg.senderId,
	});
	if (plan.mode === "none") {
		log.warn("feishu.access_request.no_approver", {
			chatId: msg.chatId, kind, policy,
			hint: policy === "owner"
				? "accessApprovers=owner 但没有查到应用归属人（需要 application:application:readonly 权限）；或把 onboarding.accessApprovers 放宽"
				: "按 onboarding.accessApprovers 没有任何可审批的人（查询归属人/应用管理员失败且 config.admins 为空）",
		});
		await onboarding.sendChatCard(msg.chatId, buildAccessNoticeCard(`${toRequester}${subject.blocked}，暂时找不到可以审批的人，请联系应用归属人开通。`, "grey", title), replyOpts, "no_approver");
		return;
	}
	tracker.markRequested(key, msg.senderId, plan);
	const card = (mode: "group" | "dm", chatName?: string) => buildAccessRequestCard({
		kind, mode, chatId: msg.chatId, chatName, requesterId: msg.senderId, approvers: plan.approvers,
		approverLabel: onboarding.atByRole(plan.approvers), approverHint: accessApproverHint(policy),
	});
	if (plan.mode === "group") {
		const ok = await onboarding.sendChatCard(msg.chatId, card("group"), replyOpts, "request_in_group");
		if (!ok) tracker.clear(key);
		log.info("feishu.access_request.sent", { chatId: msg.chatId, kind, mode: "group", approvers: plan.approvers.length, ok, membersKnown: Boolean(members) });
		return;
	}
	const chatName = inGroup ? await rt.transport.getChatName(msg.chatId) : undefined;
	const sent = await onboarding.dmAdmins(plan.approvers, card("dm", chatName), "access_request");
	if (sent === 0) {
		tracker.clear(key);
		await onboarding.sendChatCard(msg.chatId, buildAccessNoticeCard(`${toRequester}${subject.blocked}，暂时联系不上管理员，请直接联系管理员开通。`, "grey", title), replyOpts, "request_failed");
		return;
	}
	await onboarding.sendChatCard(msg.chatId, buildAccessNoticeCard(`${toRequester}${subject.blocked}，已把申请私聊发给 ${await onboarding.approverNames(plan.approvers)}，审批通过后我会通知你。`, "blue", title), replyOpts, "request_notice");
	log.info("feishu.access_request.sent", { chatId: msg.chatId, kind, mode: "dm", approvers: plan.approvers.length, delivered: sent, membersKnown: Boolean(members) });
}
