/**
 * pi-feishu-channel 扩展入口：装配 transport/pipeline/session/sender/outbox，
 * 提供 /feishu 命令与连接 supervisor（指数退避重连）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "./pi-types.js";
import type { BridgeConfig, FeishuInboundMessage, GroupPolicy, SessionBackend } from "./types.js";
import { loadConfig, resolveAppLockFile, resolvePaths, saveConfigFields, formatTimeInZone } from "./config.js";
import type { LarkSdkLike } from "./inbound/transport.js";
import { InboundPipeline } from "./inbound/pipeline.js";
import { LastSentCache, effectiveAdmins } from "./inbound/admit.js";
import { buildDocCommentPrompt, deliverDocCommentReply, docCommentChatId, docCommentSkipReason, fetchDocCommentContext, readDocText } from "./inbound/doc-comments.js";
import { buildMeetingInvitePrompt, meetingInviteKey } from "./inbound/meeting-invite.js";
import { Sender } from "./outbound/sender.js";
import { Outbox } from "./outbound/outbox.js";
import { ConversationManager } from "./session/conversation-manager.js";
import { PiSessionBackend } from "./session/pi-session-backend.js";
import { DedupeStore } from "./inbound/dedupe-store.js";
import { AppLock } from "./runtime/app-lock.js";
import { writeStatus } from "./runtime/status-store.js";
import { compensateKnownChats } from "./runtime/history-compensation.js";
import { ResourceResolver } from "./inbound/resource-resolver.js";
import { queueLocalFile } from "./outbound/local-file-tool.js";
import { stageArtifact, validateLocalArtifact } from "./outbound/artifact.js";
import { bashCommandOf, createBridgeInlineExtension } from "./session/pi-bridge-hooks.js";
import { PermissionBridge, redactParams } from "./approval/permission-bridge.js";
import { classifyCommand } from "./approval/command-policy.js";
import { buildApprovalCard } from "./approval/cards.js";
import { createUsageProvider, type UsageProvider } from "./outbound/usage-provider.js";
import {
	ClarificationStore,
	buildClarificationCard,
	clarificationTextFallback,
} from "./interaction/clarification-store.js";
import type { CardAction } from "./inbound/transport.js";
import { KnownChatStore } from "./runtime/known-chat-store.js";
import { ReconnectSupervisor } from "./runtime/reconnect-supervisor.js";
import { CardRouter } from "./interaction/card-router.js";
import { approvalCardOps, clarifyCardOps, commandCardOps, modelCardOps } from "./interaction/card-ops.js";
import { DIRECT_BASH_PREFIX } from "./commands/registry.js";
import { atList, buildAccessNoticeCard, buildAccessRequestCard, buildAllowChatCard, buildResultCard, buildWelcomeCard } from "./commands/cards.js";
import { AccessRequestTracker, planAccessRequest } from "./runtime/access-request.js";
import { accessApproverHint, accessApproverPolicy, accessApprovers, canApproveAccess, describeByRole, roleOf } from "./runtime/admin-roles.js";
import { loadPsConfig, psBashVerdict } from "./approval/policy-summary.js";
import { UsageLedger } from "./runtime/usage-ledger.js";
import { AlertMonitor, DEFAULT_ALERT_OPTIONS } from "./runtime/alerts.js";
import type { LifecycleEvent } from "./inbound/transport.js";
import { archiveOldSessions, tightenSessionPermissions } from "./runtime/retention.js";
import { createTranscriber } from "./inbound/stt.js";
import { enabledFeatures } from "./features/switches.js";
import { FeatureHost } from "./features/feature.js";
import { FEATURES } from "./features/index.js";
import { CommandDispatcher, createCommandReplier } from "./commands/dispatch.js";
import type { CommandServices } from "./commands/handlers/services.js";
import { infoCommands } from "./commands/handlers/info.js";
import { VALID_POLICIES, adminCommands, alwaysApprovedCommand, setChatPolicy } from "./commands/handlers/admin.js";
import { sessionCommands } from "./commands/handlers/session.js";
import { modelCommands } from "./commands/handlers/model.js";
import { BridgeRuntime } from "./runtime/bridge-runtime.js";
import { createConsoleLogger } from "./runtime/logger.js";
import { createToolGate } from "./approval/gate.js";
import { PsForwardingSync } from "./approval/ps-forwarding-sync.js";
import { psConfigFile, setReportedAgentDir } from "./approval/pi-permission-system.js";

export type { BridgeLogger } from "./runtime/logger.js";

/**
 * 扩展入口的可选注入项。pi 加载扩展时只传 `pi` 一个参数，所以生产环境下这里总是空的；
 * 测试用它换掉飞书 SDK，从入口把真实的 transport / 流水线 / 命令 / 卡片处理整条跑起来。
 */
export interface BridgeDeps {
	/** 替代 `@larksuiteoapi/node-sdk`（默认按需动态导入真实 SDK）。 */
	larkSdk?: LarkSdkLike;
	/** 替代 pi 会话后端（默认为每个会话创建真实的 pi 子会话）。 */
	sessionBackend?: SessionBackend;
}

