/**
 * 平台事件的核心处理（不依赖任何可选能力）：
 * - 撤回：还在合批窗口就移除，排队中就出队，执行中只停本轮；
 * - 机器人入群：已放行的群发欢迎卡；未放行的群私聊审批人一张「放行此群」卡；
 * - 退群、私聊首次进入（欢迎语）、对回复的 👍/👎 反馈；
 * - 未放行的群里有审批权的人 @ 机器人：私聊他放行卡（开了群开通申请时交给该能力）；
 * - 「放行此群」按钮。
 *
 * 核心处理完之后，事件再交给各可选能力（云文档评论、会议邀请等）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atList, buildAccessNoticeCard, buildAllowChatCard, buildResultCard, buildWelcomeCard } from "../commands/cards.js";
import { resolvePaths, saveConfigFields } from "../config.js";
import type { FeatureHost } from "../features/feature.js";
import { effectiveAdmins } from "../inbound/admit.js";
import type { LifecycleEvent } from "../inbound/transport.js";
import { accessApproverHint, accessApprovers, canApproveAccess } from "../runtime/admin-roles.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import type { Onboarding } from "../runtime/onboarding.js";
import type { FeishuInboundMessage } from "../types.js";
import type { CardOps } from "./card-router.js";

export class PlatformEvents {
	/** 同一群的放行提示 1 小时内只发一次。 */
	private readonly allowPromptSentAt = new Map<string, number>();

	constructor(
		private readonly rt: BridgeRuntime,
		private readonly log: BridgeLogger,
		private readonly onboarding: Onboarding,
		private readonly features: FeatureHost,
	) {}

	/** 平台生命周期事件：先走核心处理，再交给各可选能力。 */
	async handle(event: LifecycleEvent): Promise<void> {
		await this.handleCore(event);
		await this.features.onLifecycleEvent(event);
	}

	/** 核心卡片按钮：私聊或群里的「放行此群」。 */
	cardOps(): CardOps {
		return {
			"chat.allow": async (action, value) => {
				if (typeof value.chatId !== "string" || !value.chatId.startsWith("oc_")) return undefined;
				if (!canApproveAccess(this.rt.config, action.operatorOpenId, this.onboarding.approverPolicy())) return { toast: { type: "warning", content: `${accessApproverHint(this.onboarding.approverPolicy())}可以放行群` } };
				if (this.rt.config.allowChats.includes(value.chatId)) return { card: { type: "raw", data: buildResultCard(`群 \`${value.chatId}\` 已在放行列表中。`, "grey") } };
				const previous = [...this.rt.config.allowChats];
				this.rt.config.allowChats = [...this.rt.config.allowChats, value.chatId];
				if (!saveConfigFields(this.rt.homeDir, this.rt.config, ["allowChats"])) {
					this.rt.config.allowChats = previous;
					return { toast: { type: "error", content: "写入配置失败，未放行" } };
				}
				this.log.info("feishu.onboarding.chat_allowed", { chatId: value.chatId, operator: action.operatorOpenId });
				this.rt.accessRequests?.clear(value.chatId);
				// 群里回告：申请人（有的话）+ 放行人
				const requester = typeof value.requester === "string" && value.requester.startsWith("ou_") ? value.requester : undefined;
				void this.onboarding.sendChatCard(value.chatId, buildAccessNoticeCard(`${requester ? `${atList([requester])} ` : ""}本群已开通（由 ${this.onboarding.operatorByRole(action.operatorOpenId)} 放行），现在 @ 我就可以使用了。`, "green"), {}, "allowed_notice");
				return {
					toast: { type: "success", content: "已放行" },
					card: { type: "raw", data: buildResultCard(`已放行群 \`${value.chatId}\`（写入 allowChats）。群里 @ 机器人即可使用。`) },
				};
			},
		};
	}

	/** 群未放行时，有审批权的人 @ 了机器人 → 私聊他一张"放行此群"卡。普通成员 @ 不回复，只记日志。 */
	async onAdmissionDrop(msg: FeishuInboundMessage, reason: string, mentioned: boolean): Promise<void> {
		if (reason !== "not_allowlisted" || msg.chatType === "p2p" || !mentioned || this.rt.config.allowChats.includes(msg.chatId)) return;
		// 开了群开通申请：由该能力处理（给审批人发申请卡）
		if (await this.features.onAdmissionDrop(msg)) return;
		if (this.rt.config.onboarding?.notifyAdmins === false) return;
		// 旧行为（未开开通申请）：有审批权的人 @ 了机器人 → 私聊他放行卡（没审批权就不发一张点不动的卡）
		if (!canApproveAccess(this.rt.config, msg.senderId, this.onboarding.approverPolicy())) return;
		const last = this.allowPromptSentAt.get(msg.chatId);
		if (last && Date.now() - last < 3_600_000) return;
		this.allowPromptSentAt.set(msg.chatId, Date.now());
		const chatName = await this.rt.transport?.getChatName(msg.chatId);
		const operatorName = await this.rt.transport?.resolveUserName(msg.senderId).catch(() => undefined);
		await this.onboarding.dmAdmins([msg.senderId], buildAllowChatCard({ chatId: msg.chatId, chatName, reason: "管理员在群里 @ 了机器人", operatorName }), "allow_chat");
		this.log.info("feishu.onboarding.allow_prompt", { chatId: msg.chatId, operator: msg.senderId });
	}

	/** 撤回、入群/退群、私聊进入、表情。 */
	private async handleCore(event: LifecycleEvent): Promise<void> {
		switch (event.type) {
			case "recalled": {
				// 还在合批窗口 → 直接移除；排队 → 出队；执行中 → 只停本轮（同 /stop）
				if (this.rt.pipeline?.cancelBatched(event.messageId)) return;
				const result = await this.rt.convManager?.cancelByMessageId(event.messageId);
				this.log.info("feishu.recall", { messageId: event.messageId, status: result?.status ?? "none" });
				if (result?.status === "aborted" && result.chatId && this.rt.outbox) {
					this.rt.outbox.enqueue(result.chatId, `已按撤回取消本轮任务${result.sideEffects ? "（本轮已执行过工具，可能已经产生了副作用）" : ""}。`, { threadId: result.threadId }, {
						dedupeKey: `${event.messageId}:recalled`, laneKey: result.conversationKey ?? result.chatId, kind: "notify",
					});
				}
				return;
			}
			case "bot_added": {
				this.rt.knownChats?.add(event.chatId);
				this.log.info("feishu.onboarding.bot_added", { chatId: event.chatId, operator: event.operatorOpenId ?? null });
				if (this.rt.config.allowChats.includes(event.chatId)) {
					if (this.rt.config.onboarding?.welcome === false || !this.rt.transport) return;
					const policy = this.rt.config.groupRules[event.chatId]?.policy ?? this.rt.config.groupPolicyByChat[event.chatId] ?? this.rt.config.defaultGroupPolicy ?? this.rt.config.groupPolicy;
					const trigger = policy === "open" ? "直接发消息即可" : policy === "admin_only" ? "仅管理员 @ 我" : policy === "disabled" ? "本群已停用" : "在群里 @ 我";
					try {
						await this.rt.transport.sendCard(event.chatId, buildWelcomeCard({ botName: this.rt.transport.getBotIdentity().name, trigger, ctx: { chatType: "group" } }));
					} catch (error) {
						this.log.warn("feishu.onboarding.welcome_failed", { chatId: event.chatId, error: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				if (this.rt.config.onboarding?.notifyAdmins === false) return;
				// 群未放行：拉机器人进群的人有审批权就只私聊他，否则通知按 accessApprovers 能审批的人
				const approvers = accessApprovers(this.rt.config, effectiveAdmins(this.rt.config), this.onboarding.approverPolicy());
				const recipients = event.operatorOpenId && approvers.includes(event.operatorOpenId) ? [event.operatorOpenId] : approvers;
				if (recipients.length === 0) this.log.warn("feishu.onboarding.no_approver", { chatId: event.chatId, policy: this.onboarding.approverPolicy() });
				const operatorName = event.operatorOpenId ? await this.rt.transport?.resolveUserName(event.operatorOpenId).catch(() => undefined) : undefined;
				this.allowPromptSentAt.set(event.chatId, Date.now());
				await this.onboarding.dmAdmins(recipients, buildAllowChatCard({ chatId: event.chatId, chatName: event.chatName, reason: "机器人被拉进了群", operatorName }), "bot_added");
				return;
			}
			case "bot_removed":
				this.rt.knownChats?.remove(event.chatId);
				this.rt.accessRequests?.clear(event.chatId);
				this.allowPromptSentAt.delete(event.chatId);
				this.log.info("feishu.onboarding.bot_removed", { chatId: event.chatId });
				return;
			case "p2p_entered": {
				// 私聊首次进入（knownChats 里没有这个会话）才欢迎，之后不打扰
				if (this.rt.config.onboarding?.welcome === false || this.rt.knownChats?.has(event.chatId) || !this.rt.outbox) return;
				this.rt.knownChats?.add(event.chatId);
				const openId = event.operatorOpenId;
				const allowed = openId ? this.rt.config.allowUsers.includes(openId) || effectiveAdmins(this.rt.config).includes(openId) : false;
				this.rt.outbox.enqueue(event.chatId, allowed
					? "你好！直接发消息给我就行，/help 查看可用命令。"
					: "你好！私聊功能需要管理员开通（把你加进 allowUsers）。开通后直接发消息给我即可。", {}, {
					dedupeKey: `p2p-welcome:${event.chatId}`, laneKey: event.chatId, kind: "notify",
				});
				this.log.info("feishu.onboarding.p2p_entered", { chatId: event.chatId, allowed });
				return;
			}
			case "reaction": {
				// 只记用户对本 bot 回复的 👍/👎（机器人自己加的"处理中"表情不算），默认不触发新一轮
				if (this.rt.config.feedback?.enabled === false) return;
				if (event.operatorType === "app" || !event.operatorOpenId || event.operatorOpenId === this.rt.transport?.getBotIdentity().openId) return;
				const kind = /thumbs?up|^like$|^ok$/i.test(event.emoji) ? "up" : /thumbs?down|dislike/i.test(event.emoji) ? "down" : undefined;
				if (!kind || !this.rt.lastSent?.has(event.messageId)) return;
				this.recordFeedback({ at: Date.now(), messageId: event.messageId, kind, action: event.action, operator: event.operatorOpenId });
				return;
			}
		}
	}

	/** 反馈记录（只记 id 与方向，不含正文）。 */
	private recordFeedback(entry: { at: number; messageId: string; kind: "up" | "down"; action: "created" | "deleted"; operator: string }): void {
		this.rt.feedback[entry.kind] += entry.action === "created" ? 1 : -1;
		try {
			const file = resolvePaths(this.rt.homeDir).feedbackFile;
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch { /* 统计失败无所谓 */ }
		this.log.info("feishu.feedback", { kind: entry.kind, action: entry.action, messageId: entry.messageId });
	}
}