export default function feishuBridgeExtension(pi: ExtensionAPI, deps: BridgeDeps = {}) {
	try { setReportedAgentDir(pi.getAgentDir()); } catch { /* 老版本 pi / 测试桩 */ }
	const rt = new BridgeRuntime();

	const log = createConsoleLogger();

	function setStatus(key: "conn" | "bridge", text: string): void {
		try {
			pi.ui.setStatus(`feishu-${key}`, text);
		} catch {
			/* no-ui */
		}
	}

	function updateStatus(): void {
		const stats = rt.pipeline?.getStats();
		const outboxStats = rt.outbox?.stats() ?? { pending: 0, sending: 0, sent: 0, failed: 0, lanes: 0, oldestAgeMs: 0 };
		rt.status = {
			appId: rt.config.appId || undefined,
			pid: process.pid,
			updatedAt: Date.now(),
			connState: rt.transport?.isConnected() ? "connected" : rt.reportedConnState === "error" ? "error" : rt.transport?.isRunning() ? "connecting" : "disconnected",
			downSince: rt.downSince,
			lastError: rt.lastError,
			reconnectCount: reconnectSupervisor.totalReconnects,
			reconnectsLast5m: reconnectSupervisor.reconnectsInWindow(),
			startedAt: rt.status.startedAt,
			botOpenId: rt.transport?.getBotIdentity().openId,
			botName: rt.transport?.getBotIdentity().name,
			conversations: rt.convManager?.count() ?? 0,
			sessionQueues: rt.convManager?.queueStats() ?? { queued: 0, active: 0, waiting: 0 },
			pendingApprovals: rt.permissionBridge?.pendingCount() ?? 0,
			outboxDepth: outboxStats.pending + outboxStats.sending,
			outbox: outboxStats,
			lastMessageAt: stats?.lastMessageAt,
			messageTotal: stats?.total ?? 0,
			messageDropped: stats?.dropped ?? 0,
			compensatedMessages: rt.compensatedMessages,
			compensationErrors: rt.compensationErrors,
			compensationTruncated: rt.compensationTruncated,
			features: enabledFeatures(rt.config),
		};
		if (rt.homeDir) {
			try { writeStatus(resolvePaths(rt.homeDir).statusFile, rt.status); } catch (error) {
				log.error("status write failed", { error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	/** 管理员/应用归属人判定（统一走 effectiveAdmins，避免换应用后视角失效）。 */
	function isAdminSender(msg: { senderId: string }): boolean {
		return effectiveAdmins(rt.config).includes(msg.senderId);
	}

	/** 卡片回调路由：核心按钮在这里登记，可选能力的按钮随能力一起登记。 */
	const cardOpsContext = { rt, log, admins: () => effectiveAdmins(rt.config), runCommand: (msg: FeishuInboundMessage) => handleFeishuCommand(msg) };
	const cardRouter = new CardRouter({ log, admins: () => effectiveAdmins(rt.config) })
		.register("model", modelCardOps(cardOpsContext))
		.register("command", commandCardOps(cardOpsContext))
		.register("clarify", clarifyCardOps(cardOpsContext))
		.register("approval", approvalCardOps(cardOpsContext))
		.register("accessRequest", {
			// 私聊或群里的「放行此群」
			"chat.allow": async (action, value) => {
				if (typeof value.chatId !== "string" || !value.chatId.startsWith("oc_")) return undefined;
				if (!canApproveAccess(rt.config, action.operatorOpenId, approverPolicy())) return { toast: { type: "warning", content: `${accessApproverHint(approverPolicy())}可以放行群` } };
				if (rt.config.allowChats.includes(value.chatId)) return { card: { type: "raw", data: buildResultCard(`群 \`${value.chatId}\` 已在放行列表中。`, "grey") } };
				const previous = [...rt.config.allowChats];
				rt.config.allowChats = [...rt.config.allowChats, value.chatId];
				if (!saveConfigFields(rt.homeDir, rt.config, ["allowChats"])) {
					rt.config.allowChats = previous;
					return { toast: { type: "error", content: "写入配置失败，未放行" } };
				}
				log.info("feishu.onboarding.chat_allowed", { chatId: value.chatId, operator: action.operatorOpenId });
				rt.accessRequests?.clear(value.chatId);
				// 群里回告：申请人（有的话）+ 放行人
				const requester = typeof value.requester === "string" && value.requester.startsWith("ou_") ? value.requester : undefined;
				void sendChatCard(value.chatId, buildAccessNoticeCard(`${requester ? `${atList([requester])} ` : ""}本群已开通（由 ${operatorByRole(action.operatorOpenId)} 放行），现在 @ 我就可以使用了。`, "green"), {}, "allowed_notice");
				return {
					toast: { type: "success", content: "已放行" },
					card: { type: "raw", data: buildResultCard(`已放行群 \`${value.chatId}\`（写入 allowChats）。群里 @ 机器人即可使用。`) },
				};
			},
			// 开通申请：暂不放行（忽略期内该群不再发申请）
			"chat.deny": async (action, value) => {
				if (typeof value.chatId !== "string" || !value.chatId.startsWith("oc_")) return undefined;
				if (!canApproveAccess(rt.config, action.operatorOpenId, approverPolicy())) return { toast: { type: "warning", content: `${accessApproverHint(approverPolicy())}可以操作` } };
				rt.accessRequests ??= new AccessRequestTracker({ cooldownMs: rt.config.onboarding?.accessRequestCooldownMs });
				rt.accessRequests.markIgnored(value.chatId);
				log.info("feishu.access_request.denied", { chatId: value.chatId, operator: action.operatorOpenId });
				const requester = typeof value.requester === "string" && value.requester.startsWith("ou_") ? value.requester : undefined;
				// 私聊审批时申请人看不到这张卡 → 在群里告诉他；群里审批时卡片本身就会变成结果
				if (requester && action.chatId !== value.chatId) {
					void sendChatCard(value.chatId, buildAccessNoticeCard(`${atList([requester])} ${operatorByRole(action.operatorOpenId)} 暂未开通本群。`, "grey"), {}, "denied_notice");
				}
				return {
					toast: { type: "info", content: "已暂不放行" },
					card: { type: "raw", data: buildResultCard(`已暂不放行群 \`${value.chatId}\`（24 小时内该群的开通申请不再提醒）。`, "grey") },
				};
			},
		})
		// agent 通过 feishu_card 工具发的卡片 —— 点击作为一条新消息进入会话
		.register("cardTool", { "agent.card": (action, value) => handleAgentCardClick(action, value) });

	/**
	 * 账户用量提供方（懒建；余额失败降级为 unavailable，不抛异常）。
	 *
	 * 只在 `/feishu usage` 里查余额，不打任何周期性外部请求；快照文件由
	 * `usage.snapshots` 控制（关掉就只查余额、不估速率）。`usage.provider: "none"` 完全不接厂商。
	 */
	function usageProviderFor(cfg: BridgeConfig): UsageProvider {
		rt.usageProvider ??= createUsageProvider({
			provider: cfg.usage?.provider,
			apiKey: process.env.DEEPSEEK_API_KEY,
			balanceTtlMs: cfg.usage?.balanceTtlMs,
			snapshotPath: cfg.usage?.snapshots === false ? undefined : resolvePaths(rt.homeDir).balanceSnapshotsFile,
			log: (level, message, meta) => log[level](message, meta),
		});
		return rt.usageProvider;
	}


	/** Pi 侧的命令/模板/技能（纠错时不误伤、帮助里列出）。 */
	function piCommandList(): Array<{ name: string; description?: string; source?: string }> {
		try { return pi.getCommands?.() ?? []; } catch { return []; }
	}



	/** 命令分发：处理函数按组登记（见 commands/handlers/）；定时任务与直接执行命令随各自能力登记。 */
	const replierFor = createCommandReplier(rt, log);
	const commandServices: CommandServices = {
		rt, log,
		piCommands: () => piCommandList(),
		statusText: () => statusText(),
		diagnosticsContext: () => diagnosticsContext(),
		usageProvider: () => usageProviderFor(rt.config),
	};
	const commandDispatcher = new CommandDispatcher({ log, isAdmin: isAdminSender, replier: replierFor, piCommands: () => piCommandList() })
		// `!<命令>` 直接执行（默认关闭；不属于斜杠命令表）
		.intercept("directBash", async (msg) => {
			const raw = msg.text.trim();
			if (!raw.startsWith(DIRECT_BASH_PREFIX) || !rt.config.directBash?.enabled) return false;
			await handleDirectBash(msg, raw.slice(DIRECT_BASH_PREFIX.length).trim());
			return true;
		})
		.register("info", infoCommands(commandServices))
		.register("admin", adminCommands(commandServices))
		.register("session", sessionCommands(commandServices))
		.register("model", modelCommands(commandServices));

	/** 可选能力（默认全部关闭；每次启动按配置装配，停止时注销）。 */
	const featureHost = new FeatureHost(FEATURES, { dispatcher: commandDispatcher, cardRouter, log });

	function handleFeishuCommand(msg: FeishuInboundMessage): Promise<boolean> {
		return commandDispatcher.dispatch(msg);
	}






	/**
	 * `!<命令>` 直接执行。executeBash 不经过 tool_call 拦截，所以桥自己把关：
	 * 仅管理员；桥的命令分级 + PS 的 bash 规则，任一 deny 直接拒绝；ask 默认也拒绝（请让 agent 执行以走审批卡）；
	 * 每次执行都写审计日志。
	 */
	async function handleDirectBash(msg: FeishuInboundMessage, command: string): Promise<void> {
		const { reply } = replierFor(msg);
		const audit = (outcome: string, extra: Record<string, unknown> = {}) => log.info("feishu.direct_bash.audit", {
			outcome, chatId: msg.chatId, operator: msg.senderId, command: redactParams({ command }, "bash").slice(0, 300), ...extra,
		});
		if (!command) { reply("用法：!<命令>，例如 !git status"); return; }
		if (!isAdminSender(msg)) { audit("rejected_not_admin"); reply("直接执行命令仅限管理员"); return; }
		if (rt.config.directBash?.p2pOnly && msg.chatType !== "p2p") { audit("rejected_not_p2p"); reply("直接执行命令只能在私聊里使用"); return; }
		const bridgeVerdict = classifyCommand(command, rt.config.approval.commandPolicy);
		const psVerdict = rt.config.approval.policyEngine === "pi-permission-system" ? psBashVerdict(loadPsConfig(psConfigFile()), command) : undefined;
		if (bridgeVerdict.verdict === "deny" || psVerdict?.verdict === "deny") {
			audit("denied", { reason: bridgeVerdict.verdict === "deny" ? bridgeVerdict.reason : `PS 规则 ${psVerdict?.rule}` });
			reply(`已拒绝：${bridgeVerdict.verdict === "deny" ? bridgeVerdict.reason : `命中禁止规则「${psVerdict?.rule}」`}`);
			return;
		}
		const needsApproval = bridgeVerdict.verdict === "ask" || psVerdict?.verdict === "ask";
		if (needsApproval && !rt.config.directBash?.allowAsk) {
			audit("rejected_needs_approval", { reason: bridgeVerdict.reason });
			reply(`该命令需要审批（${bridgeVerdict.verdict === "ask" ? bridgeVerdict.reason : `PS 规则 ${psVerdict?.rule}`}），直接执行只放行免审命令。\n可以让 agent 执行它（会弹审批卡），例如：用 bash 执行 ${command.slice(0, 80)}`);
			return;
		}
		const result = await rt.convManager?.runDirectBash(msg, command, rt.config.directBash?.timeoutMs ?? 60_000);
		if (!result) { reply("会话不可用"); return; }
		if (!result.ok) { audit("failed", { reason: result.reason }); reply(result.reason); return; }
		audit("executed", { exitCode: result.exitCode ?? null, cancelled: result.cancelled, timedOut: result.timedOut });
		const status = result.timedOut ? "⏱ 超时已中止" : result.cancelled ? "⏹ 已中止" : result.exitCode === 0 ? "✅ exit 0" : `⚠️ exit ${result.exitCode ?? "?"}`;
		const output = result.output.trimEnd() || "（无输出）";
		const limit = 3_500;
		const shown = output.length > limit ? `…（前面省略 ${output.length - limit} 字）\n${output.slice(-limit)}` : output;
		reply(`$ ${command.slice(0, 200)}\n${status}${result.truncated ? "（输出已被截断）" : ""}\n\`\`\`\n${shown}\n\`\`\``);
	}


	/** 同一群的放行提示 1 小时内只发一次。 */
	const allowPromptSentAt = new Map<string, number>();

	/** 私聊一张卡给若干管理员（失败只记日志）。 */
	async function dmAdmins(recipients: string[], card: unknown, what: string): Promise<number> {
		let sent = 0;
		for (const openId of recipients.slice(0, 5)) {
			try {
				await rt.transport?.sendToUser(openId, "interactive", card);
				sent += 1;
			} catch (error) {
				log.warn("feishu.admin_dm_failed", { what, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return sent;
	}

	/** 群未放行时，管理员 @ 了机器人 → 私聊他一张"放行此群"卡。普通成员 @ 不回复，只记日志。 */
	async function onAdmissionDrop(msg: FeishuInboundMessage, reason: string, mentioned: boolean): Promise<void> {
		if (reason !== "not_allowlisted" || msg.chatType === "p2p" || !mentioned || rt.config.allowChats.includes(msg.chatId)) return;
		if (rt.config.onboarding?.accessRequest) {
			await requestChatAccess(msg);
			return;
		}
		if (rt.config.onboarding?.notifyAdmins === false) return;
		// 旧行为（未开开通申请）：有审批权的人 @ 了机器人 → 私聊他放行卡（没审批权就不发一张点不动的卡）
		if (!canApproveAccess(rt.config, msg.senderId, approverPolicy())) return;
		const last = allowPromptSentAt.get(msg.chatId);
		if (last && Date.now() - last < 3_600_000) return;
		allowPromptSentAt.set(msg.chatId, Date.now());
		const chatName = await rt.transport?.getChatName(msg.chatId);
		const operatorName = await rt.transport?.resolveUserName(msg.senderId).catch(() => undefined);
		await dmAdmins([msg.senderId], buildAllowChatCard({ chatId: msg.chatId, chatName, reason: "管理员在群里 @ 了机器人", operatorName }), "allow_chat");
		log.info("feishu.onboarding.allow_prompt", { chatId: msg.chatId, operator: msg.senderId });
	}

	/** 群里发卡片（失败只记日志，返回是否发出）。 */
	async function sendChatCard(chatId: string, card: unknown, opts: { replyTo?: string; threadId?: string }, what: string): Promise<boolean> {
		try {
			await rt.transport?.sendCard(chatId, card, opts);
			return true;
		} catch (error) {
			log.warn("feishu.access_request.card_failed", { chatId, what, error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	/**
	 * 开通申请：未放行的群里有人 @ 机器人。
	 * 管理员（归属人/协作者/admins）有人在群里 → 群里弹审批卡并 @ 他们（回复申请人那条消息）；
	 * 否则私聊应用归属人，群里回告申请人"已发给谁"。同一个群冷却期内只申请一次。
	 */
	async function requestChatAccess(msg: FeishuInboundMessage): Promise<void> {
		if (!rt.transport) return;
		rt.accessRequests ??= new AccessRequestTracker({ cooldownMs: rt.config.onboarding?.accessRequestCooldownMs });
		const replyOpts = { replyTo: msg.messageId, ...(msg.threadId ? { threadId: msg.threadId } : {}) };
		const decision = rt.accessRequests.decide(msg.chatId, msg.senderId);
		if (decision.action === "silent") {
			log.info("feishu.access_request.silent", { chatId: msg.chatId, requester: msg.senderId, reason: decision.reason });
			return;
		}
		if (decision.action === "remind") {
			const whom = decision.mode === "group" ? atByRole(decision.approvers) : await approverNames(decision.approvers);
			await sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群的开通申请已发给 ${whom}${decision.mode === "dm" ? "（私聊）" : ""}，正在等待审批，通过后我会在群里通知。`), replyOpts, "remind");
			return;
		}
		const members = await rt.transport.listChatMemberIds(msg.chatId);
		const policy = approverPolicy();
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
			await sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群还没有开通机器人，暂时找不到可以审批的人，请联系应用归属人开通。`, "grey"), replyOpts, "no_approver");
			return;
		}
		rt.accessRequests.markRequested(msg.chatId, msg.senderId, plan);
		if (plan.mode === "group") {
			const ok = await sendChatCard(msg.chatId, buildAccessRequestCard({ mode: "group", chatId: msg.chatId, requesterId: msg.senderId, approvers: plan.approvers, approverLabel: atByRole(plan.approvers), approverHint: accessApproverHint(policy) }), replyOpts, "request_in_group");
			if (!ok) rt.accessRequests.clear(msg.chatId);
			log.info("feishu.access_request.sent", { chatId: msg.chatId, mode: "group", approvers: plan.approvers.length, ok, membersKnown: Boolean(members) });
			return;
		}
		const chatName = await rt.transport.getChatName(msg.chatId);
		const sent = await dmAdmins(plan.approvers, buildAccessRequestCard({ mode: "dm", chatId: msg.chatId, chatName, requesterId: msg.senderId, approvers: plan.approvers, approverLabel: atByRole(plan.approvers), approverHint: accessApproverHint(policy) }), "access_request");
		if (sent === 0) {
			rt.accessRequests.clear(msg.chatId);
			await sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群还没有开通机器人，暂时联系不上管理员，请直接联系管理员开通。`, "grey"), replyOpts, "request_failed");
			return;
		}
		await sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群还没有开通机器人，已把开通申请私聊发给 ${await approverNames(plan.approvers)}，审批通过后我会在群里通知你。`), replyOpts, "request_notice");
		log.info("feishu.access_request.sent", { chatId: msg.chatId, mode: "dm", approvers: plan.approvers.length, delivered: sent, membersKnown: Boolean(members) });
	}

	/** 群开通审批策略（配置热改后立即生效）。 */
	function approverPolicy() {
		return accessApproverPolicy(rt.config.onboarding?.accessApprovers);
	}

	/** 带角色的 @ 列表（卡片 markdown）："应用归属人 @张三、应用协作者 @李四"。 */
	function atByRole(ids: string[]): string {
		return describeByRole(rt.config, ids, (id) => atList([id]));
	}

	/** 带角色的名字（私聊场景：审批人不在群里，@ 不会提醒，写名字更直观）："应用归属人 张三"。 */
	async function approverNames(ids: string[]): Promise<string> {
		const names = new Map(await Promise.all(ids.map(async (id) => [id, (await rt.transport?.resolveUserName(id).catch(() => undefined)) ?? "（未知）"] as const)));
		return describeByRole(rt.config, ids, (id) => names.get(id) ?? "（未知）");
	}

	/** 操作人的角色 + @（放行/暂不放行回告用）。 */
	function operatorByRole(openId: string): string {
		const role = roleOf(rt.config, openId);
		return role ? atByRole([openId]) : atList([openId]);
	}

	/** 撤回、入群/退群、私聊进入、表情。 */
	async function handleLifecycleEvent(event: LifecycleEvent): Promise<void> {
		switch (event.type) {
			case "recalled": {
				// 还在合批窗口 → 直接移除；排队 → 出队；执行中 → 只停本轮（同 /stop）
				if (rt.pipeline?.cancelBatched(event.messageId)) return;
				const result = await rt.convManager?.cancelByMessageId(event.messageId);
				log.info("feishu.recall", { messageId: event.messageId, status: result?.status ?? "none" });
				if (result?.status === "aborted" && result.chatId && rt.outbox) {
					rt.outbox.enqueue(result.chatId, `已按撤回取消本轮任务${result.sideEffects ? "（本轮已执行过工具，可能已经产生了副作用）" : ""}。`, { threadId: result.threadId }, {
						dedupeKey: `${event.messageId}:recalled`, laneKey: result.conversationKey ?? result.chatId, kind: "notify",
					});
				}
				return;
			}
			case "bot_added": {
				rt.knownChats?.add(event.chatId);
				log.info("feishu.onboarding.bot_added", { chatId: event.chatId, operator: event.operatorOpenId ?? null });
				if (rt.config.allowChats.includes(event.chatId)) {
					if (rt.config.onboarding?.welcome === false || !rt.transport) return;
					const policy = rt.config.groupRules[event.chatId]?.policy ?? rt.config.groupPolicyByChat[event.chatId] ?? rt.config.defaultGroupPolicy ?? rt.config.groupPolicy;
					const trigger = policy === "open" ? "直接发消息即可" : policy === "admin_only" ? "仅管理员 @ 我" : policy === "disabled" ? "本群已停用" : "在群里 @ 我";
					try {
						await rt.transport.sendCard(event.chatId, buildWelcomeCard({ botName: rt.transport.getBotIdentity().name, trigger, ctx: { chatType: "group" } }));
					} catch (error) {
						log.warn("feishu.onboarding.welcome_failed", { chatId: event.chatId, error: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				if (rt.config.onboarding?.notifyAdmins === false) return;
				// 群未放行：拉机器人进群的人有审批权就只私聊他，否则通知按 accessApprovers 能审批的人
				const approvers = accessApprovers(rt.config, effectiveAdmins(rt.config), approverPolicy());
				const recipients = event.operatorOpenId && approvers.includes(event.operatorOpenId) ? [event.operatorOpenId] : approvers;
				if (recipients.length === 0) log.warn("feishu.onboarding.no_approver", { chatId: event.chatId, policy: approverPolicy() });
				const operatorName = event.operatorOpenId ? await rt.transport?.resolveUserName(event.operatorOpenId).catch(() => undefined) : undefined;
				allowPromptSentAt.set(event.chatId, Date.now());
				await dmAdmins(recipients, buildAllowChatCard({ chatId: event.chatId, chatName: event.chatName, reason: "机器人被拉进了群", operatorName }), "bot_added");
				return;
			}
			case "bot_removed":
				rt.knownChats?.remove(event.chatId);
				rt.accessRequests?.clear(event.chatId);
				allowPromptSentAt.delete(event.chatId);
				log.info("feishu.onboarding.bot_removed", { chatId: event.chatId });
				return;
			case "p2p_entered": {
				// 私聊首次进入（knownChats 里没有这个会话）才欢迎，之后不打扰
				if (rt.config.onboarding?.welcome === false || rt.knownChats?.has(event.chatId) || !rt.outbox) return;
				rt.knownChats?.add(event.chatId);
				const openId = event.operatorOpenId;
				const allowed = openId ? rt.config.allowUsers.includes(openId) || effectiveAdmins(rt.config).includes(openId) : false;
				rt.outbox.enqueue(event.chatId, allowed
					? "你好！直接发消息给我就行，/help 查看可用命令。"
					: "你好！私聊功能需要管理员开通（把你加进 allowUsers）。开通后直接发消息给我即可。", {}, {
					dedupeKey: `p2p-welcome:${event.chatId}`, laneKey: event.chatId, kind: "notify",
				});
				log.info("feishu.onboarding.p2p_entered", { chatId: event.chatId, allowed });
				return;
			}
			case "reaction": {
				// 只记用户对本 bot 回复的 👍/👎（机器人自己加的"处理中"表情不算），默认不触发新一轮
				if (rt.config.feedback?.enabled === false) return;
				if (event.operatorType === "app" || !event.operatorOpenId || event.operatorOpenId === rt.transport?.getBotIdentity().openId) return;
				const kind = /thumbs?up|^like$|^ok$/i.test(event.emoji) ? "up" : /thumbs?down|dislike/i.test(event.emoji) ? "down" : undefined;
				if (!kind || !rt.lastSent?.has(event.messageId)) return;
				recordFeedback({ at: Date.now(), messageId: event.messageId, kind, action: event.action, operator: event.operatorOpenId });
				return;
			}
			case "doc_comment":
				await handleDocComment(event.event);
				return;
			case "meeting_invite":
				await handleMeetingInvite(event.invite);
				return;
		}
	}

	/** 外部事件去重（平台重投同一事件时不重复开任务）；只在内存里，容量有限。 */
	const seenExternalEvents = new Set<string>();
	function firstSeen(key: string): boolean {
		if (seenExternalEvents.has(key)) return false;
		seenExternalEvents.add(key);
		if (seenExternalEvents.size > 512) seenExternalEvents.delete(seenExternalEvents.values().next().value as string);
		return true;
	}

	/** 云文档评论 @ 机器人 → 虚拟会话里跑一轮，回答回复到评论区。 */
	async function handleDocComment(event: import("./inbound/doc-comments.js").DocCommentEvent): Promise<void> {
		if (!rt.config.docComments?.enabled || !rt.transport || !rt.convManager) return;
		const botOpenId = rt.transport.getBotIdentity().openId;
		const skip = docCommentSkipReason(event, botOpenId);
		if (skip) {
			log.debug("feishu.doc_comment.skipped", { reason: skip, commentId: event.commentId });
			return;
		}
		const sender = event.fromOpenId;
		const allowUsers = rt.config.docComments.allowUsers ?? rt.config.allowUsers;
		if (!sender || !(effectiveAdmins(rt.config).includes(sender) || allowUsers.includes(sender))) {
			log.info("feishu.doc_comment.denied", { commentId: event.commentId, sender: sender ?? null, hint: "评论人不是管理员，也不在 docComments.allowUsers（缺省用 allowUsers）里" });
			return;
		}
		if (!firstSeen(`doc_comment:${event.eventId ?? `${event.commentId}:${event.replyId ?? ""}`}`)) return;
		const request = (opts: { url: string; method: string; params?: unknown; data?: unknown }) => rt.transport!.rawRequest(opts);
		const ctx = await fetchDocCommentContext(request, event, { botOpenId });
		if (!ctx) {
			log.warn("feishu.doc_comment.context_unavailable", { commentId: event.commentId, fileType: event.fileType, hint: "拉不到评论详情：检查应用的云文档评论读取权限，以及机器人是否有该文档的访问权限" });
			return;
		}
		log.info("feishu.doc_comment.accepted", { commentId: event.commentId, fileType: event.fileType, isWhole: ctx.isWhole, thread: ctx.thread.length });
		await rt.convManager.route({
			messageId: `doccomment:${event.commentId}:${event.replyId ?? event.eventId ?? Date.now()}`,
			chatId: docCommentChatId(event.fileToken), chatType: "group",
			senderId: sender, isBot: false, msgType: "text",
			text: buildDocCommentPrompt(event, ctx),
			mentions: [], resources: [], raw: undefined, ts: Date.now(),
			synthetic: true, replyTarget: null,
			deliverTo: { kind: "doc_comment", fileToken: event.fileToken, fileType: event.fileType, commentId: event.commentId, isWhole: ctx.isWhole },
		}, { behavior: "queue" });
	}

	/** 会议邀请 → 邀请人私聊里开一轮任务（邀请人需通过私聊准入）。 */
	async function handleMeetingInvite(invite: import("./inbound/meeting-invite.js").MeetingInvite): Promise<void> {
		if (!rt.config.meetingInvite?.enabled || !rt.transport || !rt.convManager) return;
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

	/** 反馈计数（只记 id 与方向，不含正文）。 */
	const feedbackCounts = { up: 0, down: 0 };
	function recordFeedback(entry: { at: number; messageId: string; kind: "up" | "down"; action: "created" | "deleted"; operator: string }): void {
		feedbackCounts[entry.kind] += entry.action === "created" ? 1 : -1;
		try {
			const file = resolvePaths(rt.homeDir).feedbackFile;
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch { /* 统计失败无所谓 */ }
		log.info("feishu.feedback", { kind: entry.kind, action: entry.action, messageId: entry.messageId });
	}

	/** feishu_card 工具的按钮签名（进程级随机密钥：重启后旧卡按钮失效，这是预期的）。 */
	const cardToolSecret = randomBytes(32);
	function signCardValue(payload: string): string {
		return createHmac("sha256", cardToolSecret).update(payload).digest("base64url").slice(0, 32);
	}


	/** 心跳 —— 定期刷新 status.json（健康但空闲的桥 mtime 也不会停），顺带评估告警。 */
	function startHeartbeat(): void {
		const interval = rt.config.statusHeartbeatMs ?? 30_000;
		if (rt.heartbeatTimer || interval <= 0) return;
		rt.heartbeatTimer = setInterval(() => {
			updateStatus();
			void evaluateAlerts();
		}, interval);
		rt.heartbeatTimer.unref?.();
	}

	function stopHeartbeat(): void {
		if (rt.heartbeatTimer) clearInterval(rt.heartbeatTimer);
		rt.heartbeatTimer = undefined;
	}

	async function evaluateAlerts(): Promise<void> {
		if (!rt.config.alerts?.enabled) return;
		rt.alertMonitor ??= new AlertMonitor({
			disconnectMs: rt.config.alerts.disconnectMs ?? DEFAULT_ALERT_OPTIONS.disconnectMs,
			reconnectsIn5m: rt.config.alerts.reconnectsIn5m ?? DEFAULT_ALERT_OPTIONS.reconnectsIn5m,
			pendingApprovals: rt.config.alerts.pendingApprovals ?? DEFAULT_ALERT_OPTIONS.pendingApprovals,
			approvalAgeMs: DEFAULT_ALERT_OPTIONS.approvalAgeMs,
			cooldownMs: rt.config.alerts.cooldownMs ?? DEFAULT_ALERT_OPTIONS.cooldownMs,
		});
		const messages = rt.alertMonitor.evaluate({
			now: Date.now(),
			downSince: rt.downSince,
			reconnectsLast5m: reconnectSupervisor.reconnectsInWindow(),
			failedFinals: rt.outbox?.stats().failed ?? 0,
			pendingApprovals: rt.permissionBridge?.pendingCount() ?? 0,
			oldestApprovalAgeMs: rt.permissionBridge?.oldestPendingAgeMs(),
			compensationErrors: rt.compensationErrors,
		});
		if (messages.length === 0 || !rt.transport?.isConnected()) return;
		const recipients = rt.config.alerts.recipients?.length ? rt.config.alerts.recipients : effectiveAdmins(rt.config);
		for (const message of messages) {
			log.warn("feishu.alert", { kind: message.kind, recovered: message.recovered });
			for (const openId of recipients.slice(0, 10)) {
				try { await rt.transport.sendToUser(openId, "text", { text: `[飞书桥] ${message.text}` }); } catch (error) {
					log.warn("feishu.alert.send_failed", { kind: message.kind, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}
	}

	/** 启动时收紧会话文件权限；配置了保留期时归档超期历史会话。 */
	function runRetention(): void {
		const dir = resolvePaths(rt.homeDir).sessionDir;
		try {
			const tightened = tightenSessionPermissions(dir);
			const archived = archiveOldSessions({ dir, keep: rt.convManager?.referencedSessionFiles() ?? new Set(), days: rt.config.retention?.sessionDays ?? 0 });
			if (tightened > 0 || archived.length > 0) log.info("feishu.retention", { tightened, archived: archived.length });
		} catch (error) {
			log.warn("feishu.retention_failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	async function assemble(): Promise<void> {
		const paths = resolvePaths(rt.homeDir);
		rt.knownChats = new KnownChatStore(paths.knownChatsFile);
		const { createFeishuTransport } = await import("./inbound/transport-factory.js");
		rt.transport = await createFeishuTransport(rt.config, {
			onMessage: async (msg) => {
				if (msg.chatId) rt.knownChats?.add(msg.chatId);
				await rt.pipeline?.handle(msg);
			},
			onStatus: (connState) => {
				const outageStartedAt = rt.downSince;
				rt.reportedConnState = connState === "connected" ? "connected" : connState === "error" ? "error" : "connecting";
				if (rt.reportedConnState === "connected") {
					rt.downSince = undefined;
					rt.lastError = undefined;
					if (outageStartedAt) void compensateMissed(outageStartedAt);
				} else {
					// error（SDK 终态）与 reconnecting（SDK 自动重连中）都算断线：补收窗口从第一次掉线算起
					rt.downSince ??= Date.now();
				}
				setStatus("conn", connState === "connected" ? "飞书桥已连接" : connState === "reconnecting" ? "飞书桥重连中（SDK）" : `飞书桥 ${connState}`);
				updateStatus();
			},
			onCardAction: (action) => cardRouter.handle(action),
			onLifecycleEvent: handleLifecycleEvent,
			log: (level, m, meta) => log[level](m, meta),
		}, deps.larkSdk);
		rt.usageLedger = new UsageLedger({ file: paths.usageDailyFile, timeZone: rt.config.timezone });
		rt.clarificationStore = new ClarificationStore({
			allowedResponderIds: () => effectiveAdmins(rt.config),
			// 管理员名单为空时不允许任何人作答（默认拒绝，避免任意群成员替用户做决定）
			onAudit: (event) => log.info("feishu.clarify.audit", event),
		});
		rt.permissionBridge = new PermissionBridge({
			getConfig: () => rt.config.approval,
			onAsk: async (pending) => {
				// 卡片上写明谁在哪个会话里发起的
				pending.contextLine ??= await rt.convManager?.approvalContextLine(pending.conversationKey).catch(() => undefined);
				return rt.transport!.sendCard(pending.chatId, buildApprovalCard(pending), {
					replyTo: pending.sourceMessageId, threadId: pending.threadId,
				});
			},
			// 超时前 1 分钟在会话里 @ 审批人提醒一次
			onReminder: (pending) => {
				const admins = pending.allowedOperatorIds.slice(0, 5);
				const mentions = admins.map((id) => `<at user_id="${id}"></at>`).join(" ");
				try {
					rt.outbox?.enqueue(pending.chatId, `${mentions} 有一条审批还剩 1 分钟超时（${pending.toolName}），超时将按拒绝处理。`, {
						replyTo: pending.cardMessageId ?? pending.sourceMessageId, threadId: pending.threadId,
					}, { dedupeKey: `approval-reminder:${pending.id}`, laneKey: pending.conversationKey, kind: "notify" });
				} catch (error) {
					log.warn("feishu.approval.reminder_failed", { error: error instanceof Error ? error.message : String(error) });
				}
			},
			// 同一 run 的同类请求并到这张卡 → 重绘（列出将一并处理的命令，旧卡 token 已作废）
			onCardRefresh: (pending) => {
				if (!pending.cardMessageId) return;
				void rt.transport?.updateCard(pending.cardMessageId, buildApprovalCard(pending)).catch((error: unknown) => {
					log.warn("feishu.approval.card_refresh_failed", { approvalId: pending.id, error: error instanceof Error ? error.message : String(error) });
				});
			},
			// 超时/失效（非用户点击）时把卡片改成终态并禁用按钮，
			// 否则卡片会一直看起来可点，用户点了才被告知「审批已失效」。
			onCardResolve: (pending, outcome) => {
				if (!pending.cardMessageId) return;
				const card = buildApprovalCard(pending, {
					choice: undefined,
					terminal: outcome.terminal,
					resultText: outcome.resultText,
					operatorOpenId: "",
				});
				void rt.transport?.updateCard(pending.cardMessageId, card).then((ok) => {
					if (!ok) log.warn("feishu.approval.card_terminal_failed", { approvalId: pending.id });
				});
			},
			onAlwaysAllow: (toolName) => {
				const previous = [...rt.config.approval.autoApprove];
				if (!rt.config.approval.autoApprove.includes(toolName)) rt.config.approval.autoApprove.push(toolName);
				// saveConfig 失败时回滚内存改动 —— 不得反馈“已持久授权”。
				if (saveConfigFields(rt.homeDir, rt.config, ["approval.autoApprove"])) return true;
				rt.config.approval.autoApprove = previous;
				log.error("feishu.approval.always_persist_failed", { toolName });
				return false;
			},
			onAudit: (event) => log.info("feishu.approval.audit", event),
		});

		rt.lastSent = new LastSentCache(rt.config.lastSentCacheSize);
		rt.sender = new Sender({
			config: rt.config,
			transport: rt.transport,
			onSent: (_chatId, messageId) => {
				rt.lastSent?.record(messageId);
			},
			log: (level, m, meta) => log[level](m, meta),
		});

		rt.outbox = new Outbox({
			file: paths.outboxFile,
			prepare: (chatId, content, opts) => rt.sender!.prepare(chatId, content, opts),
			prepareMedia: (chatId, artifact, opts) => rt.sender!.prepareMedia(chatId, artifact, opts),
			send: (request, checkpoint) => rt.sender!.sendPrepared(request, checkpoint),
			log: (level, m, meta) => log[level](m, meta),
			onChange: updateStatus,
			onResult: (result) => rt.convManager?.recordApiOutcome({ ok: result.success, errorClass: result.errorClass, retryAfterMs: result.retryAfterMs }),
			// 最终回复永久发送失败 → 给用户一条最朴素的提示（不回复原消息、纯文本、新 UUID），
			// 否则用户那边只是"机器人不回了"。提示本身是 notify，失败不再触发提示（不会循环）。
			onTerminalFailure: (entry) => {
				if (entry.kind !== "final" && entry.kind !== "error") return;
				const reason = /230072|edited/i.test(entry.lastError ?? "") ? "消息编辑次数已达上限"
					: /permission|403|forbidden|not in chat|230002/i.test(entry.lastError ?? "") ? "机器人在该会话没有发言权限"
					: "飞书接口持续报错";
				try {
					rt.outbox?.enqueue(entry.route.chatId, `⚠️ 回复发送失败（${reason}），请重试或联系管理员。`, { threadId: entry.route.threadId }, {
						dedupeKey: `${entry.dedupeKey}:failed-notice`, laneKey: entry.laneKey, kind: "notify",
					});
				} catch (error) {
					log.warn("feishu.outbox.failure_notice_failed", { error: error instanceof Error ? error.message : String(error) });
				}
			},
		});

		rt.convManager = new ConversationManager({
			config: rt.config,
			sessionDir: paths.sessionDir,
			// 超时策略：只在「完全没有事件产出」时中止；总时长默认不限（长任务不该被硬杀）
			// 流式卡片复用 transport 的原始请求能力
			rawRequest: (opts) => {
				if (!rt.transport) throw new Error("transport unavailable");
				return rt.transport.rawRequest(opts);
			},
			runIdleTimeoutMs: rt.config.runIdleTimeoutMs,
			runMaxDurationMs: rt.config.runMaxDurationMs,
			sessionBackend: deps.sessionBackend ?? new PiSessionBackend({
				sessionDir: paths.sessionDir,
				log: (l, m, x) => log[l](m, x),
				// 给每个子会话注入桥侧 hook（审批 gate + 文件工具），共享 outer 桥状态；
				// 同时剔除网关扩展，避免子会话重复启动飞书 WS / 创建空状态。
				bridgeExtensionFactory: createBridgeInlineExtension({
					routeForSessionId: (sessionId) => rt.convManager?.routeForSessionId(sessionId),
					markToolBoundary: (sessionId) => rt.convManager?.markPendingToolBoundary(sessionId),
					gateToolCall: (input) => gateToolCall(input),
					notifyCompaction: ({ sessionId, phase, detail }) => {
						const route = rt.convManager?.routeForSessionId(sessionId);
						if (!route) return;
						log.info("feishu.bridge.compaction", { phase, chatId: route.chatId });
						// 压缩期间 Pi 不产出事件，发一条可见提示消除"莫名卡住"的困惑。
						// 必须用 notifyNow（notify 是 private）：attempt 里带 chatId+phase 保证压缩
						// 反复触发时不会每轮刷屏，但每次真实压缩都能出一次。
						if (phase === "start") {
							void rt.convManager?.notifyNow(route.chatId, "🧠 上下文较长，正在整理记忆…", {
								replyTo: route.sourceMessageId,
								threadId: route.threadId,
							}, `compaction:${route.chatId}:${route.runId ?? ""}`);
						} else if (phase === "failed") {
							void rt.convManager?.notifyNow(route.chatId, `⚠️ 上下文整理失败，已继续本轮${detail ? `（${detail}）` : ""}`, {
								replyTo: route.sourceMessageId,
								threadId: route.threadId,
							}, `compaction-failed:${route.chatId}:${route.runId ?? ""}`);
						}
					},
					markSettled: (sessionId) => {
						const route = rt.convManager?.routeForSessionId(sessionId);
						if (!route) return;
						log.info("feishu.bridge.agent_settled", { chatId: route.chatId });
						rt.convManager?.markSettled(sessionId);
					},
					// agent 自定义卡片（默认关闭：关闭时子会话里根本不注册这个工具）
					cardTool: () => rt.config.cardTool?.enabled === true,
					docTool: () => rt.config.docTools?.enabled === true,
					readDoc: async (ref) => {
						if (!rt.transport) return { content: [{ type: "text", text: "飞书连接不可用" }], isError: true };
						const result = await readDocText((opts) => rt.transport!.rawRequest(opts), ref, rt.config.docTools?.maxChars ?? 30_000);
						if (!result.ok) return { content: [{ type: "text", text: result.error }], isError: true };
						return { content: [{ type: "text", text: result.truncated ? `${result.text}\n\n…（文档较长，已截断）` : result.text || "（文档为空）" }] };
					},
					sendCard: (input) => sendAgentCard(input.params, input.route),
					sendLocalFile: (input) => queueLocalFile({
						toolCallId: input.toolCallId,
						path: input.path,
						caption: input.caption,
						cwd: input.cwd,
						homeDir: rt.homeDir,
						route: input.route,
						outbox: rt.outbox,
					}),
					// 当前会话内的主动文本通知 —— 只认活动路由，走 durable notify
					notifyText: async (input) => {
						const route = input.route;
						if (!route?.chatId) return { status: "rejected" as const, detail: "没有活动会话" };
						const opts = { replyTo: route.sourceMessageId, threadId: route.threadId };
						const dedupeKey = `${route.conversationKey}:${input.toolCallId}:notify`;
						if (rt.outbox) {
							const ids = rt.outbox.enqueue(route.chatId, input.text, opts, {
								dedupeKey, laneKey: route.conversationKey, kind: "notify",
							});
							// 同一 toolCallId 重试只入队一次（outbox 按 dedupeKey 幂等）
							return ids.length > 0
								? { status: "queued" as const }
								: { status: "delivered" as const, detail: "该通知已入队" };
						}
						const res = await rt.convManager?.notifyNow(route.chatId, input.text, opts, dedupeKey);
						return res?.success
							? { status: "delivered" as const }
							: { status: "rejected" as const, detail: res?.error ?? "发送失败" };
					},
					allowedOperatorIds: () => effectiveAdmins(rt.config),
				// 澄清提问 —— 卡片优先后退化为文本选项，等待有界超时
				askChoice: async (input) => {
					if (!rt.clarificationStore) return { status: "unavailable" as const, detail: "澄清存储未初始化" };
					if (!input.route?.chatId) return { status: "unavailable" as const, detail: "没有活动会话" };
					const pending = rt.clarificationStore.create({
						conversationKey: input.route.conversationKey, chatId: input.route.chatId, threadId: input.route.threadId,
						runId: input.route.runId ?? input.toolCallId, toolCallId: input.toolCallId,
						question: input.question, options: input.options,
					});
					// 卡片优先：发送失败（例如无卡片权限）退化为文本选项，用户回复文本时按普通消息继续
					let cardSent = false;
					try {
						const messageId = await rt.transport?.sendCard(input.route.chatId, buildClarificationCard(pending), {
							replyTo: input.route.sourceMessageId, threadId: input.route.threadId,
						});
						rt.clarificationStore.attachCard(pending.id, messageId);
						cardSent = Boolean(messageId);
					} catch (error) {
						log.warn("feishu.clarify.card_failed", { error: error instanceof Error ? error.message : String(error) });
					}
					if (!cardSent) {
						const fallback = clarificationTextFallback(pending);
						if (rt.outbox) {
							rt.outbox.enqueue(input.route.chatId, fallback, { replyTo: input.route.sourceMessageId, threadId: input.route.threadId }, {
								dedupeKey: `${input.route.conversationKey}:${input.toolCallId}:clarify`, laneKey: input.route.conversationKey, kind: "notify",
							});
						}
					}
					return await pending.verdict;
				},
					redactParams,
					log: (level, msg, meta) => log[level](msg, meta),
				}),
			}),
			resolveUserName: (openId) => rt.transport?.resolveUserName(openId) ?? Promise.resolve(undefined),
			usageLedger: rt.usageLedger,
			deliverExternal: (target, text) => rt.transport
				? deliverDocCommentReply((opts) => rt.transport!.rawRequest(opts), target, text)
				: Promise.resolve(false),
			cnyPerUsd: (model) => usageProviderFor(rt.config).cnyPerUsd(model),
			exportsDir: paths.exportsDir,
			sendLocalFile: (chatId, path, opts, meta) => {
				if (!rt.outbox) return { ok: false, error: "outbox 不可用" };
				try {
					const staged = stageArtifact(validateLocalArtifact(path, dirname(path)), join(rt.homeDir, "feishu-bridge", "media-outbox"));
					rt.outbox.enqueueMedia(chatId, staged, opts, { ...meta, kind: "media" });
					return { ok: true };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message.slice(0, 120) : String(error) };
				}
			},
			pendingFile: join(paths.sessionDir, "..", "pending.jsonl"),
			// 会话指针持久化 —— /new 后重启仍处于新会话，不回退到旧上下文。
			conversationFile: join(paths.sessionDir, "..", "conversations.jsonl"),
			modelUsageFile: paths.modelUsageFile,
			// run 结束/会话重置时撤销未决审批卡（旧卡不得再授予权限）。
			// 有未决审批的会话不允许回收句柄（避免审批卡失去响应目标）。
			pendingApprovalCount: (conversationKey) =>
				(rt.permissionBridge?.pendingForConversation(conversationKey) ?? 0)
				+ (rt.clarificationStore?.pendingForConversation(conversationKey) ?? 0),
			onApprovalInvalidate: ({ conversationKey, runId, reason }) => {
				if (!rt.permissionBridge) return;
				const cancelled = runId
					? rt.permissionBridge.cancelRun(conversationKey, runId)
					: rt.permissionBridge.cancelConversation(conversationKey);
				// 同一 run 的未决提问一并失效（旧卡片不得再影响新状态）
				const clarifyCancelled = runId
					? rt.clarificationStore?.cancelRun(conversationKey, runId) ?? 0
					: rt.clarificationStore?.cancelConversation(conversationKey) ?? 0;
				if (cancelled > 0 || clarifyCancelled > 0) {
					log.info("feishu.approval.invalidated", { conversationKey, runId, reason, cancelled, clarifyCancelled });
				}
			},
			sender: rt.sender,
			durableOutbox: rt.outbox,
			resourceResolver: new ResourceResolver({
				baseDir: join(paths.sessionDir, "..", "resources"),
				download: (ref, maxBytes) => rt.transport!.downloadResource(ref, maxBytes),
				// 语音转写（默认关闭）
				transcribe: createTranscriber(rt.config.stt, { log: (level, m, meta) => log[level](m, meta) }),
			}),
			editMessage: (messageId, text) => rt.transport?.editMessage(messageId, text) ?? Promise.resolve(false),
			recallMessage: (messageId) => rt.transport?.recallMessage(messageId) ?? Promise.resolve(false),
			lastSent: rt.lastSent,
			reactions: {
				add: (messageId, emoji) => rt.transport!.addReaction(messageId, emoji),
				remove: (messageId, reactionId) => rt.transport!.removeReaction(messageId, reactionId),
			},
			log: (level, m, meta) => log[level](m, meta),
		});

		rt.pipeline = new InboundPipeline({
			config: rt.config,
			transport: rt.transport,
			lastSent: rt.lastSent,
			dedupeStore: new DedupeStore({ file: paths.dedupeFile, capacity: rt.config.dedupCacheSize, ttlMs: rt.config.dedupTtlMs }),
			// 准入通过即写 pending ledger，消除 dedupe→ledger 丢失窗口。
			intake: rt.convManager?.intakeLedger(),
			onDispatch: async (msg) => { await rt.convManager!.route(msg); },
			onCommand: handleFeishuCommand,
			onDrop: (msg, reason, mentioned) => { void onAdmissionDrop(msg, reason, mentioned); },
			log: (level, m, meta) => log[level](m, meta),
		});
	}

	/** agent 卡片的按钮点击 → 校验签名与操作者 → 以 `[卡片点击] 按钮名` 进入会话。 */
	async function handleAgentCardClick(action: CardAction, value: Record<string, unknown>): Promise<unknown> {
		const field = (key: string) => (typeof value[key] === "string" ? value[key] as string : "");
		const payload = JSON.stringify([field("k"), field("c"), field("th"), field("o"), field("l"), field("t")]);
		const expected = Buffer.from(signCardValue(payload));
		const actual = Buffer.from(field("s"));
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
			return { toast: { type: "warning", content: "这张卡片已失效（机器人重启过），请让它重新发一张" } };
		}
		if (action.chatId !== field("c")) return { toast: { type: "warning", content: "卡片与当前会话不匹配" } };
		const owner = field("o");
		if (owner && owner !== action.operatorOpenId && !effectiveAdmins(rt.config).includes(action.operatorOpenId)) {
			return { toast: { type: "warning", content: "只有发起人或管理员可以点这张卡片" } };
		}
		const chatType = field("t") === "p2p" || field("t") === "topic" ? field("t") as "p2p" | "topic" : "group";
		const result = await rt.convManager?.route({
			messageId: `${action.messageId}#${action.token ?? randomBytes(6).toString("hex")}`,
			replyTarget: action.messageId, synthetic: true,
			chatId: field("c"), chatType, ...(field("th") ? { threadId: field("th") } : {}),
			senderId: action.operatorOpenId, isBot: false, msgType: "text",
			text: `[卡片点击] ${field("l")}`, mentions: [], resources: [], raw: undefined, ts: Date.now(),
		}, { conversationKey: field("k") });
		log.info("feishu.agent_card.click", { label: field("l"), operator: action.operatorOpenId, result: result ?? "unavailable" });
		return { toast: { type: result === "rejected" ? "warning" : "success", content: result === "rejected" ? "当前队列已满，请稍后再试" : `已选择：${field("l")}` } };
	}

	/** feishu_card 工具的实现（子会话内联扩展调用；只发到当前活动会话）。 */
	async function sendAgentCard(params: Record<string, unknown>, route: ReturnType<ConversationManager["routeForSessionId"]>): Promise<import("./pi-types.js").ExtensionToolResult> {
		if (!route || !rt.transport) return { content: [{ type: "text", text: "无法发送：当前不是由飞书消息触发的活动会话" }], isError: true };
		const labels = (Array.isArray(params.buttons) ? params.buttons : []).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 20)).slice(0, 6);
		if (labels.length === 0) return { content: [{ type: "text", text: "buttons 至少要有一个" }], isError: true };
		const chatType = route.chatType ?? (route.conversationKey.includes(":t:") ? "topic" : "group");
		const buttons = labels.map((label) => {
			const base = { k: route.conversationKey, c: route.chatId, th: route.threadId ?? "", o: route.senderId ?? "", l: label, t: chatType };
			return {
				tag: "button", size: "small", type: "primary", width: "fill",
				text: { tag: "plain_text", content: label },
				value: { op: "agent.card", ...base, s: signCardValue(JSON.stringify([base.k, base.c, base.th, base.o, base.l, base.t])) },
			};
		});
		const card = {
			schema: "2.0",
			config: { wide_screen_mode: true },
			...(typeof params.title === "string" && params.title.trim() ? { header: { title: { tag: "plain_text", content: params.title.trim().slice(0, 60) }, template: "blue" } } : {}),
			body: { elements: [{ tag: "markdown", content: String(params.content ?? "").slice(0, 3_000) }, ...buttons] },
		};
		try {
			await rt.transport.sendCard(route.chatId, card, { replyTo: route.sourceMessageId, threadId: route.threadId });
			return { content: [{ type: "text", text: `卡片已发送（按钮：${labels.join("、")}）。用户点击后会以「[卡片点击] 按钮名」的新消息告诉你，本轮可以先结束。` }] };
		} catch (error) {
			return { content: [{ type: "text", text: `卡片发送失败：${error instanceof Error ? error.message : String(error)}` }], isError: true };
		}
	}

	// feishu_send_local_file 只在子会话的内联扩展里注册（外层 TUI 会话不是飞书路由，注册了也只会报错）。


	/** 工具调用审批（外层 tool_call 与子会话内联扩展共用）。 */
	const gateToolCall = createToolGate({ rt, log });
	const psForwardingSync = new PsForwardingSync({ rt, log });

	pi.on("tool_call", async (event, ctx) => {
		const input = event as { toolCallId?: string; toolName?: string; input?: Record<string, unknown> };
		const sessionId = ctx.sessionManager.getSessionId();
		const route = rt.convManager?.routeForSessionId(sessionId);
		if (!route || !input.toolCallId || !input.toolName) return undefined;
		rt.convManager?.markPendingToolBoundary(sessionId);
		return gateToolCall({
			conversationKey: route.conversationKey,
			sessionId,
			runId: route.runId ?? input.toolCallId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			paramsText: redactParams(input.input, input.toolName),
			command: bashCommandOf(input.toolName, input.input),
			chatId: route.chatId,
			threadId: route.threadId,
			sourceMessageId: route.sourceMessageId,
			senderId: route.senderId,
			allowedOperatorIds: effectiveAdmins(rt.config),
		});
	});

	async function compensateMissed(outageStartedAt: number): Promise<void> {
		if (rt.compensationPromise) return rt.compensationPromise;
		rt.compensationPromise = (async () => {
			const endTime = Date.now();
			const result = await compensateKnownChats({
				chatIds: rt.knownChats?.values() ?? [],
				outageStartedAt,
				now: endTime,
				maxWindowMs: 5 * 60_000,
				maxPerChat: 50,
				list: (chatId, startTime, finishTime, limit) => rt.transport?.listChatHistory(chatId, startTime, finishTime, limit) ?? Promise.resolve([]),
				handle: (message) => rt.pipeline?.handle(message) ?? Promise.resolve(),
				onError: (chatId, error) => log.warn("history compensation failed", { chatId, error: error instanceof Error ? error.message : String(error) }),
			});
			rt.compensatedMessages += result.recovered;
			rt.compensationErrors += result.errors;
			rt.compensationTruncated += result.truncatedChats + (result.windowTruncated ? 1 : 0);
			updateStatus();
		})();
		try {
			await rt.compensationPromise;
		} finally {
			rt.compensationPromise = undefined;
		}
	}

	function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const run = rt.lifecycleTail.then(operation, operation);
		rt.lifecycleTail = run.then(() => undefined, () => undefined);
		return run;
	}

	function startBridge(): Promise<string> {
		return serializeLifecycle(startBridgeUnlocked);
	}

	async function startBridgeUnlocked(): Promise<string> {
		if (rt.started) return "already";
		// 父子声明要在任何桥会话创建之前落地（PS 每次工具调用时实时读进程环境）
		psForwardingSync.syncEnv();
		try {
			rt.appLock = AppLock.acquire(resolveAppLockFile(rt.homeDir, rt.config.appId), rt.config.appId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			rt.lastError = message;
			rt.reportedConnState = "error";
			// 锁由其他实例持有时不能覆盖 owner 的共享 status.json。
			setStatus("bridge", `飞书桥启动失败: ${message.slice(0, 60)}`);
			return `启动失败：${message}`;
		}
		rt.started = true;
		rt.stopping = false;
		rt.reportedConnState = "connecting";
		rt.lastError = undefined;
		rt.status.startedAt = Date.now();
		updateStatus();
		try {
			await featureHost.setup({ rt, log, replier: replierFor });
			await assemble();
			await rt.transport!.start();
			rt.outbox!.start();
			// 转发应答方要等 transport/outbox 就绪（弹卡要发得出去）。失败不阻塞桥启动：
			// 转发只是审批的升级路径，没起来退化成 PS 自己的判定（无人应答 → 拒绝）。
			try {
				await psForwardingSync.syncServer();
			} catch (error) {
				log.warn("feishu.approval.ps_forwarding_start_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			// 空闲会话回收巡检（无 active run/排队/审批且超 TTL 才回收句柄）
			rt.convManager?.startLifecycle();
			// 会话文件权限与归档；status 心跳（含告警巡检）
			runRetention();
			startHeartbeat();
			// 可选能力（定时任务等）在连接与发送队列就绪后启动
			await featureHost.start();
			// 查询应用归属人（owner/creator）与应用协作者，作为隐式管理员：自己驱动 agent
			// 时不必手工维护 open_id，且换应用后自动刷新（open_id 是按应用视角生成的）。
			// 注意：这些人只豁免群策略层；群内 @ 仍按 adminBypassMention（默认 false）判定。
			try {
				const info = await rt.transport?.rawRequest({
					url: `/open-apis/application/v6/applications/${rt.config.appId}`,
					method: "GET",
					params: { lang: "zh_cn" },
				});
				const app = ((info as { data?: { app?: Record<string, unknown> } })?.data?.app ?? {}) as Record<string, unknown>;
				const ownerId = ((app.owner as { owner_id?: string } | undefined)?.owner_id)
					?? (typeof app.creator_id === "string" ? app.creator_id : undefined);

				// 协作者（owner 也在该列表中）—— 与归属人合并去重。
				// 该接口可能因 scope 不足而失败，此时退化为仅有归属人，不影响启动。
				let collaboratorIds: string[] = [];
				try {
					const collab = await rt.transport?.rawRequest({
						url: `/open-apis/application/v6/applications/${rt.config.appId}/collaborators`,
						method: "GET",
						params: { user_id_type: "open_id", page_size: 50 },
					});
					const list = ((collab as { data?: { collaborators?: unknown[] } })?.data?.collaborators ?? []) as Array<Record<string, unknown>>;
					collaboratorIds = list
						.map((c) => (typeof c.user_id === "string" ? c.user_id : undefined))
						.filter((v): v is string => Boolean(v));
				} catch (collabError) {
					log.warn("feishu.config.app_collaborators_hydrate_failed", {
						error: collabError instanceof Error ? collabError.message : String(collabError),
						hint: "查询应用协作者失败，仅归属人生效；管理员仍按 config.admins 生效",
					});
				}

				// 角色分开记：展示时要区分"应用归属人"与"协作者"（协作者列表里也含归属人，去掉）
				rt.config.appOwnerId = ownerId;
				rt.config.appCollaboratorIds = collaboratorIds.filter((id) => id !== ownerId);
				const hydrated = [...new Set([ownerId, ...collaboratorIds].filter((v): v is string => Boolean(v)))];
				rt.config.implicitAdmins = hydrated;
				log.info("feishu.config.app_owner_hydrated", {
					hasOwner: Boolean(ownerId),
					collaboratorCount: collaboratorIds.length,
					totalImplicitAdmins: hydrated.length,
					adminBypassMention: rt.config.adminBypassMention === true,
				});
			} catch (error) {
				log.warn("feishu.config.app_owner_hydrate_failed", {
					error: error instanceof Error ? error.message : String(error),
					hint: "缺少 application:application:readonly scope 时无法查询应用归属人；管理员仍按 config.admins 生效",
				});
				rt.config.implicitAdmins = [];
			}
			setStatus("conn", "飞书桥启动中…");
			setStatus("bridge", "飞书桥已启动");
			log.info("feishu.bridge.features", { enabled: enabledFeatures(rt.config) });
			log.info("bridge started", { bot: rt.transport?.getBotIdentity() });
			updateStatus();
			return "started";
		} catch (err) {
			rt.started = false;
			await featureHost.stop().catch(() => undefined);
			const msg = err instanceof Error ? err.message : String(err);
			rt.lastError = msg;
			rt.reportedConnState = "error";
			rt.appLock?.release();
			rt.appLock = undefined;
			log.error("bridge start failed", { error: msg });
			setStatus("bridge", `飞书桥启动失败: ${msg.slice(0, 60)}`);
			updateStatus();
			return `启动失败：${msg}`;
		}
	}

	function stopBridge(): Promise<string> {
		return serializeLifecycle(stopBridgeUnlocked);
	}

	async function stopBridgeUnlocked(): Promise<string> {
		rt.stopping = true;
		reconnectSupervisor.cancel();
		stopHeartbeat();
		await featureHost.stop();
		try {
			rt.permissionBridge?.shutdown();
			// 先停应答方：未决的转发请求已被 shutdown() 判拒绝，等它们把响应写完再撤心跳，
			// 否则子会话要等满 10 分钟才知道没人服务。
			await rt.psForwarding?.stop();
			// 入站在后台处理，先给在途消息一个有时限的收尾窗口（写进待处理记录后重启可恢复）
			try {
				await Promise.race([rt.transport?.drainInbound(), new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
			} catch { /* best effort */ }
			try { await rt.pipeline?.stop(); } catch { /* best effort */ }
			// 先停空闲回收巡检，避免关闭过程中回收句柄
			rt.convManager?.stopLifecycle();
			// 未决提问全部失效（不假装重启后能恢复）
			const clarifyCancelled = rt.clarificationStore?.shutdown() ?? 0;
			if (clarifyCancelled > 0) log.info("feishu.clarify.shutdown", { cancelled: clarifyCancelled });
			try { await rt.convManager?.shutdown(); } catch { /* best effort */ }
			try { await rt.outbox?.stop(); } catch { /* best effort */ }
			try {
				await rt.transport?.stop();
			} catch {
				/* ignore */
			}
		} finally {
			rt.started = false;
			rt.reportedConnState = "disconnected";
			rt.downSince = undefined;
			rt.appLock?.release();
			rt.appLock = undefined;
			updateStatus();
			setStatus("bridge", "飞书桥已停止");
		}
		return "stopped";
	}

	// 受控重连（指数退避 + 抖动，1s → 60s）；watchdog 每秒巡检，握手宽限期 15s。
	// 细节与 2026-09 重连风暴的根因见 runtime/reconnect-supervisor.ts。
	const reconnectSupervisor = new ReconnectSupervisor({
		isActive: () => rt.started && !rt.stopping,
		target: () => rt.transport,
		// getter：supervisor 在 session_start 加载配置之前就构造了
		get selfHealMaxMs() { return rt.config.transport?.selfHealMaxMs; },
		onScheduled: (attempt, delay) => {
			setStatus("conn", `飞书桥重连中（第 ${attempt} 次）`);
			log.warn("transport reconnect scheduled", { attempts: attempt, delay: Math.round(delay) });
		},
		onError: (err) => {
			rt.lastError = err instanceof Error ? err.message : String(err);
			rt.reportedConnState = "error";
			rt.downSince ??= Date.now();
			log.error("reconnect failed", { error: rt.lastError });
			updateStatus();
		},
	});
	const watchdog = setInterval(() => reconnectSupervisor.tick(), 1_000);
	watchdog.unref?.();

	// ------------------------------------------------------------ 命令 ----

	/** 诊断上下文（只含计数与枚举，供 doctor/导出复用）。 */
	function diagnosticsContext() {
		updateStatus();
		return {
			lastErrorClass: rt.status.lastError ? "last_error_present" : undefined,
			outbox: rt.status.outbox,
			conversations: rt.status.conversations,
			pendingApprovals: rt.status.pendingApprovals ?? 0,
			budget: rt.convManager?.budgetSnapshot(),
			piVersion: process.env.PI_VERSION,
			reconnectsLast5m: reconnectSupervisor.reconnectsInWindow(),
			statusHeartbeatMs: rt.config.statusHeartbeatMs ?? 30_000,
			uptimeMs: Math.round(process.uptime() * 1_000),
			transport: { running: Boolean(rt.transport?.isRunning()), connected: Boolean(rt.transport?.isConnected()) },
			forwarding: {
				enabled: Boolean(rt.psForwarding),
				parentSessionId: rt.psForwardingParentId,
				// 心跳新鲜度 = 父会话真的在服务。缺了它子会话会判「父会话不在服务」而提前放弃，
				// 而这种情况在日志里只表现为"等到超时"，很难定位 —— 所以 doctor 里明说。
				serving: rt.psForwarding ? rt.psForwarding.isServing() : undefined,
				alwaysApproved: rt.alwaysApproved
					? {
						enabled: rt.config.approval.forwarding?.alwaysApprove !== false,
						count: rt.alwaysApproved.size,
						patterns: rt.alwaysApproved.list().map((rule) => rule.pattern),
					}
					: undefined,
			},
		};
	}

	function statusText(): string {
		updateStatus();
		const lines = [
			`连接: ${rt.status.connState}（重连 ${rt.status.reconnectCount} 次，近 5 分钟 ${rt.status.reconnectsLast5m ?? 0} 次）`,
			`bot: ${rt.status.botName ?? "?"} (${rt.status.botOpenId ?? "?"})`,
			`会话数: ${rt.status.conversations}`,
			`会话队列: queued ${rt.status.sessionQueues?.queued ?? 0} / active ${rt.status.sessionQueues?.active ?? 0} / waiting ${rt.status.sessionQueues?.waiting ?? 0}`,
			`待审批: ${rt.status.pendingApprovals ?? 0}`,
			`outbox: pending ${rt.status.outbox.pending} / sending ${rt.status.outbox.sending} / sent ${rt.status.outbox.sent} / failed ${rt.status.outbox.failed} / lanes ${rt.status.outbox.lanes} / oldest ${Math.round(rt.status.outbox.oldestAgeMs / 1000)}s`,
			`消息: 总 ${rt.status.messageTotal} / 丢弃 ${rt.status.messageDropped}`,
			`补收: ${rt.status.compensatedMessages} / 错误 ${rt.status.compensationErrors} / 窗口截断 ${rt.status.compensationTruncated}`,
			`策略: 全局 ${rt.config.groupPolicy}${Object.keys(rt.config.groupPolicyByChat).length ? `，覆盖 ${JSON.stringify(rt.config.groupPolicyByChat)}` : ""}`,
			`群白名单: ${rt.config.allowChats.length ? rt.config.allowChats.join(", ") : "（全部群按策略）"}`,
		];
			// 预算/熔断状态（限流冷却时显示恢复时间，明确 final 不受影响）
			const budget = rt.convManager?.budgetSnapshot();
			if (budget) {
				const live = budget.categories.live ?? { tokens: 0, rejected: 0 };
				const notice = rt.convManager?.budgetCooldownNotice?.();
				lines.push(notice
					? `限流预算: ${notice}`
					: `限流预算: live 令牌 ${live.tokens} / 跳过 ${live.rejected} / 连续失败 ${budget.failures}`);
			}
			if (rt.status.lastMessageAt) {
				// 用配置时区而不是容器时区：容器常是 UTC，直接 toLocaleTimeString() 会差 8 小时。
				lines.push(`最近消息: ${formatTimeInZone(rt.status.lastMessageAt, rt.config.timezone)}`);
			}
			if (rt.status.lastError) lines.push(`最近错误: ${rt.status.lastError.slice(0, 200)}`);
			if (feedbackCounts.up || feedbackCounts.down) lines.push(`反馈（本次启动以来）: 👍 ${feedbackCounts.up} / 👎 ${feedbackCounts.down}`);
			lines.push(...featureHost.statusLines());
			for (const failure of rt.outbox?.recentFailures(3) ?? []) {
				lines.push(`发送失败: ${failure.kind} @ ${formatTimeInZone(failure.updatedAt, rt.config.timezone)} · ${(failure.lastError ?? "").slice(0, 80)}`);
			}
		return lines.join("\n");
	}

	pi.registerCommand("feishu:status", {
		description: "飞书桥状态",
		handler: () => statusText(),
	});
	pi.registerCommand("feishu:start", {
		description: "启动飞书桥",
		handler: async () => startBridge(),
	});
	pi.registerCommand("feishu:stop", {
		description: "停止飞书桥",
		handler: async () => stopBridge(),
	});
	pi.registerCommand("feishu:restart", {
		description: "重启飞书桥",
		handler: async () => {
			await stopBridge();
			return startBridge();
		},
	});
	// 撤销入口：「始终批准」是一条**持久放行**，必须能看、能撤。
	// 没有它，一次点击就等于永久放开一部分审批，而且无人能收回。
	pi.registerCommand("feishu:always", {
		description: "查看/撤销「始终批准」规则：/feishu:always [revoke <规则名>]",
		// TUI 是本地操作（能开 TUI 的人本来就持有进程），不做身份校验；飞书侧同名命令有管理员校验。
		handler: (_args, _ctx, args: string[]) => alwaysApprovedCommand({ rt, log }, args ?? [], { prefix: "/feishu:always" }),
	});
	pi.registerCommand("feishu:policy", {
		description: "设置单群策略：/feishu:policy <chatId> <open|mention|disabled|allowlist|blacklist|admin_only>",
		handler: (_args, _ctx, args: string[]) => {
			const [chatId, policy] = args;
			if (!chatId || !policy || !VALID_POLICIES.includes(policy as GroupPolicy)) return `用法：/feishu:policy <chatId> <${VALID_POLICIES.join("|")}>`;
			return setChatPolicy({ rt }, chatId, policy as GroupPolicy) ? `已设置 ${chatId} → ${policy}（已落盘）` : "落盘失败，运行态未修改";
		},
	});
	pi.registerCommand("feishu:debug", {
		description: "开关 debug 日志：/feishu:debug on|off",
		handler: (_args, _ctx, args: string[]) => {
			const flag = args[0];
			if (flag !== "on" && flag !== "off") return "用法：/feishu:debug on|off";
			rt.config.debug = flag === "on";
			saveConfigFields(rt.homeDir, rt.config, ["debug"]);
			return `debug = ${rt.config.debug}`;
		},
	});

	// ------------------------------------------------------------ 生命周期 ----

	// 工具执行进度（方案 A）：tool_execution_start/end → 进度消息更新
	// （daemon-host 架构下主进程可收到子进程 agent 的工具事件，pi-feishu-link 同款用法）
	pi.on("tool_execution_start", (event, ctx) => {
		const sessionId = (ctx as { sessionManager?: { getSessionId(): string } })?.sessionManager?.getSessionId() ?? "";
		const ev = event as { toolName?: string; args?: unknown };
		const toolName = ev.toolName ?? "tool";
		const toolCallId = typeof (ev as { toolCallId?: unknown }).toolCallId === "string" ? (ev as { toolCallId: string }).toolCallId : undefined;
		rt.convManager?.onToolEvent(sessionId, toolName, "start", (ev.args ?? {}) as Record<string, unknown>, toolCallId);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const sessionId = (ctx as { sessionManager?: { getSessionId(): string } })?.sessionManager?.getSessionId() ?? "";
		const toolName = (event as { toolName?: string })?.toolName ?? "tool";
		const endToolCallId = typeof (event as { toolCallId?: unknown }).toolCallId === "string" ? (event as { toolCallId: string }).toolCallId : undefined;
		rt.convManager?.onToolEvent(sessionId, toolName, "end", undefined, endToolCallId);
	});

	pi.on("session_start", async () => {
		rt.homeDir = process.env.FEISHU_BRIDGE_HOME ?? pi.getAgentDir();
		rt.config = loadConfig(rt.homeDir);
		// PS 父会话转发的父子声明越早越好：它要在任何桥会话被创建之前就位。
		psForwardingSync.syncEnv();
		if (!rt.config.appId || !rt.config.appSecret) {
			log.warn("FEISHU_APP_ID/SECRET 未配置，桥未启动。请配置后运行 /feishu:start。");
			return;
		}
		await startBridge();
		// 网关重启恢复：重发上次中断的未完成消息（hermes resume_pending）
		const recovered = await rt.convManager?.recoverPending() ?? 0;
		if (recovered > 0) log.warn("bridge recovered pending messages", { count: recovered });
	});

	// 优雅关闭：docker stop/restart 时撤回进行中的进度消息与 Typing 表情，
	// 避免残留"🤖 正在处理…"消息和敲键盘表情（kill -9 时由 recoverPending 兜底重发）。
	// 关闭预算 8s（Docker 默认 10s 后 SIGKILL）。旧的 3s 比 shutdown 内部几段 2s 等待之和还短，
	// outbox 在途请求会被截断；8s 给处理完入站消息、收尾进度、等在途发送留足时间，又不至于被 SIGKILL。
	process.on("SIGTERM", () => {
		const budgetMs = Number(process.env.FEISHU_SHUTDOWN_BUDGET_MS) || 8_000;
		const started = Date.now();
		setTimeout(() => {
			log.warn("feishu.shutdown.budget_exceeded", { budgetMs });
			process.exit(0);
		}, budgetMs).unref();
		void stopBridge().finally(() => {
			log.info("feishu.shutdown.done", { ms: Date.now() - started });
			process.exit(0);
		});
	});

	pi.on("session_shutdown", async () => {
		rt.stopping = true;
		reconnectSupervisor.cancel();
		clearInterval(watchdog);
		await stopBridge();
	});
}
