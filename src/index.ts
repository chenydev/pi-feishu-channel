/**
 * pi-feishu-channel 扩展入口：装配 transport/pipeline/session/sender/outbox，
 * 提供 /feishu 命令与连接 supervisor（指数退避重连）。
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "./pi-types.js";
import type { BridgeConfig, BridgeStatus, FeishuInboundMessage, GroupPolicy, SessionBackend } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { loadConfig, resolveAppLockFile, resolvePaths, resolveFooterEnabled, saveConfigFields, formatTimeInZone } from "./config.js";
import type { FeishuTransport, LarkSdkLike } from "./inbound/transport.js";
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
import { bashCommandOf, createBridgeInlineExtension, type BridgeGateInput } from "./session/pi-bridge-hooks.js";
import { PermissionBridge, redactParams, type ApprovalChoice } from "./approval/permission-bridge.js";
import { AlwaysApprovedStore } from "./approval/always-approved-store.js";
import {
	PS_FORWARDING_PARENT_ENV_KEYS,
	PS_FORWARDING_UPSTREAM_TIMEOUT_MS,
	PsForwardingServer,
	applyPsForwardingParentEnv,
	psForwardingRootDir,
	resolvePsForwardingConfig,
} from "./approval/ps-forwarding.js";
import { classifyCommand } from "./approval/command-policy.js";
import { buildApprovalCard, type ApprovalCardResolution } from "./approval/cards.js";
import { buildModelStatusCard, buildModelsTable } from "./commands/models-card.js";
import { buildUsageCard, formatUsageReport } from "./commands/usage-card.js";
import { createUsageProvider, type UsageProvider } from "./outbound/usage-provider.js";
import { splitModelTarget, writeGlobalDefaults } from "./config/global-defaults.js";
import {
	ClarificationStore,
	buildClarificationCard,
	buildClarificationResultCard,
	clarificationTextFallback,
} from "./interaction/clarification-store.js";
import type { CardAction } from "./inbound/transport.js";
import { formatDoctor, runDoctor } from "./runtime/doctor.js";
import { buildDiagnosticsBundle, writeDiagnosticsBundle } from "./runtime/diagnostics.js";
import { buildConversationKey } from "./session/conversation-key.js";
import { KnownChatStore } from "./runtime/known-chat-store.js";
import { ReconnectSupervisor } from "./runtime/reconnect-supervisor.js";
import { CardTokenDedupe, authorizeSessionCardAction } from "./interaction/card-actions.js";
import { COMMANDS, DIRECT_BASH_PREFIX, formatHelpText, resolveCommand, suggestCommand } from "./commands/registry.js";
import { atList, buildAccessNoticeCard, buildAccessRequestCard, buildAllowChatCard, buildHelpCard, buildNewSessionCard, buildResultCard, buildSessionsCard, buildWelcomeCard } from "./commands/cards.js";
import { AccessRequestTracker, planAccessRequest } from "./runtime/access-request.js";
import { accessApproverHint, accessApproverPolicy, accessApprovers, canApproveAccess, describeByRole, roleOf } from "./runtime/admin-roles.js";
import { loadPsConfig, psBashVerdict, summarizeApprovalPolicy } from "./approval/policy-summary.js";
import { UsageLedger, formatUsageWeek } from "./runtime/usage-ledger.js";
import { CronScheduler, parseCronAdd } from "./runtime/cron.js";
import { AlertMonitor, DEFAULT_ALERT_OPTIONS } from "./runtime/alerts.js";
import type { LifecycleEvent } from "./inbound/transport.js";
import { archiveOldSessions, tightenSessionPermissions } from "./runtime/retention.js";
import { createTranscriber } from "./inbound/stt.js";
import { enabledFeatures } from "./features/switches.js";

export interface BridgeLogger {
	debug(msg: string, meta?: unknown): void;
	info(msg: string, meta?: unknown): void;
	warn(msg: string, meta?: unknown): void;
	error(msg: string, meta?: unknown): void;
}

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
	try { piAgentDir = pi.getAgentDir(); } catch { /* 老版本 pi / 测试桩 */ }
	let started = false;
	let stopping = false;
	let transport: FeishuTransport | undefined;
	let pipeline: InboundPipeline | undefined;
	let convManager: ConversationManager | undefined;
	let sender: Sender | undefined;
	let outbox: Outbox | undefined;
	let lastSent: LastSentCache | undefined;
	let permissionBridge: PermissionBridge | undefined;
	/** DeepSeek 余额客户端（首次用到才建，避免启动时做外部请求）。 */
	let usageProvider: UsageProvider | undefined;
	// pi-permission-system 父会话转发（实验性，默认关）：桥充当应答方，把 PS 的 ask 变成审批卡。
	let psForwarding: PsForwardingServer | undefined;
	/** 「始终批准」规则表（转发路径）；未启用时为 undefined。 */
	let alwaysApproved: AlwaysApprovedStore | undefined;
	let psForwardingParentId: string | undefined;
	/** 本进程自己声明过的父会话 id（撤回时只删自己设的值，不动外层 spawner 的声明）。 */
	let psForwardingOwnEnvId: string | undefined;
	// 澄清提问（与审批完全独立，选择不授予任何工具权限）
	let clarificationStore: ClarificationStore | undefined;
	let config: BridgeConfig = DEFAULT_CONFIG;
	let homeDir = "";
	let appLock: AppLock | undefined;
	let reportedConnState: BridgeStatus["connState"] = "disconnected";
	let downSince: number | undefined;
	let lastError: string | undefined;
	let knownChats: KnownChatStore | undefined;
	let compensatedMessages = 0;
	let compensationErrors = 0;
	let compensationTruncated = 0;
	let compensationPromise: Promise<void> | undefined;
	let lifecycleTail: Promise<void> = Promise.resolve();
	/** 按天用量记录。 */
	let usageLedger: UsageLedger | undefined;
	/** 定时任务（config.cron.enabled 时才建）。 */
	let cronScheduler: CronScheduler | undefined;
	/** 告警（config.alerts.enabled 时才建）与心跳定时器。 */
	let alertMonitor: AlertMonitor | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let status: BridgeStatus = {
		connState: "disconnected",
		reconnectCount: 0,
		conversations: 0,
		outboxDepth: 0,
		outbox: { pending: 0, sending: 0, sent: 0, failed: 0, lanes: 0, oldestAgeMs: 0 },
		messageTotal: 0,
		messageDropped: 0,
		compensatedMessages: 0,
		compensationErrors: 0,
		compensationTruncated: 0,
	};

	const log: BridgeLogger = {
		debug: (m, meta) => console.debug(`[feishu-bridge] ${m}`, meta ?? ""),
		info: (m, meta) => console.log(`[feishu-bridge] ${m}`, meta ?? ""),
		warn: (m, meta) => console.warn(`[feishu-bridge] ${m}`, meta ?? ""),
		error: (m, meta) => console.error(`[feishu-bridge] ${m}`, meta ?? ""),
	};

	function setStatus(key: "conn" | "bridge", text: string): void {
		try {
			pi.ui.setStatus(`feishu-${key}`, text);
		} catch {
			/* no-ui */
		}
	}

	function updateStatus(): void {
		const stats = pipeline?.getStats();
		const outboxStats = outbox?.stats() ?? { pending: 0, sending: 0, sent: 0, failed: 0, lanes: 0, oldestAgeMs: 0 };
		status = {
			appId: config.appId || undefined,
			pid: process.pid,
			updatedAt: Date.now(),
			connState: transport?.isConnected() ? "connected" : reportedConnState === "error" ? "error" : transport?.isRunning() ? "connecting" : "disconnected",
			downSince,
			lastError,
			reconnectCount: reconnectSupervisor.totalReconnects,
			reconnectsLast5m: reconnectSupervisor.reconnectsInWindow(),
			startedAt: status.startedAt,
			botOpenId: transport?.getBotIdentity().openId,
			botName: transport?.getBotIdentity().name,
			conversations: convManager?.count() ?? 0,
			sessionQueues: convManager?.queueStats() ?? { queued: 0, active: 0, waiting: 0 },
			pendingApprovals: permissionBridge?.pendingCount() ?? 0,
			outboxDepth: outboxStats.pending + outboxStats.sending,
			outbox: outboxStats,
			lastMessageAt: stats?.lastMessageAt,
			messageTotal: stats?.total ?? 0,
			messageDropped: stats?.dropped ?? 0,
			compensatedMessages,
			compensationErrors,
			compensationTruncated,
			features: enabledFeatures(config),
		};
		if (homeDir) {
			try { writeStatus(resolvePaths(homeDir).statusFile, status); } catch (error) {
				log.error("status write failed", { error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	/** 管理员/应用归属人判定（统一走 effectiveAdmins，避免换应用后视角失效）。 */
	function isAdminSender(msg: { senderId: string }): boolean {
		return effectiveAdmins(config).includes(msg.senderId);
	}

	/** 卡片回调 token 去重（飞书重投同一次点击时不重复执行）。 */
	const cardTokens = new CardTokenDedupe();

	async function handleCardAction(action: CardAction): Promise<unknown> {
		const value = action.value ?? {};
		log.info("feishu.card.action", {
			messageId: action.messageId, op: typeof value.op === "string" ? value.op : null,
			operator: action.operatorOpenId, hasValue: action.value !== undefined,
		});
		if (!cardTokens.accept(action.token)) {
			log.info("feishu.card.duplicate_token", { messageId: action.messageId });
			return undefined;
		}
		if (value.op === "thinking.set" || value.op === "models.toggle" || value.op === "model.set") {
			const denied = authorizeSessionCardAction(action, value, effectiveAdmins(config));
			if (denied) {
				log.warn("feishu.card.unauthorized", { op: value.op, operator: action.operatorOpenId, reason: denied });
				return { toast: { type: "warning", content: denied } };
			}
		}
		const owner = typeof value.owner === "string" ? { ownerOpenId: value.owner } : {};
		// 模型列表卡片是**纯展示**的（表格自带客户端分页），没有回调分支 ——
		// 切换模型走 /model <provider>/<id> 命令，不把列表变成表单。

		// /model 状态卡：点档位按钮即切换思考等级（等价于 /thinking <level>），
		// 然后原地刷新卡片 —— 按钮的勾与禁用态要跟着变，否则用户会以为没生效。
		if (value.op === "thinking.set") {
			if (typeof value.level !== "string" || typeof value.conversationKey !== "string") return undefined;
			const result = await convManager?.commands.setThinkingByKey(value.conversationKey, value.level);
			if (!result?.ok) {
				log.warn("feishu.card.thinking_set_failed", { level: value.level, reason: result?.reason ?? "unknown" });
				return { toast: { type: "warning", content: result?.reason ?? "切换失败" } };
			}
			log.info("feishu.card.thinking_set", { level: value.level, conversationKey: value.conversationKey });
			const data = await convManager?.commands.modelStatusCardDataByKey(value.conversationKey);
			if (!data) return { toast: { type: "success", content: `已切换到 ${value.level}` } };
			// 把这次执行的命令写进卡片：用户点的是按钮，但等价于发了一条斜杠命令，
			// 露出来才能复制去加 -g（全局默认）或转发给别人。
			return {
				toast: { type: "success", content: `已切换到 ${value.level}` },
				card: { type: "raw", data: buildModelStatusCard({ ...data, ...owner, lastExecuted: `/thinking ${value.level}` }) },
			};
		}

		// /model 状态卡的模型表格：**在同一张卡里展开/收起**（不再另发一张卡）。
		// 展开态不记忆：任何一次刷新都回到收起 —— 表格是临时查阅用的，
		// 用户要的是随时能回到干净的状态卡。
		if (value.op === "models.toggle") {
			if (typeof value.conversationKey !== "string") return undefined;
			const expanded = value.expanded === true;
			const data = await convManager?.commands.modelStatusCardDataByKey(value.conversationKey);
			if (!data) {
				log.warn("feishu.card.models_toggle_failed", { conversationKey: value.conversationKey });
				return { toast: { type: "warning", content: "会话已失效，请重新发送 /model" } };
			}
			log.info("feishu.card.models_toggle", { expanded, conversationKey: value.conversationKey });
			// 展开时给回执（等价命令就是 /models）；收起不给 —— 「收起」没有对应的
			// 斜杠命令，硬编一句"已执行：收起"只是假回执。
			return {
				card: {
					type: "raw",
					data: buildModelStatusCard({ ...data, ...owner, expanded, ...(expanded ? { lastExecuted: "/models" } : {}) }),
				},
			};
		}
		// 状态卡上的模型切换按钮（最近使用 / 快速切换）
		if (value.op === "model.set") {
			if (typeof value.model !== "string" || typeof value.conversationKey !== "string") return undefined;
			const result = await convManager?.commands.setModelByKey(value.conversationKey, value.model);
			if (!result?.ok) return { toast: { type: "warning", content: result?.reason ?? "切换失败" } };
			log.info("feishu.card.model_set", { model: value.model, conversationKey: value.conversationKey, operator: action.operatorOpenId });
			const data = await convManager?.commands.modelStatusCardDataByKey(value.conversationKey);
			if (!data) return { toast: { type: "success", content: `已切换到 ${value.model}` } };
			return {
				toast: { type: "success", content: `已切换到 ${value.model}` },
				card: { type: "raw", data: buildModelStatusCard({ ...data, ...owner, lastExecuted: `/model ${value.model}` }) },
			};
		}
		// 命令按钮 —— 以点击人身份"发送"该命令（只接受注册表里的命令）
		if (value.op === "command") {
			if (typeof value.command !== "string" || !action.chatId || !resolveCommand(value.command)) return undefined;
			const ownerId = typeof value.owner === "string" ? value.owner : undefined;
			if (ownerId && ownerId !== action.operatorOpenId && !effectiveAdmins(config).includes(action.operatorOpenId)) {
				return { toast: { type: "warning", content: "只有发起人或管理员可以操作这张卡片" } };
			}
			const chatType = value.chatType === "p2p" || value.chatType === "topic" ? value.chatType : "group";
			const nonce = `#${action.token ?? randomBytes(6).toString("hex")}`;
			const synthetic: FeishuInboundMessage = {
				messageId: action.messageId, dedupeNonce: nonce, replyTarget: action.messageId, synthetic: true,
				chatId: action.chatId, chatType, ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
				senderId: action.operatorOpenId, isBot: false, msgType: "text", text: value.command,
				mentions: [], resources: [], raw: undefined, ts: Date.now(),
			};
			// 后台执行：命令可能要建会话（首次几秒），不占卡片回调的 3 秒时限
			void handleFeishuCommand(synthetic).catch((error: unknown) => {
				log.warn("feishu.card.command_failed", { command: value.command, error: error instanceof Error ? error.message : String(error) });
			});
			return { toast: { type: "info", content: `已执行 ${value.command}` } };
		}
		// 私聊里的"放行此群"
		if (value.op === "chat.allow") {
			if (typeof value.chatId !== "string" || !value.chatId.startsWith("oc_")) return undefined;
			if (!canApproveAccess(config, action.operatorOpenId, approverPolicy())) return { toast: { type: "warning", content: `${accessApproverHint(approverPolicy())}可以放行群` } };
			if (config.allowChats.includes(value.chatId)) return { card: { type: "raw", data: buildResultCard(`群 \`${value.chatId}\` 已在放行列表中。`, "grey") } };
			const previous = [...config.allowChats];
			config.allowChats = [...config.allowChats, value.chatId];
			if (!saveConfigFields(homeDir, config, ["allowChats"])) {
				config.allowChats = previous;
				return { toast: { type: "error", content: "写入配置失败，未放行" } };
			}
			log.info("feishu.onboarding.chat_allowed", { chatId: value.chatId, operator: action.operatorOpenId });
			accessRequests?.clear(value.chatId);
			// 群里回告：申请人（有的话）+ 放行人
			const requester = typeof value.requester === "string" && value.requester.startsWith("ou_") ? value.requester : undefined;
			void sendChatCard(value.chatId, buildAccessNoticeCard(`${requester ? `${atList([requester])} ` : ""}本群已开通（由 ${operatorByRole(action.operatorOpenId)} 放行），现在 @ 我就可以使用了。`, "green"), {}, "allowed_notice");
			return {
				toast: { type: "success", content: "已放行" },
				card: { type: "raw", data: buildResultCard(`已放行群 \`${value.chatId}\`（写入 allowChats）。群里 @ 机器人即可使用。`) },
			};
		}
		// 开通申请：暂不放行（忽略期内该群不再发申请）
		if (value.op === "chat.deny") {
			if (typeof value.chatId !== "string" || !value.chatId.startsWith("oc_")) return undefined;
			if (!canApproveAccess(config, action.operatorOpenId, approverPolicy())) return { toast: { type: "warning", content: `${accessApproverHint(approverPolicy())}可以操作` } };
			accessRequests ??= new AccessRequestTracker({ cooldownMs: config.onboarding?.accessRequestCooldownMs });
			accessRequests.markIgnored(value.chatId);
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
		}
		// agent 通过 feishu_card 工具发的卡片 —— 点击作为一条新消息进入会话
		if (value.op === "agent.card") {
			return handleAgentCardClick(action, value);
		}
		// 澄清选择 —— 只恢复等待点，不写任何授权
		if (value.op === "clarify") {
			if (typeof value.clarificationId !== "string" || typeof value.token !== "string" || typeof value.choice !== "string") return undefined;
			const decided = clarificationStore?.decide({
				id: value.clarificationId, token: value.token, messageId: action.messageId,
				chatId: action.chatId ?? "", operatorOpenId: action.operatorOpenId, choice: value.choice,
			});
			if (!decided?.ok) return { toast: { type: "warning", content: decided?.reason ?? "该提问已失效" } };
			return {
				toast: { type: "success", content: decided.reason },
				card: { type: "raw", data: buildClarificationResultCard(value.choice, action.operatorOpenId) },
			};
		}
		if (value.op !== "approval" || typeof value.approvalId !== "string" || typeof value.token !== "string") return undefined;
		const choice = value.choice;
		if (choice !== "once" && choice !== "session" && choice !== "always" && choice !== "deny") return undefined;
		const decision = permissionBridge?.decide({
			id: value.approvalId, token: value.token, messageId: action.messageId, chatId: action.chatId,
			operatorOpenId: action.operatorOpenId, choice: choice as ApprovalChoice,
		});
		if (!decision?.ok) return { toast: { type: "warning", content: decision?.reason ?? "审批已失效" } };
		// 原地更新同一张卡：保留原文与参数，标题改成结论、被选项加 ✓、其余禁用。
		const resolution: ApprovalCardResolution = {
			choice: choice as ApprovalChoice,
			resultText: decision.reason,
			operatorOpenId: action.operatorOpenId,
		};
		return {
			toast: { type: "success", content: decision.reason },
			...(decision.pending ? { card: { type: "raw", data: buildApprovalCard(decision.pending, resolution) } } : {}),
		};
	}

	/**
	 * 账户用量提供方（懒建；余额失败降级为 unavailable，不抛异常）。
	 *
	 * 只在 `/feishu usage` 里查余额，不打任何周期性外部请求；快照文件由
	 * `usage.snapshots` 控制（关掉就只查余额、不估速率）。`usage.provider: "none"` 完全不接厂商。
	 */
	function usageProviderFor(cfg: BridgeConfig): UsageProvider {
		usageProvider ??= createUsageProvider({
			provider: cfg.usage?.provider,
			apiKey: process.env.DEEPSEEK_API_KEY,
			balanceTtlMs: cfg.usage?.balanceTtlMs,
			snapshotPath: cfg.usage?.snapshots === false ? undefined : resolvePaths(homeDir).balanceSnapshotsFile,
			log: (level, message, meta) => log[level](message, meta),
		});
		return usageProvider;
	}

	/** 命令回执：走 durable outbox（合成消息按 dedupeNonce 区分，卡片按钮可以点很多次）。 */
	function commandReplier(msg: FeishuInboundMessage) {
		const replyTo = msg.replyTarget === null ? undefined : msg.replyTarget ?? msg.messageId;
		const reply = (text: string, suffix = "command") => {
			if (!outbox) throw new Error("outbox unavailable");
			outbox.enqueue(msg.chatId, text, { replyTo, threadId: msg.threadId }, {
				dedupeKey: `${msg.messageId}${msg.dedupeNonce ?? ""}:${suffix}`, laneKey: buildConversationKey(msg, config), kind: "notify",
			});
		};
		/** 卡片优先；发送失败（无权限/业务码非 0）返回 false，调用方退回文本回执。 */
		const trySendCard = async (card: unknown, what: string): Promise<boolean> => {
			if (!transport) return false;
			try {
				await transport.sendCard(msg.chatId, card, { replyTo, threadId: msg.threadId });
				return true;
			} catch (error) {
				log.warn("feishu.command.card_failed", { command: what, error: error instanceof Error ? error.message : String(error) });
				return false;
			}
		};
		return { reply, trySendCard };
	}

	/** Pi 侧的命令/模板/技能（纠错时不误伤、帮助里列出）。 */
	function piCommandList(): Array<{ name: string; description?: string; source?: string }> {
		try { return pi.getCommands?.() ?? []; } catch { return []; }
	}

	/** 会话是否多人共用（话题、不按人隔离的群）：导出这类会话要二次确认。 */
	function isSharedConversation(msg: FeishuInboundMessage): boolean {
		return buildConversationKey(msg, config).includes(":t:") || (msg.chatType === "group" && !config.groupSessionsPerUser);
	}

	/** `--global`/`-g` 在任意位置都算（对齐 hermes 的 /reasoning 解析）；去掉它之后剩下的才是值。 */
	function splitGlobalFlag(raw: string): { wantsGlobal: boolean; value: string } {
		const pattern = /(^|\s)(--global|-g)(\s|$)/;
		return { wantsGlobal: pattern.test(raw), value: raw.replace(/(^|\s)(--global|-g)(\s|$)/g, " ").trim() };
	}

	async function handleFeishuCommand(msg: FeishuInboundMessage): Promise<boolean> {
		const raw = msg.text.trim();
		// `!<命令>` 直接执行（默认关闭；不属于斜杠命令表）
		if (raw.startsWith(DIRECT_BASH_PREFIX) && config.directBash?.enabled) {
			await handleDirectBash(msg, raw.slice(DIRECT_BASH_PREFIX.length).trim());
			return true;
		}
		const resolved = resolveCommand(raw);
		if (!resolved) {
			// 像是打错的桥命令（且不是 Pi 的命令/模板/技能）→ 提示，而不是默默交给模型
			if (raw.startsWith("/")) {
				const known = new Set(piCommandList().map((command) => `/${command.name.toLowerCase()}`));
				const suggestion = suggestCommand(raw, known);
				if (suggestion) {
					commandReplier(msg).reply(`未知命令 ${raw.split(/\s+/)[0]}，是否想用 ${suggestion}？（/help 查看全部命令）`);
					return true;
				}
			}
			return false;
		}
		const { spec, args, rest } = resolved;
		const { reply, trySendCard } = commandReplier(msg);
		const isAdmin = isAdminSender(msg);
		const buttonCtx = { chatType: msg.chatType, threadId: msg.threadId, ownerOpenId: msg.senderId };
		log.info("feishu.command", { command: spec.name, chatId: msg.chatId, operator: msg.senderId, synthetic: Boolean(msg.synthetic) });

		switch (spec.name) {
			case "/help": {
				const piCommands = piCommandList();
				if (await trySendCard(buildHelpCard({ ...buttonCtx, isAdmin, piCommands, directBash: Boolean(config.directBash?.enabled) }), "help")) return true;
				reply(formatHelpText(COMMANDS, { piCommands: piCommands.filter((command) => command.source !== "extension") }));
				return true;
			}
			case "/feishu usage": {
				if (args[0]?.toLowerCase() === "week") {
					// 近 7 天汇总（本群；管理员在私聊里看全部）
					const all = isAdmin && msg.chatType === "p2p";
					const filter = all ? undefined : (record: { chatId: string }) => record.chatId === msg.chatId;
					const byDate = usageLedger?.summary(7, "date", filter) ?? [];
					const bySender = usageLedger?.summary(7, "sender", filter) ?? [];
					const names = new Map<string, string>();
					for (const row of bySender.slice(0, 10)) {
						const name = await transport?.resolveUserName(row.key).catch(() => undefined);
						if (name) names.set(row.key, name);
					}
					const budget = convManager?.budgetStatus(msg.chatId);
					const budgetLine = budget?.limit ? `\n\n本群今日：$${budget.spent.toFixed(2)} / 上限 $${budget.limit}` : "";
					reply(`${all ? "（全部会话）" : "（本群）"}${formatUsageWeek({ byDate, bySender }, (id) => names.get(id) ?? `…${id.slice(-4)}`)}${budgetLine}`);
					return true;
				}
				// 余额查询会打外部接口，所以走 TTL 缓存；失败也不阻止会话用量展示。
				const snapshot = convManager?.usageSnapshot(msg);
				const input = {
					...(snapshot ?? {}),
					tierText: usageProviderFor(config).tierLabel(new Date()),
					accountLabel: usageProviderFor(config).accountLabel ?? null,
					cnyPerUsd: (model: string | undefined) => usageProviderFor(config).cnyPerUsd(model),
					balance: await usageProviderFor(config).balance(),
					localTimeLabel: formatTimeInZone(Date.now(), config.timezone),
				};
				if (await trySendCard(buildUsageCard(input), "usage")) return true;
				reply(formatUsageReport(input));
				return true;
			}
			case "/feishu status":
				reply(`${statusText()}\n本群工具档位: ${convManager?.toolPolicyFor(msg.chatId) ?? "?"}`);
				return true;
			case "/feishu doctor":
				reply(formatDoctor(runDoctor({ config, paths: resolvePaths(homeDir), transport, diagnostics: diagnosticsContext() })));
				return true;
			case "/feishu approvals":
				reply(summarizeApprovalPolicy({
					config,
					ps: loadPsConfig(psConfigFile()),
					psInstalled: piPermissionSystemInstalled(),
					...(alwaysApproved ? { alwaysRules: alwaysApproved.list() } : {}),
					pendingApprovals: permissionBridge?.pendingCount() ?? 0,
				}));
				return true;
			case "/feishu export": {
				if (!isAdmin) { reply("仅管理员或应用归属人可导出诊断包"); return true; }
				try {
					const bundle = buildDiagnosticsBundle({
						config, context: diagnosticsContext(),
						checks: runDoctor({ config, paths: resolvePaths(homeDir), transport, diagnostics: diagnosticsContext() }),
						redactPaths: [homeDir, resolvePaths(homeDir).sessionDir, process.cwd()],
					});
					const dir = writeDiagnosticsBundle(homeDir, bundle);
					// 同时以文件形式私聊发给操作的管理员（不必再登录宿主机取）
					const sent = await sendDiagnosticsToAdmin(msg.senderId, bundle);
					reply(`已导出脱敏诊断包：${dir}/（0600，仅含计数与枚举；不含密钥、正文与绝对路径）${sent ? "\n已私聊发送给你。" : ""}`);
				} catch (error) {
					reply(`诊断包导出失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`);
				}
				return true;
			}
			case "/feishu policy": {
				if (!isAdmin) { reply("仅管理员或应用归属人可修改群策略"); return true; }
				if (msg.chatType === "p2p") { reply("群策略只能在群聊或话题中修改"); return true; }
				const policy = args[0] as GroupPolicy | undefined;
				if (!policy || !VALID_POLICIES.includes(policy)) { reply(`用法：/feishu policy <${VALID_POLICIES.join("|")}>`); return true; }
				reply(setChatPolicy(msg.chatId, policy) ? `已设置本群策略：${policy}` : "策略落盘失败，运行态未修改");
				return true;
			}
			case "/feishu footer": {
				// 页脚是"给人看的元信息"，每个群的信息密度需求不同 —— 交给该群管理员当场决定，
				// 而不是让所有人一起去改配置文件。缺省跟随全局 footer.enabled（默认开）。
				const state = resolveFooterEnabled(config, msg.chatId);
				const action = args[0]?.toLowerCase();
				if (!action) {
					reply([
						`本会话页脚：${state.enabled ? "开" : "关"}（${state.source === "chat" ? "管理员设置" : "全局默认"}）`,
						"用法：/feishu footer off 关闭本会话页脚；/feishu footer on 恢复显示（仅管理员或应用归属人）。",
					].join("\n"));
					return true;
				}
				if (action !== "on" && action !== "off") { reply("用法：/feishu footer [on|off]"); return true; }
				if (!isAdmin) { reply("仅管理员或应用归属人可修改本会话页脚设置"); return true; }
				const wanted = action === "on";
				const previous = config.footerByChat?.[msg.chatId];
				config.footerByChat = { ...(config.footerByChat ?? {}), [msg.chatId]: wanted };
				if (saveConfigFields(homeDir, config, [`footerByChat.${msg.chatId}`])) {
					log.info("feishu.footer.toggled", { chatId: msg.chatId, enabled: wanted, operator: msg.senderId });
					reply(wanted
						? "已开启本会话页脚（模型/耗时/上下文/累计用量/费用）。用 /feishu footer off 可关闭。"
						: "已关闭本会话页脚。用 /feishu footer on 可恢复；/feishu usage 仍可随时查看完整用量。");
				} else {
					// 落盘失败就回滚运行态：否则重启后又变回去，用户以为设置没生效
					if (previous === undefined) delete config.footerByChat[msg.chatId];
					else config.footerByChat[msg.chatId] = previous;
					reply("页脚设置落盘失败，运行态未修改");
				}
				return true;
			}
			case "/feishu always":
				// 「始终批准」是持久放行：必须能看、能撤，否则一次点击就等于永久放开一部分审批。
				reply(isAdmin ? alwaysApprovedCommand(args, { prefix: "/feishu always", operator: msg.senderId }) : "仅管理员或应用归属人可查看或撤销「始终批准」规则");
				return true;
			case "/feishu prompt":
				reply(await handlePromptCommand(msg, args, rest));
				return true;
			case "/feishu budget": {
				const current = convManager?.budgetStatus(msg.chatId);
				const action = args[0]?.toLowerCase();
				if (!action) {
					reply(current?.limit
						? `本群每日费用上限：$${current.limit}；今日已用 $${current.spent.toFixed(4)}。\n用法：/feishu budget <美元> 设置；/feishu budget off 取消（管理员）。`
						: `本群未设每日费用上限；今日已用 $${(current?.spent ?? 0).toFixed(4)}。\n用法：/feishu budget <美元>（管理员）。`);
					return true;
				}
				if (!isAdmin) { reply("仅管理员或应用归属人可设置费用上限"); return true; }
				const value = action === "off" ? undefined : Number.parseFloat(action.replace(/^\$/, ""));
				if (value !== undefined && (!Number.isFinite(value) || value <= 0)) { reply("用法：/feishu budget <大于 0 的美元数> | off"); return true; }
				const previous = config.groupRules[msg.chatId];
				const next = { ...(previous ?? {}) };
				if (value === undefined) delete next.dailyBudgetUsd;
				else next.dailyBudgetUsd = value;
				config.groupRules[msg.chatId] = next;
				if (saveConfigFields(homeDir, config, [`groupRules.${msg.chatId}.dailyBudgetUsd`])) {
					log.info("feishu.budget.set", { chatId: msg.chatId, value: value ?? null, operator: msg.senderId });
					reply(value === undefined ? "已取消本群每日费用上限。" : `已设置本群每日费用上限：$${value}（超限后新任务暂停到次日，80% 时提醒一次）。`);
				} else {
					if (previous === undefined) delete config.groupRules[msg.chatId];
					else config.groupRules[msg.chatId] = previous;
					reply("预算落盘失败，运行态未修改");
				}
				return true;
			}
			case "/new": {
				const force = args[0]?.toLowerCase() === "force";
				const result = await convManager?.resetConversation(msg, { force });
				if (!result) { reply("会话不可用"); return true; }
				if (result.status === "error") { reply(`开新会话失败：${result.reason}`); return true; }
				if (result.status === "busy") {
					reply(`当前有 ${result.pending} 个任务在执行或排队。回复 /new force 可取消它们并开新会话；或先 /stop 处理当前任务。`);
					return true;
				}
				permissionBridge?.resetSession(buildConversationKey(msg, config));
				const text = result.cancelled > 0 ? `已取消 ${result.cancelled} 个排队任务，并创建新的会话上下文` : "已创建新的会话上下文";
				// 回执带上一个会话的名字和"恢复"按钮（误操作能找回）
				if (result.hadPrevious && await trySendCard(buildNewSessionCard(text, { name: result.previousName, selector: "#2" }, buttonCtx), "new")) return true;
				reply(result.hadPrevious ? `${text}\n上一个会话${result.previousName ? `「${result.previousName}」` : ""}可用 /resume #2 找回。` : text);
				return true;
			}
			case "/stop":
				permissionBridge?.resetSession(buildConversationKey(msg, config));
				reply(await convManager?.stopConversation(msg)
					? "已请求停止当前任务；通过 /queue 排队的后续任务将继续执行"
					: "当前没有正在执行的任务");
				return true;
			case "/queue": {
				const sub = args[0]?.toLowerCase();
				if (sub === "list" && args.length === 1) {
					const snap = convManager?.queueSnapshot(msg);
					if (!snap || (!snap.active && snap.queued.length === 0)) { reply("当前没有执行中或排队的任务"); return true; }
					reply([
						snap.active ? `执行中：${snap.active}${snap.steered ? `（并入 ${snap.steered} 条）` : ""}` : "当前没有执行中的任务",
						...(snap.queued.length ? ["排队：", ...snap.queued.map((text, index) => `${index + 1}. ${text}`)] : ["排队：无"]),
					].join("\n"));
					return true;
				}
				if (sub === "clear" && args.length === 1) {
					const removed = await convManager?.clearQueued(msg) ?? 0;
					reply(removed > 0 ? `已清空 ${removed} 个排队任务（执行中的任务不受影响，要停止用 /stop）` : "队列本来就是空的");
					return true;
				}
				if (!rest) { reply("用法：/queue <内容> | list | clear（别名 /q）"); return true; }
				const result = await convManager?.queueConversation({ ...msg, text: rest });
				const position = convManager?.queueSnapshot(msg).queued.length ?? 0;
				reply(result === "rejected" ? "当前队列已满，请稍后再试" : position > 0 ? `已排队，第 ${position} 个` : "已加入后续任务队列");
				return true;
			}
			case "/steer": {
				if (!rest) { reply("用法：/steer <内容>"); return true; }
				const result = await convManager?.steerConversation({ ...msg, text: rest });
				reply(result === "steered" ? "已注入当前任务" : result === "queued" ? "当前任务已结束，已作为新任务执行" : "当前队列已满，请稍后再试");
				return true;
			}
			case "/retry":
				reply(await convManager?.retryConversation(msg) ?? "会话不可用");
				return true;
			case "/undo":
				reply(await convManager?.undoConversation(msg) ?? "会话不可用");
				return true;
			case "/fork":
				reply(args[0]?.toLowerCase() === "list"
					? await convManager?.forkCandidates(msg) ?? "会话不可用"
					: await convManager?.forkConversation(msg, args[0]) ?? "会话不可用");
				return true;
			case "/export": {
				const format = (args[0]?.toLowerCase() ?? "html") as "html" | "md" | "summary";
				if (!["html", "md", "summary"].includes(format)) { reply("用法：/export [html|md|summary]"); return true; }
				// 多人共用的会话：导出会把别人的发言一起带走 —— 非管理员要显式确认
				if (isSharedConversation(msg) && !isAdmin && args[1]?.toLowerCase() !== "confirm") {
					reply(`这是多人共用的会话，导出会包含其他人的发言。确认导出请发送 /export ${format} confirm`);
					return true;
				}
				reply(await convManager?.exportConversation(msg, format) ?? "会话不可用");
				return true;
			}
			case "/compact":
				reply(await convManager?.compactConversation(msg, rest || undefined) ?? "会话不可用");
				return true;
			case "/model": {
				// 无参 = 状态卡（当前模型 + 最近使用 + 档位按钮 + 「查看全部模型」按钮）。
				// 带参仍是命令式切换，保持文本回执 —— 那是一次性动作，不需要卡片。
				if (!args[0]) {
					const data = await convManager?.commands.modelStatusCardData(msg);
					if (data && await trySendCard(buildModelStatusCard({ ...data, ownerOpenId: msg.senderId }), "model")) return true;
				}
				const { wantsGlobal, value: target } = splitGlobalFlag(rest);
				const result = await convManager?.commands.modelConversation(msg, target || undefined) ?? "会话不可用";
				if (!wantsGlobal || !target) { reply(result); return true; }
				if (!isAdmin) { reply(`${result}\n（--global/-g 需要管理员或应用归属人）`); return true; }
				// 模糊匹配后以实际切换到的模型为准（回执里 "已切换模型：provider/id"）
				const switched = /^已切换模型：(\S+)/.exec(result)?.[1];
				if (!switched) { reply(result); return true; }
				const { model, provider } = splitModelTarget(switched);
				const written = writeGlobalDefaults(homeDir, { defaultModel: model, ...(provider ? { defaultProvider: provider } : {}) });
				reply(written.ok ? `${result}\n已设为全局默认：新建会话的模型 = ${switched}` : `${result}\n⚠️ 全局默认写入失败：${written.reason}`);
				log.info("feishu.global_default.written", { kind: "model", value: switched, ok: written.ok, operator: msg.senderId, reason: written.reason ?? null });
				return true;
			}
			case "/models": {
				// 表格卡片：飞书客户端自带分页（page_size）；页码只在文本降级时有意义，对用户一律从 1 开始数。
				const pageIndex = Math.max(1, Number.parseInt(args[0] ?? "1", 10) || 1) - 1;
				const data = pageIndex === 0 ? await convManager?.commands.modelsCardData(msg) : undefined;
				if (data && await trySendCard(buildModelsTable(data), "models")) return true;
				reply(await convManager?.commands.listModels(msg, pageIndex) ?? "会话不可用");
				return true;
			}
			case "/sessions": {
				const pageIndex = Math.max(1, Number.parseInt(args[0] ?? "1", 10) || 1) - 1;
				const page = await convManager?.commands.sessionsPage(msg, pageIndex);
				if (page === undefined) { reply("会话不可用"); return true; }
				if (typeof page === "string") { reply(page); return true; }
				// 卡片，每行一个"恢复"按钮
				if (await trySendCard(buildSessionsCard(page.entries, buttonCtx, page.footer), "sessions")) return true;
				reply(await convManager?.commands.listSessionsFor(msg, pageIndex) ?? "会话不可用");
				return true;
			}
			case "/name":
				reply(await convManager?.commands.renameConversation(msg, rest) ?? "会话不可用");
				return true;
			case "/resume":
				reply(await convManager?.commands.resumeConversation(msg, args[0]) ?? "会话不可用");
				return true;
			case "/workspace":
				// 查看（任何人）/ 切换（仅管理员）
				reply(await convManager?.commands.switchWorkspace(msg, args[0], { isAdmin }) ?? "会话不可用");
				return true;
			case "/thinking": {
				const { wantsGlobal, value: level } = splitGlobalFlag(rest);
				const result = await convManager?.commands.thinkingConversation(msg, level || undefined) ?? "会话不可用";
				if (!wantsGlobal || !level) { reply(result); return true; }
				// 改全局默认 = 影响所有人 → 限管理员/归属人（与会话级改动不同）
				if (!isAdmin) { reply(`${result}\n（--global/-g 需要管理员或应用归属人）`); return true; }
				const written = writeGlobalDefaults(homeDir, { defaultThinkingLevel: level });
				reply(written.ok ? `${result}\n已设为全局默认：新建会话的思考等级 = ${level}` : `${result}\n⚠️ 全局默认写入失败：${written.reason}`);
				log.info("feishu.global_default.written", { kind: "thinkingLevel", value: level, ok: written.ok, operator: msg.senderId, reason: written.reason ?? null });
				return true;
			}
			case "/cron":
				reply(await handleCronCommand(msg, args, rest, isAdmin));
				return true;
			default:
				return false;
		}
	}

	const VALID_POLICIES: readonly GroupPolicy[] = ["open", "mention", "disabled", "allowlist", "blacklist", "admin_only"];

	/** 设置单群策略（飞书与 TUI 共用；落盘失败回滚运行态 —— 两边语义一致）。 */
	function setChatPolicy(chatId: string, policy: GroupPolicy): boolean {
		const previous = config.groupPolicyByChat[chatId];
		config.groupPolicyByChat[chatId] = policy;
		if (saveConfigFields(homeDir, config, [`groupPolicyByChat.${chatId}`])) return true;
		if (previous === undefined) delete config.groupPolicyByChat[chatId];
		else config.groupPolicyByChat[chatId] = previous;
		return false;
	}

	/**
	 * 「始终批准」查看/撤销 —— 飞书 `/feishu always` 与 TUI `/feishu:always` 共用一份逻辑，
	 * 不要各写一份（文案与撤销语义会不一致）。身份校验由调用方负责。
	 */
	function alwaysApprovedCommand(args: string[], opts: { prefix: string; operator?: string }): string {
		if (!alwaysApproved) return "「始终批准」未启用（需要 pi-permission-system 转发模式）";
		if (args[0]?.toLowerCase() === "revoke") {
			const pattern = args.slice(1).join(" ").trim();
			if (!pattern) return `用法：${opts.prefix} revoke <规则名>（规则名见 ${opts.prefix}）`;
			const removed = alwaysApproved.remove(pattern);
			log.info("feishu.approval.always_revoked", { pattern, removed, operator: opts.operator ?? "tui" });
			return removed ? `已撤销规则「${pattern}」—— 下次同类请求会重新弹卡。` : `没有找到规则「${pattern}」。`;
		}
		const rules = alwaysApproved.list();
		if (rules.length === 0) return "当前没有「始终批准」的规则（所有 ask 都会弹卡）。";
		const lines = rules.map((rule) => `· ${rule.pattern}（${formatTimeInZone(rule.approvedAt, config.timezone)}${rule.approvedBy ? ` · ${rule.approvedBy}` : ""}）`);
		return [`「始终批准」规则共 ${rules.length} 条：`, ...lines, `用 ${opts.prefix} revoke <规则名> 撤销。`].join("\n");
	}

	/** `/feishu prompt [show|set <内容>|clear]` —— 群里改本群设定（管理员），私聊改个人偏好（本人）。 */
	async function handlePromptCommand(msg: FeishuInboundMessage, args: string[], rest: string): Promise<string> {
		const personal = msg.chatType === "p2p";
		const action = args[0]?.toLowerCase() ?? "show";
		const current = personal ? config.userPrompts?.[msg.senderId] : config.groupRules[msg.chatId]?.prompt;
		const scope = personal ? "你的个人提示词" : "本群提示词";
		if (action === "show") {
			return current
				? `${scope}：\n${current}\n\n/feishu prompt set <内容> 修改；/feishu prompt clear 清除。`
				: `${scope}未设置。/feishu prompt set <内容> 设置（${personal ? "只影响你的私聊" : "管理员；会话首轮注入，/new 后对新会话生效"}）。`;
		}
		if (action !== "set" && action !== "clear") return "用法：/feishu prompt [show|set <内容>|clear]";
		if (!personal && !isAdminSender(msg)) return "仅管理员或应用归属人可修改本群提示词";
		const text = action === "set" ? rest.replace(/^set\s*/i, "").trim() : "";
		if (action === "set" && !text) return "用法：/feishu prompt set <内容>";
		if (text.length > 2_000) return "提示词过长（最多 2000 字）";
		if (personal) {
			const previous = config.userPrompts?.[msg.senderId];
			const next = { ...(config.userPrompts ?? {}) };
			if (text) next[msg.senderId] = text;
			else delete next[msg.senderId];
			config.userPrompts = next;
			if (!saveConfigFields(homeDir, config, [`userPrompts.${msg.senderId}`])) {
				if (previous === undefined) delete config.userPrompts[msg.senderId];
				else config.userPrompts[msg.senderId] = previous;
				return "提示词落盘失败，运行态未修改";
			}
		} else {
			const previous = config.groupRules[msg.chatId];
			const next = { ...(previous ?? {}) };
			if (text) next.prompt = text;
			else delete next.prompt;
			config.groupRules[msg.chatId] = next;
			if (!saveConfigFields(homeDir, config, [`groupRules.${msg.chatId}.prompt`])) {
				if (previous === undefined) delete config.groupRules[msg.chatId];
				else config.groupRules[msg.chatId] = previous;
				return "提示词落盘失败，运行态未修改";
			}
		}
		log.info("feishu.prompt.updated", { scope: personal ? "user" : "chat", chatId: msg.chatId, operator: msg.senderId, cleared: !text });
		return text ? `已更新${scope}（下一轮起生效）。` : `已清除${scope}。`;
	}

	/** `/cron add|list|rm|pause|resume`。 */
	async function handleCronCommand(msg: FeishuInboundMessage, args: string[], rest: string, isAdmin: boolean): Promise<string> {
		if (!config.cron?.enabled || !cronScheduler) return "定时任务未启用（config.cron.enabled）";
		const sub = args[0]?.toLowerCase() ?? "list";
		const zone = config.timezone;
		if (sub === "list") {
			const jobs = cronScheduler.list(msg.chatId);
			if (jobs.length === 0) return "本会话没有定时任务。/cron add \"0 9 * * 1-5\" <任务内容> 新建（管理员）。";
			return [
				`本会话定时任务（${jobs.length}）：`,
				...jobs.map((job) => {
					const next = job.enabled ? cronScheduler?.nextFor(job) : undefined;
					return `· ${job.id}　${job.expression}　${job.enabled ? "启用" : "暂停"}${next ? `　下次 ${formatTimeInZone(next, zone)}` : ""}\n　${job.text.slice(0, 60)}`;
				}),
			].join("\n");
		}
		if (!isAdmin) return "仅管理员或应用归属人可管理定时任务";
		if (sub === "add") {
			const parsed = parseCronAdd(rest.replace(/^add\s*/i, ""));
			if (!parsed) return "用法：/cron add \"<分 时 日 月 周>\" <任务内容>（例如 /cron add \"0 9 * * 1-5\" 汇总昨天的告警）";
			if ((cronScheduler.list().length) >= (config.cron.maxJobs ?? 20)) return `定时任务已达上限（${config.cron.maxJobs ?? 20} 个）`;
			try {
				const job = cronScheduler.add({
					expression: parsed.expression, text: parsed.text, chatId: msg.chatId, chatType: msg.chatType,
					...(msg.threadId ? { threadId: msg.threadId } : {}), creatorId: msg.senderId,
				});
				const next = cronScheduler.nextFor(job);
				log.info("feishu.cron.added", { jobId: job.id, expression: job.expression, chatId: msg.chatId, operator: msg.senderId });
				return `已创建定时任务 ${job.id}（${job.expression}，时区 ${zone}）${next ? `\n下次执行：${formatTimeInZone(next, zone)}` : ""}\n任务里的工具调用同样需要审批；无人审批时按超时拒绝。`;
			} catch (error) {
				return `表达式无效：${error instanceof Error ? error.message : String(error)}`;
			}
		}
		const id = args[1];
		if (!id) return `用法：/cron ${sub} <任务 id>（/cron list 查看）`;
		const owned = cronScheduler.list(msg.chatId).some((job) => job.id === id);
		if (!owned) return `本会话没有任务 ${id}`;
		try {
			if (sub === "rm" || sub === "remove" || sub === "del") return cronScheduler.remove(id) ? `已删除定时任务 ${id}` : `没有任务 ${id}`;
			if (sub === "pause") return cronScheduler.setEnabled(id, false) ? `已暂停定时任务 ${id}` : `没有任务 ${id}`;
			if (sub === "resume") return cronScheduler.setEnabled(id, true) ? `已恢复定时任务 ${id}（从现在起算）` : `没有任务 ${id}`;
		} catch (error) {
			return `操作失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
		}
		return "用法：/cron add|list|rm|pause|resume";
	}

	/**
	 * `!<命令>` 直接执行。executeBash 不经过 tool_call 拦截，所以桥自己把关：
	 * 仅管理员；桥的命令分级 + PS 的 bash 规则，任一 deny 直接拒绝；ask 默认也拒绝（请让 agent 执行以走审批卡）；
	 * 每次执行都写审计日志。
	 */
	async function handleDirectBash(msg: FeishuInboundMessage, command: string): Promise<void> {
		const { reply } = commandReplier(msg);
		const audit = (outcome: string, extra: Record<string, unknown> = {}) => log.info("feishu.direct_bash.audit", {
			outcome, chatId: msg.chatId, operator: msg.senderId, command: redactParams({ command }, "bash").slice(0, 300), ...extra,
		});
		if (!command) { reply("用法：!<命令>，例如 !git status"); return; }
		if (!isAdminSender(msg)) { audit("rejected_not_admin"); reply("直接执行命令仅限管理员"); return; }
		if (config.directBash?.p2pOnly && msg.chatType !== "p2p") { audit("rejected_not_p2p"); reply("直接执行命令只能在私聊里使用"); return; }
		const bridgeVerdict = classifyCommand(command, config.approval.commandPolicy);
		const psVerdict = config.approval.policyEngine === "pi-permission-system" ? psBashVerdict(loadPsConfig(psConfigFile()), command) : undefined;
		if (bridgeVerdict.verdict === "deny" || psVerdict?.verdict === "deny") {
			audit("denied", { reason: bridgeVerdict.verdict === "deny" ? bridgeVerdict.reason : `PS 规则 ${psVerdict?.rule}` });
			reply(`已拒绝：${bridgeVerdict.verdict === "deny" ? bridgeVerdict.reason : `命中禁止规则「${psVerdict?.rule}」`}`);
			return;
		}
		const needsApproval = bridgeVerdict.verdict === "ask" || psVerdict?.verdict === "ask";
		if (needsApproval && !config.directBash?.allowAsk) {
			audit("rejected_needs_approval", { reason: bridgeVerdict.reason });
			reply(`该命令需要审批（${bridgeVerdict.verdict === "ask" ? bridgeVerdict.reason : `PS 规则 ${psVerdict?.rule}`}），直接执行只放行免审命令。\n可以让 agent 执行它（会弹审批卡），例如：用 bash 执行 ${command.slice(0, 80)}`);
			return;
		}
		const result = await convManager?.runDirectBash(msg, command, config.directBash?.timeoutMs ?? 60_000);
		if (!result) { reply("会话不可用"); return; }
		if (!result.ok) { audit("failed", { reason: result.reason }); reply(result.reason); return; }
		audit("executed", { exitCode: result.exitCode ?? null, cancelled: result.cancelled, timedOut: result.timedOut });
		const status = result.timedOut ? "⏱ 超时已中止" : result.cancelled ? "⏹ 已中止" : result.exitCode === 0 ? "✅ exit 0" : `⚠️ exit ${result.exitCode ?? "?"}`;
		const output = result.output.trimEnd() || "（无输出）";
		const limit = 3_500;
		const shown = output.length > limit ? `…（前面省略 ${output.length - limit} 字）\n${output.slice(-limit)}` : output;
		reply(`$ ${command.slice(0, 200)}\n${status}${result.truncated ? "（输出已被截断）" : ""}\n\`\`\`\n${shown}\n\`\`\``);
	}

	/** 诊断包以文件形式私聊给管理员。 */
	async function sendDiagnosticsToAdmin(openId: string, bundle: unknown): Promise<boolean> {
		if (!transport) return false;
		try {
			const fileKey = await transport.uploadFile(`feishu-bridge-diagnostics-${Date.now()}.json`, Buffer.from(JSON.stringify(bundle, null, 2), "utf8"));
			await transport.sendToUser(openId, "file", { file_key: fileKey });
			return true;
		} catch (error) {
			log.warn("feishu.diagnostics.dm_failed", { error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	/** 同一群的放行提示 1 小时内只发一次。 */
	const allowPromptSentAt = new Map<string, number>();
	/** 开通申请限流状态（按群）。 */
	let accessRequests: AccessRequestTracker | undefined;

	/** 私聊一张卡给若干管理员（失败只记日志）。 */
	async function dmAdmins(recipients: string[], card: unknown, what: string): Promise<number> {
		let sent = 0;
		for (const openId of recipients.slice(0, 5)) {
			try {
				await transport?.sendToUser(openId, "interactive", card);
				sent += 1;
			} catch (error) {
				log.warn("feishu.admin_dm_failed", { what, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return sent;
	}

	/** 群未放行时，管理员 @ 了机器人 → 私聊他一张"放行此群"卡。普通成员 @ 不回复，只记日志。 */
	async function onAdmissionDrop(msg: FeishuInboundMessage, reason: string, mentioned: boolean): Promise<void> {
		if (reason !== "not_allowlisted" || msg.chatType === "p2p" || !mentioned || config.allowChats.includes(msg.chatId)) return;
		if (config.onboarding?.accessRequest) {
			await requestChatAccess(msg);
			return;
		}
		if (config.onboarding?.notifyAdmins === false) return;
		// 旧行为（未开开通申请）：有审批权的人 @ 了机器人 → 私聊他放行卡（没审批权就不发一张点不动的卡）
		if (!canApproveAccess(config, msg.senderId, approverPolicy())) return;
		const last = allowPromptSentAt.get(msg.chatId);
		if (last && Date.now() - last < 3_600_000) return;
		allowPromptSentAt.set(msg.chatId, Date.now());
		const chatName = await transport?.getChatName(msg.chatId);
		const operatorName = await transport?.resolveUserName(msg.senderId).catch(() => undefined);
		await dmAdmins([msg.senderId], buildAllowChatCard({ chatId: msg.chatId, chatName, reason: "管理员在群里 @ 了机器人", operatorName }), "allow_chat");
		log.info("feishu.onboarding.allow_prompt", { chatId: msg.chatId, operator: msg.senderId });
	}

	/** 群里发卡片（失败只记日志，返回是否发出）。 */
	async function sendChatCard(chatId: string, card: unknown, opts: { replyTo?: string; threadId?: string }, what: string): Promise<boolean> {
		try {
			await transport?.sendCard(chatId, card, opts);
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
		if (!transport) return;
		accessRequests ??= new AccessRequestTracker({ cooldownMs: config.onboarding?.accessRequestCooldownMs });
		const replyOpts = { replyTo: msg.messageId, ...(msg.threadId ? { threadId: msg.threadId } : {}) };
		const decision = accessRequests.decide(msg.chatId, msg.senderId);
		if (decision.action === "silent") {
			log.info("feishu.access_request.silent", { chatId: msg.chatId, requester: msg.senderId, reason: decision.reason });
			return;
		}
		if (decision.action === "remind") {
			const whom = decision.mode === "group" ? atByRole(decision.approvers) : await approverNames(decision.approvers);
			await sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群的开通申请已发给 ${whom}${decision.mode === "dm" ? "（私聊）" : ""}，正在等待审批，通过后我会在群里通知。`), replyOpts, "remind");
			return;
		}
		const members = await transport.listChatMemberIds(msg.chatId);
		const policy = approverPolicy();
		const eligible = accessApprovers(config, effectiveAdmins(config), policy);
		const plan = planAccessRequest({
			admins: eligible,
			ownerId: config.appOwnerId && eligible.includes(config.appOwnerId) ? config.appOwnerId : undefined,
			collaboratorIds: config.appCollaboratorIds?.filter((id) => eligible.includes(id)),
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
		accessRequests.markRequested(msg.chatId, msg.senderId, plan);
		if (plan.mode === "group") {
			const ok = await sendChatCard(msg.chatId, buildAccessRequestCard({ mode: "group", chatId: msg.chatId, requesterId: msg.senderId, approvers: plan.approvers, approverLabel: atByRole(plan.approvers), approverHint: accessApproverHint(policy) }), replyOpts, "request_in_group");
			if (!ok) accessRequests.clear(msg.chatId);
			log.info("feishu.access_request.sent", { chatId: msg.chatId, mode: "group", approvers: plan.approvers.length, ok, membersKnown: Boolean(members) });
			return;
		}
		const chatName = await transport.getChatName(msg.chatId);
		const sent = await dmAdmins(plan.approvers, buildAccessRequestCard({ mode: "dm", chatId: msg.chatId, chatName, requesterId: msg.senderId, approvers: plan.approvers, approverLabel: atByRole(plan.approvers), approverHint: accessApproverHint(policy) }), "access_request");
		if (sent === 0) {
			accessRequests.clear(msg.chatId);
			await sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群还没有开通机器人，暂时联系不上管理员，请直接联系管理员开通。`, "grey"), replyOpts, "request_failed");
			return;
		}
		await sendChatCard(msg.chatId, buildAccessNoticeCard(`${atList([msg.senderId])} 本群还没有开通机器人，已把开通申请私聊发给 ${await approverNames(plan.approvers)}，审批通过后我会在群里通知你。`), replyOpts, "request_notice");
		log.info("feishu.access_request.sent", { chatId: msg.chatId, mode: "dm", approvers: plan.approvers.length, delivered: sent, membersKnown: Boolean(members) });
	}

	/** 群开通审批策略（配置热改后立即生效）。 */
	function approverPolicy() {
		return accessApproverPolicy(config.onboarding?.accessApprovers);
	}

	/** 带角色的 @ 列表（卡片 markdown）："应用归属人 @张三、应用协作者 @李四"。 */
	function atByRole(ids: string[]): string {
		return describeByRole(config, ids, (id) => atList([id]));
	}

	/** 带角色的名字（私聊场景：审批人不在群里，@ 不会提醒，写名字更直观）："应用归属人 张三"。 */
	async function approverNames(ids: string[]): Promise<string> {
		const names = new Map(await Promise.all(ids.map(async (id) => [id, (await transport?.resolveUserName(id).catch(() => undefined)) ?? "（未知）"] as const)));
		return describeByRole(config, ids, (id) => names.get(id) ?? "（未知）");
	}

	/** 操作人的角色 + @（放行/暂不放行回告用）。 */
	function operatorByRole(openId: string): string {
		const role = roleOf(config, openId);
		return role ? atByRole([openId]) : atList([openId]);
	}

	/** 撤回、入群/退群、私聊进入、表情。 */
	async function handleLifecycleEvent(event: LifecycleEvent): Promise<void> {
		switch (event.type) {
			case "recalled": {
				// 还在合批窗口 → 直接移除；排队 → 出队；执行中 → 只停本轮（同 /stop）
				if (pipeline?.cancelBatched(event.messageId)) return;
				const result = await convManager?.cancelByMessageId(event.messageId);
				log.info("feishu.recall", { messageId: event.messageId, status: result?.status ?? "none" });
				if (result?.status === "aborted" && result.chatId && outbox) {
					outbox.enqueue(result.chatId, `已按撤回取消本轮任务${result.sideEffects ? "（本轮已执行过工具，可能已经产生了副作用）" : ""}。`, { threadId: result.threadId }, {
						dedupeKey: `${event.messageId}:recalled`, laneKey: result.conversationKey ?? result.chatId, kind: "notify",
					});
				}
				return;
			}
			case "bot_added": {
				knownChats?.add(event.chatId);
				log.info("feishu.onboarding.bot_added", { chatId: event.chatId, operator: event.operatorOpenId ?? null });
				if (config.allowChats.includes(event.chatId)) {
					if (config.onboarding?.welcome === false || !transport) return;
					const policy = config.groupRules[event.chatId]?.policy ?? config.groupPolicyByChat[event.chatId] ?? config.defaultGroupPolicy ?? config.groupPolicy;
					const trigger = policy === "open" ? "直接发消息即可" : policy === "admin_only" ? "仅管理员 @ 我" : policy === "disabled" ? "本群已停用" : "在群里 @ 我";
					try {
						await transport.sendCard(event.chatId, buildWelcomeCard({ botName: transport.getBotIdentity().name, trigger, ctx: { chatType: "group" } }));
					} catch (error) {
						log.warn("feishu.onboarding.welcome_failed", { chatId: event.chatId, error: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				if (config.onboarding?.notifyAdmins === false) return;
				// 群未放行：拉机器人进群的人有审批权就只私聊他，否则通知按 accessApprovers 能审批的人
				const approvers = accessApprovers(config, effectiveAdmins(config), approverPolicy());
				const recipients = event.operatorOpenId && approvers.includes(event.operatorOpenId) ? [event.operatorOpenId] : approvers;
				if (recipients.length === 0) log.warn("feishu.onboarding.no_approver", { chatId: event.chatId, policy: approverPolicy() });
				const operatorName = event.operatorOpenId ? await transport?.resolveUserName(event.operatorOpenId).catch(() => undefined) : undefined;
				allowPromptSentAt.set(event.chatId, Date.now());
				await dmAdmins(recipients, buildAllowChatCard({ chatId: event.chatId, chatName: event.chatName, reason: "机器人被拉进了群", operatorName }), "bot_added");
				return;
			}
			case "bot_removed":
				knownChats?.remove(event.chatId);
				accessRequests?.clear(event.chatId);
				allowPromptSentAt.delete(event.chatId);
				log.info("feishu.onboarding.bot_removed", { chatId: event.chatId });
				return;
			case "p2p_entered": {
				// 私聊首次进入（knownChats 里没有这个会话）才欢迎，之后不打扰
				if (config.onboarding?.welcome === false || knownChats?.has(event.chatId) || !outbox) return;
				knownChats?.add(event.chatId);
				const openId = event.operatorOpenId;
				const allowed = openId ? config.allowUsers.includes(openId) || effectiveAdmins(config).includes(openId) : false;
				outbox.enqueue(event.chatId, allowed
					? "你好！直接发消息给我就行，/help 查看可用命令。"
					: "你好！私聊功能需要管理员开通（把你加进 allowUsers）。开通后直接发消息给我即可。", {}, {
					dedupeKey: `p2p-welcome:${event.chatId}`, laneKey: event.chatId, kind: "notify",
				});
				log.info("feishu.onboarding.p2p_entered", { chatId: event.chatId, allowed });
				return;
			}
			case "reaction": {
				// 只记用户对本 bot 回复的 👍/👎（机器人自己加的"处理中"表情不算），默认不触发新一轮
				if (config.feedback?.enabled === false) return;
				if (event.operatorType === "app" || !event.operatorOpenId || event.operatorOpenId === transport?.getBotIdentity().openId) return;
				const kind = /thumbs?up|^like$|^ok$/i.test(event.emoji) ? "up" : /thumbs?down|dislike/i.test(event.emoji) ? "down" : undefined;
				if (!kind || !lastSent?.has(event.messageId)) return;
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
		if (!config.docComments?.enabled || !transport || !convManager) return;
		const botOpenId = transport.getBotIdentity().openId;
		const skip = docCommentSkipReason(event, botOpenId);
		if (skip) {
			log.debug("feishu.doc_comment.skipped", { reason: skip, commentId: event.commentId });
			return;
		}
		const sender = event.fromOpenId;
		const allowUsers = config.docComments.allowUsers ?? config.allowUsers;
		if (!sender || !(effectiveAdmins(config).includes(sender) || allowUsers.includes(sender))) {
			log.info("feishu.doc_comment.denied", { commentId: event.commentId, sender: sender ?? null, hint: "评论人不是管理员，也不在 docComments.allowUsers（缺省用 allowUsers）里" });
			return;
		}
		if (!firstSeen(`doc_comment:${event.eventId ?? `${event.commentId}:${event.replyId ?? ""}`}`)) return;
		const request = (opts: { url: string; method: string; params?: unknown; data?: unknown }) => transport!.rawRequest(opts);
		const ctx = await fetchDocCommentContext(request, event, { botOpenId });
		if (!ctx) {
			log.warn("feishu.doc_comment.context_unavailable", { commentId: event.commentId, fileType: event.fileType, hint: "拉不到评论详情：检查应用的云文档评论读取权限，以及机器人是否有该文档的访问权限" });
			return;
		}
		log.info("feishu.doc_comment.accepted", { commentId: event.commentId, fileType: event.fileType, isWhole: ctx.isWhole, thread: ctx.thread.length });
		await convManager.route({
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
		if (!config.meetingInvite?.enabled || !transport || !convManager) return;
		const allowed = config.allowUsers.includes(invite.inviterOpenId) || effectiveAdmins(config).includes(invite.inviterOpenId);
		if (!allowed) {
			log.info("feishu.meeting_invite.denied", { meetingNo: invite.meetingNo, inviter: invite.inviterOpenId, hint: "邀请人不是管理员，也不在 allowUsers 里（回复要走私聊）" });
			return;
		}
		if (!firstSeen(meetingInviteKey(invite))) return;
		const sent = await transport.sendToUserDetailed(invite.inviterOpenId, "text", { text: `收到会议邀请「${invite.topic ?? invite.meetingNo}」，正在处理…` });
		if (!sent.chatId) {
			log.warn("feishu.meeting_invite.no_p2p_chat", { meetingNo: invite.meetingNo });
			return;
		}
		log.info("feishu.meeting_invite.accepted", { meetingNo: invite.meetingNo, chatId: sent.chatId });
		await convManager.route({
			messageId: `meeting:${meetingInviteKey(invite)}`,
			chatId: sent.chatId, chatType: "p2p",
			senderId: invite.inviterOpenId, ...(invite.inviterName ? { senderName: invite.inviterName } : {}),
			isBot: false, msgType: "text",
			text: buildMeetingInvitePrompt(invite, (ms) => formatTimeInZone(ms, config.timezone)),
			mentions: [], resources: [], raw: undefined, ts: Date.now(),
			synthetic: true, replyTarget: sent.messageId,
		}, { behavior: "queue" });
	}

	/** 反馈计数（只记 id 与方向，不含正文）。 */
	const feedbackCounts = { up: 0, down: 0 };
	function recordFeedback(entry: { at: number; messageId: string; kind: "up" | "down"; action: "created" | "deleted"; operator: string }): void {
		feedbackCounts[entry.kind] += entry.action === "created" ? 1 : -1;
		try {
			const file = resolvePaths(homeDir).feedbackFile;
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

	/** 定时任务触发 → 以创建人身份构造合成消息，走正常会话链路（审批、outbox、进度全部复用）。 */
	async function fireCronJob(fire: import("./runtime/cron.js").CronFire): Promise<void> {
		if (!convManager) throw new Error("conversation manager unavailable");
		const { job, plannedAt, missed } = fire;
		const note = missed > 0 ? `[定时任务 ${job.id}：停机期间错过 ${missed} 次，本次照常执行]\n` : "";
		await convManager.route({
			messageId: `cron:${job.id}:${plannedAt}`,
			chatId: job.chatId, chatType: job.chatType, ...(job.threadId ? { threadId: job.threadId } : {}),
			senderId: job.creatorId, isBot: false, msgType: "text",
			text: `${note}[定时任务 ${job.id}（${job.expression}）] ${job.text}`,
			mentions: [], resources: [], raw: undefined, ts: plannedAt,
			synthetic: true, replyTarget: null,
		}, { behavior: "queue" });
	}

	/** 心跳 —— 定期刷新 status.json（健康但空闲的桥 mtime 也不会停），顺带评估告警。 */
	function startHeartbeat(): void {
		const interval = config.statusHeartbeatMs ?? 30_000;
		if (heartbeatTimer || interval <= 0) return;
		heartbeatTimer = setInterval(() => {
			updateStatus();
			void evaluateAlerts();
		}, interval);
		heartbeatTimer.unref?.();
	}

	function stopHeartbeat(): void {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
	}

	async function evaluateAlerts(): Promise<void> {
		if (!config.alerts?.enabled) return;
		alertMonitor ??= new AlertMonitor({
			disconnectMs: config.alerts.disconnectMs ?? DEFAULT_ALERT_OPTIONS.disconnectMs,
			reconnectsIn5m: config.alerts.reconnectsIn5m ?? DEFAULT_ALERT_OPTIONS.reconnectsIn5m,
			pendingApprovals: config.alerts.pendingApprovals ?? DEFAULT_ALERT_OPTIONS.pendingApprovals,
			approvalAgeMs: DEFAULT_ALERT_OPTIONS.approvalAgeMs,
			cooldownMs: config.alerts.cooldownMs ?? DEFAULT_ALERT_OPTIONS.cooldownMs,
		});
		const messages = alertMonitor.evaluate({
			now: Date.now(),
			downSince,
			reconnectsLast5m: reconnectSupervisor.reconnectsInWindow(),
			failedFinals: outbox?.stats().failed ?? 0,
			pendingApprovals: permissionBridge?.pendingCount() ?? 0,
			oldestApprovalAgeMs: permissionBridge?.oldestPendingAgeMs(),
			compensationErrors,
		});
		if (messages.length === 0 || !transport?.isConnected()) return;
		const recipients = config.alerts.recipients?.length ? config.alerts.recipients : effectiveAdmins(config);
		for (const message of messages) {
			log.warn("feishu.alert", { kind: message.kind, recovered: message.recovered });
			for (const openId of recipients.slice(0, 10)) {
				try { await transport.sendToUser(openId, "text", { text: `[飞书桥] ${message.text}` }); } catch (error) {
					log.warn("feishu.alert.send_failed", { kind: message.kind, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}
	}

	/** 启动时收紧会话文件权限；配置了保留期时归档超期历史会话。 */
	function runRetention(): void {
		const dir = resolvePaths(homeDir).sessionDir;
		try {
			const tightened = tightenSessionPermissions(dir);
			const archived = archiveOldSessions({ dir, keep: convManager?.referencedSessionFiles() ?? new Set(), days: config.retention?.sessionDays ?? 0 });
			if (tightened > 0 || archived.length > 0) log.info("feishu.retention", { tightened, archived: archived.length });
		} catch (error) {
			log.warn("feishu.retention_failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	async function assemble(): Promise<void> {
		const paths = resolvePaths(homeDir);
		knownChats = new KnownChatStore(paths.knownChatsFile);
		const { createFeishuTransport } = await import("./inbound/transport-factory.js");
		transport = await createFeishuTransport(config, {
			onMessage: async (msg) => {
				if (msg.chatId) knownChats?.add(msg.chatId);
				await pipeline?.handle(msg);
			},
			onStatus: (connState) => {
				const outageStartedAt = downSince;
				reportedConnState = connState === "connected" ? "connected" : connState === "error" ? "error" : "connecting";
				if (reportedConnState === "connected") {
					downSince = undefined;
					lastError = undefined;
					if (outageStartedAt) void compensateMissed(outageStartedAt);
				} else {
					// error（SDK 终态）与 reconnecting（SDK 自动重连中）都算断线：补收窗口从第一次掉线算起
					downSince ??= Date.now();
				}
				setStatus("conn", connState === "connected" ? "飞书桥已连接" : connState === "reconnecting" ? "飞书桥重连中（SDK）" : `飞书桥 ${connState}`);
				updateStatus();
			},
			onCardAction: handleCardAction,
			onLifecycleEvent: handleLifecycleEvent,
			log: (level, m, meta) => log[level](m, meta),
		}, deps.larkSdk);
		usageLedger = new UsageLedger({ file: paths.usageDailyFile, timeZone: config.timezone });
		clarificationStore = new ClarificationStore({
			allowedResponderIds: () => effectiveAdmins(config),
			// 管理员名单为空时不允许任何人作答（默认拒绝，避免任意群成员替用户做决定）
			onAudit: (event) => log.info("feishu.clarify.audit", event),
		});
		permissionBridge = new PermissionBridge({
			getConfig: () => config.approval,
			onAsk: async (pending) => {
				// 卡片上写明谁在哪个会话里发起的
				pending.contextLine ??= await convManager?.approvalContextLine(pending.conversationKey).catch(() => undefined);
				return transport!.sendCard(pending.chatId, buildApprovalCard(pending), {
					replyTo: pending.sourceMessageId, threadId: pending.threadId,
				});
			},
			// 超时前 1 分钟在会话里 @ 审批人提醒一次
			onReminder: (pending) => {
				const admins = pending.allowedOperatorIds.slice(0, 5);
				const mentions = admins.map((id) => `<at user_id="${id}"></at>`).join(" ");
				try {
					outbox?.enqueue(pending.chatId, `${mentions} 有一条审批还剩 1 分钟超时（${pending.toolName}），超时将按拒绝处理。`, {
						replyTo: pending.cardMessageId ?? pending.sourceMessageId, threadId: pending.threadId,
					}, { dedupeKey: `approval-reminder:${pending.id}`, laneKey: pending.conversationKey, kind: "notify" });
				} catch (error) {
					log.warn("feishu.approval.reminder_failed", { error: error instanceof Error ? error.message : String(error) });
				}
			},
			// 同一 run 的同类请求并到这张卡 → 重绘（列出将一并处理的命令，旧卡 token 已作废）
			onCardRefresh: (pending) => {
				if (!pending.cardMessageId) return;
				void transport?.updateCard(pending.cardMessageId, buildApprovalCard(pending)).catch((error: unknown) => {
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
				void transport?.updateCard(pending.cardMessageId, card).then((ok) => {
					if (!ok) log.warn("feishu.approval.card_terminal_failed", { approvalId: pending.id });
				});
			},
			onAlwaysAllow: (toolName) => {
				const previous = [...config.approval.autoApprove];
				if (!config.approval.autoApprove.includes(toolName)) config.approval.autoApprove.push(toolName);
				// saveConfig 失败时回滚内存改动 —— 不得反馈“已持久授权”。
				if (saveConfigFields(homeDir, config, ["approval.autoApprove"])) return true;
				config.approval.autoApprove = previous;
				log.error("feishu.approval.always_persist_failed", { toolName });
				return false;
			},
			onAudit: (event) => log.info("feishu.approval.audit", event),
		});

		lastSent = new LastSentCache(config.lastSentCacheSize);
		sender = new Sender({
			config,
			transport,
			onSent: (_chatId, messageId) => {
				lastSent?.record(messageId);
			},
			log: (level, m, meta) => log[level](m, meta),
		});

		outbox = new Outbox({
			file: paths.outboxFile,
			prepare: (chatId, content, opts) => sender!.prepare(chatId, content, opts),
			prepareMedia: (chatId, artifact, opts) => sender!.prepareMedia(chatId, artifact, opts),
			send: (request, checkpoint) => sender!.sendPrepared(request, checkpoint),
			log: (level, m, meta) => log[level](m, meta),
			onChange: updateStatus,
			onResult: (result) => convManager?.recordApiOutcome({ ok: result.success, errorClass: result.errorClass, retryAfterMs: result.retryAfterMs }),
			// 最终回复永久发送失败 → 给用户一条最朴素的提示（不回复原消息、纯文本、新 UUID），
			// 否则用户那边只是"机器人不回了"。提示本身是 notify，失败不再触发提示（不会循环）。
			onTerminalFailure: (entry) => {
				if (entry.kind !== "final" && entry.kind !== "error") return;
				const reason = /230072|edited/i.test(entry.lastError ?? "") ? "消息编辑次数已达上限"
					: /permission|403|forbidden|not in chat|230002/i.test(entry.lastError ?? "") ? "机器人在该会话没有发言权限"
					: "飞书接口持续报错";
				try {
					outbox?.enqueue(entry.route.chatId, `⚠️ 回复发送失败（${reason}），请重试或联系管理员。`, { threadId: entry.route.threadId }, {
						dedupeKey: `${entry.dedupeKey}:failed-notice`, laneKey: entry.laneKey, kind: "notify",
					});
				} catch (error) {
					log.warn("feishu.outbox.failure_notice_failed", { error: error instanceof Error ? error.message : String(error) });
				}
			},
		});

		convManager = new ConversationManager({
			config,
			sessionDir: paths.sessionDir,
			// 超时策略：只在「完全没有事件产出」时中止；总时长默认不限（长任务不该被硬杀）
			// 流式卡片复用 transport 的原始请求能力
			rawRequest: (opts) => {
				if (!transport) throw new Error("transport unavailable");
				return transport.rawRequest(opts);
			},
			runIdleTimeoutMs: config.runIdleTimeoutMs,
			runMaxDurationMs: config.runMaxDurationMs,
			sessionBackend: deps.sessionBackend ?? new PiSessionBackend({
				sessionDir: paths.sessionDir,
				log: (l, m, x) => log[l](m, x),
				// 给每个子会话注入桥侧 hook（审批 gate + 文件工具），共享 outer 桥状态；
				// 同时剔除网关扩展，避免子会话重复启动飞书 WS / 创建空状态。
				bridgeExtensionFactory: createBridgeInlineExtension({
					routeForSessionId: (sessionId) => convManager?.routeForSessionId(sessionId),
					markToolBoundary: (sessionId) => convManager?.markPendingToolBoundary(sessionId),
					gateToolCall: (input) => gateToolCall(input),
					notifyCompaction: ({ sessionId, phase, detail }) => {
						const route = convManager?.routeForSessionId(sessionId);
						if (!route) return;
						log.info("feishu.bridge.compaction", { phase, chatId: route.chatId });
						// 压缩期间 Pi 不产出事件，发一条可见提示消除"莫名卡住"的困惑。
						// 必须用 notifyNow（notify 是 private）：attempt 里带 chatId+phase 保证压缩
						// 反复触发时不会每轮刷屏，但每次真实压缩都能出一次。
						if (phase === "start") {
							void convManager?.notifyNow(route.chatId, "🧠 上下文较长，正在整理记忆…", {
								replyTo: route.sourceMessageId,
								threadId: route.threadId,
							}, `compaction:${route.chatId}:${route.runId ?? ""}`);
						} else if (phase === "failed") {
							void convManager?.notifyNow(route.chatId, `⚠️ 上下文整理失败，已继续本轮${detail ? `（${detail}）` : ""}`, {
								replyTo: route.sourceMessageId,
								threadId: route.threadId,
							}, `compaction-failed:${route.chatId}:${route.runId ?? ""}`);
						}
					},
					markSettled: (sessionId) => {
						const route = convManager?.routeForSessionId(sessionId);
						if (!route) return;
						log.info("feishu.bridge.agent_settled", { chatId: route.chatId });
						convManager?.markSettled(sessionId);
					},
					// agent 自定义卡片（默认关闭：关闭时子会话里根本不注册这个工具）
					cardTool: () => config.cardTool?.enabled === true,
					docTool: () => config.docTools?.enabled === true,
					readDoc: async (ref) => {
						if (!transport) return { content: [{ type: "text", text: "飞书连接不可用" }], isError: true };
						const result = await readDocText((opts) => transport!.rawRequest(opts), ref, config.docTools?.maxChars ?? 30_000);
						if (!result.ok) return { content: [{ type: "text", text: result.error }], isError: true };
						return { content: [{ type: "text", text: result.truncated ? `${result.text}\n\n…（文档较长，已截断）` : result.text || "（文档为空）" }] };
					},
					sendCard: (input) => sendAgentCard(input.params, input.route),
					sendLocalFile: (input) => queueLocalFile({
						toolCallId: input.toolCallId,
						path: input.path,
						caption: input.caption,
						cwd: input.cwd,
						homeDir,
						route: input.route,
						outbox,
					}),
					// 当前会话内的主动文本通知 —— 只认活动路由，走 durable notify
					notifyText: async (input) => {
						const route = input.route;
						if (!route?.chatId) return { status: "rejected" as const, detail: "没有活动会话" };
						const opts = { replyTo: route.sourceMessageId, threadId: route.threadId };
						const dedupeKey = `${route.conversationKey}:${input.toolCallId}:notify`;
						if (outbox) {
							const ids = outbox.enqueue(route.chatId, input.text, opts, {
								dedupeKey, laneKey: route.conversationKey, kind: "notify",
							});
							// 同一 toolCallId 重试只入队一次（outbox 按 dedupeKey 幂等）
							return ids.length > 0
								? { status: "queued" as const }
								: { status: "delivered" as const, detail: "该通知已入队" };
						}
						const res = await convManager?.notifyNow(route.chatId, input.text, opts, dedupeKey);
						return res?.success
							? { status: "delivered" as const }
							: { status: "rejected" as const, detail: res?.error ?? "发送失败" };
					},
					allowedOperatorIds: () => effectiveAdmins(config),
				// 澄清提问 —— 卡片优先后退化为文本选项，等待有界超时
				askChoice: async (input) => {
					if (!clarificationStore) return { status: "unavailable" as const, detail: "澄清存储未初始化" };
					if (!input.route?.chatId) return { status: "unavailable" as const, detail: "没有活动会话" };
					const pending = clarificationStore.create({
						conversationKey: input.route.conversationKey, chatId: input.route.chatId, threadId: input.route.threadId,
						runId: input.route.runId ?? input.toolCallId, toolCallId: input.toolCallId,
						question: input.question, options: input.options,
					});
					// 卡片优先：发送失败（例如无卡片权限）退化为文本选项，用户回复文本时按普通消息继续
					let cardSent = false;
					try {
						const messageId = await transport?.sendCard(input.route.chatId, buildClarificationCard(pending), {
							replyTo: input.route.sourceMessageId, threadId: input.route.threadId,
						});
						clarificationStore.attachCard(pending.id, messageId);
						cardSent = Boolean(messageId);
					} catch (error) {
						log.warn("feishu.clarify.card_failed", { error: error instanceof Error ? error.message : String(error) });
					}
					if (!cardSent) {
						const fallback = clarificationTextFallback(pending);
						if (outbox) {
							outbox.enqueue(input.route.chatId, fallback, { replyTo: input.route.sourceMessageId, threadId: input.route.threadId }, {
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
			resolveUserName: (openId) => transport?.resolveUserName(openId) ?? Promise.resolve(undefined),
			usageLedger,
			deliverExternal: (target, text) => transport
				? deliverDocCommentReply((opts) => transport!.rawRequest(opts), target, text)
				: Promise.resolve(false),
			cnyPerUsd: (model) => usageProviderFor(config).cnyPerUsd(model),
			exportsDir: paths.exportsDir,
			sendLocalFile: (chatId, path, opts, meta) => {
				if (!outbox) return { ok: false, error: "outbox 不可用" };
				try {
					const staged = stageArtifact(validateLocalArtifact(path, dirname(path)), join(homeDir, "feishu-bridge", "media-outbox"));
					outbox.enqueueMedia(chatId, staged, opts, { ...meta, kind: "media" });
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
				(permissionBridge?.pendingForConversation(conversationKey) ?? 0)
				+ (clarificationStore?.pendingForConversation(conversationKey) ?? 0),
			onApprovalInvalidate: ({ conversationKey, runId, reason }) => {
				if (!permissionBridge) return;
				const cancelled = runId
					? permissionBridge.cancelRun(conversationKey, runId)
					: permissionBridge.cancelConversation(conversationKey);
				// 同一 run 的未决提问一并失效（旧卡片不得再影响新状态）
				const clarifyCancelled = runId
					? clarificationStore?.cancelRun(conversationKey, runId) ?? 0
					: clarificationStore?.cancelConversation(conversationKey) ?? 0;
				if (cancelled > 0 || clarifyCancelled > 0) {
					log.info("feishu.approval.invalidated", { conversationKey, runId, reason, cancelled, clarifyCancelled });
				}
			},
			sender,
			durableOutbox: outbox,
			resourceResolver: new ResourceResolver({
				baseDir: join(paths.sessionDir, "..", "resources"),
				download: (ref, maxBytes) => transport!.downloadResource(ref, maxBytes),
				// 语音转写（默认关闭）
				transcribe: createTranscriber(config.stt, { log: (level, m, meta) => log[level](m, meta) }),
			}),
			editMessage: (messageId, text) => transport?.editMessage(messageId, text) ?? Promise.resolve(false),
			recallMessage: (messageId) => transport?.recallMessage(messageId) ?? Promise.resolve(false),
			lastSent,
			reactions: {
				add: (messageId, emoji) => transport!.addReaction(messageId, emoji),
				remove: (messageId, reactionId) => transport!.removeReaction(messageId, reactionId),
			},
			log: (level, m, meta) => log[level](m, meta),
		});

		pipeline = new InboundPipeline({
			config,
			transport,
			lastSent,
			dedupeStore: new DedupeStore({ file: paths.dedupeFile, capacity: config.dedupCacheSize, ttlMs: config.dedupTtlMs }),
			// 准入通过即写 pending ledger，消除 dedupe→ledger 丢失窗口。
			intake: convManager?.intakeLedger(),
			onDispatch: async (msg) => { await convManager!.route(msg); },
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
		if (owner && owner !== action.operatorOpenId && !effectiveAdmins(config).includes(action.operatorOpenId)) {
			return { toast: { type: "warning", content: "只有发起人或管理员可以点这张卡片" } };
		}
		const chatType = field("t") === "p2p" || field("t") === "topic" ? field("t") as "p2p" | "topic" : "group";
		const result = await convManager?.route({
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
		if (!route || !transport) return { content: [{ type: "text", text: "无法发送：当前不是由飞书消息触发的活动会话" }], isError: true };
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
			await transport.sendCard(route.chatId, card, { replyTo: route.sourceMessageId, threadId: route.threadId });
			return { content: [{ type: "text", text: `卡片已发送（按钮：${labels.join("、")}）。用户点击后会以「[卡片点击] 按钮名」的新消息告诉你，本轮可以先结束。` }] };
		} catch (error) {
			return { content: [{ type: "text", text: `卡片发送失败：${error instanceof Error ? error.message : String(error)}` }], isError: true };
		}
	}

	// feishu_send_local_file 只在子会话的内联扩展里注册（外层 TUI 会话不是飞书路由，注册了也只会报错）。


	/**
	 * PS 父会话转发的配置视图（父会话 id 缺省时用固定值；引擎不是 PS 时视为关闭）。
	 */
	function psForwardingConfigured(): { enabled: boolean; parentSessionId: string; blockedBy?: "policyEngine" } {
		return resolvePsForwardingConfig(config.approval);
	}

	/**
	 * 声明/撤回「本进程是 PS 的父会话」（见 PS_FORWARDING_PARENT_ENV_KEYS）。
	 *
	 * 变量是进程级的（桥与子会话同进程，无法只给子会话设），而效果恰好是我们想要的：
	 * 进程内所有会话的 ask 都转发给桥；真正的发起会话从请求文件的 requesterSessionId 读。
	 * PS 在每次工具调用时实时读环境变量，因此这里在会话创建前设置即可。
	 *
	 * 关闭时必须撤回自己的声明：否则 PS 会把 ask 转发到一个没人收的收件箱，
	 * 子会话要等满 10 分钟才判拒绝（而正确行为是退回到它自己的判定）。
	 */
	function syncPsForwardingEnv(): void {
		const { enabled, parentSessionId, blockedBy } = psForwardingConfigured();
		if (blockedBy) {
			// 开关开了但引擎不是 PS：开启转发只会让同一次调用弹两张卡，这里明确说明。
			log.warn("feishu.approval.ps_forwarding_inactive", {
				reason: "approval.forwarding 仅在 approval.policyEngine=pi-permission-system 时生效",
				policyEngine: config.approval?.policyEngine ?? "bridge",
			});
		}
		const installed = piPermissionSystemInstalled();
		const active = enabled && installed;
		if (enabled && !installed) {
			// 与 policyEngine 同一套默认拒绝语义：没装成就不做父子声明。
			log.error("feishu.approval.ps_forwarding_unavailable", { expected: "@gotgenes/pi-permission-system" });
		}
		const before = psForwardingOwnEnvId;
		const result = applyPsForwardingParentEnv({ enabled: active, parentSessionId, previousApplied: before });
		psForwardingOwnEnvId = result.appliedValue;
		if (result.appliedValue !== before) {
			log.info("feishu.approval.ps_forwarding_env", {
				state: result.appliedValue ? "declared" : "withdrawn",
				keys: PS_FORWARDING_PARENT_ENV_KEYS,
				parentSessionId,
			});
		}
		if (result.overridden.length > 0) {
			// 外层 spawner 已经声明过别的父会话：我们接管了它。写一条日志，免得排障时想不到。
			log.warn("feishu.approval.ps_forwarding_env_overridden", { overridden: result.overridden, parentSessionId });
		}
	}

	/**
	 * 起停转发应答方。幂等：已起且父会话 id 未变则不动；id 变了则重建
	 * （心跳与收件箱目录都挂在 id 上，不能混用）。
	 *
	 * 何时只能起：必须等 transport/outbox 起来（弹卡要能发出去）且 PermissionBridge 已就位。
	 */
	async function syncPsForwardingServer(): Promise<void> {
		const { enabled, parentSessionId } = psForwardingConfigured();
		if (!enabled || !piPermissionSystemInstalled() || !permissionBridge) {
			if (psForwarding) {
				await psForwarding.stop();
				psForwarding = undefined;
				psForwardingParentId = undefined;
			}
			return;
		}
		if (psForwarding && psForwardingParentId === parentSessionId) {
			psForwarding.start();
			return;
		}
		if (psForwarding) {
			await psForwarding.stop();
			psForwarding = undefined;
		}
		// 「始终批准」规则表：开启时审批卡多一个 always 按钮，命中规则的请求直接放行。
		// 每轮同步都重建（配置可能被 /feishu policy 之类改过），成本是一次小文件读。
		alwaysApproved = config.approval.forwarding?.alwaysApprove === false
			? undefined
			: new AlwaysApprovedStore({ file: resolvePaths(homeDir).alwaysApprovedFile });
		psForwarding = new PsForwardingServer({
			forwardingDir: psForwardingRootDir(resolveAgentDir()),
			parentSessionId,
			alwaysApproved,
			routeForSessionId: (sessionId) => convManager?.routeForSessionId(sessionId),
			allowedOperatorIds: () => effectiveAdmins(config),
			requestDecision: async (input) => {
				const result = await permissionBridge!.requestExternal(input, {
					// 审批卡等待上限沿用 approval.timeoutMs；但不得越过 PS 自己的转发总超时，
					// 否则我们会在对方已经放弃后才写响应（子会话拿不到，白留一个孤儿文件）。
					timeoutMs: Math.min(config.approval.timeoutMs, PS_FORWARDING_UPSTREAM_TIMEOUT_MS - 30_000),
					auditDecision: "ps_forwarding_ask",
				});
				// operatorId 一并带回：转发路径的「始终批准」要记下是谁放行的。
				return { verdict: result.verdict, choice: result.choice, operatorId: result.operatorId };
			},
			onAudit: (event) => log.info("feishu.approval.ps_forwarding.audit", event),
			log: (level, msg, meta) => log[level](msg, meta),
		});
		psForwardingParentId = parentSessionId;
		psForwarding.start();
	}

	/**
	 * 工具调用审批（outer hook 与子会话内联扩展共用）：返回 { block, reason } 阻断执行。
	 * 同一实现在两个位置调用，避免“组件有实现但运行时没接上”。
	 */
	async function gateToolCall(input: BridgeGateInput): Promise<{ block?: boolean; reason?: string } | undefined> {
		if (!permissionBridge) return undefined;
		// 管理员/归属人免审批（approval.adminSkipApproval=true 时生效）。
		// 必须用显式传入的 senderId：conversationKey 只在「群聊+按人隔离」形态下带用户 ID，
		// 话题（`oc:t:th`）与私聊（裸 `oc`）都取不到，早期从 key 正则提取会漏掉这两种情况。
		if (config.approval?.adminSkipApproval) {
			const sender = input.senderId;
			if (sender && effectiveAdmins(config).includes(sender)) {
				log.info("feishu.approval.admin_skip", { toolName: input.toolName, conversationKey: input.conversationKey });
				return undefined;
			}
		}

		// 把策略交给 @gotgenes/pi-permission-system：它的 tool_call 拦截在桥之前执行，
		// deny 时桥的 handler 根本不会被调用（实测：PS 先 → 桥后，首个 block 立即返回）。
		// 因此桥这一步只需"放行自己不再判断"，策略规则由该扩展的配置文件维护。
		//
		// 它的 ask **不经过这里** —— 走 approval.forwarding（PS 的父会话转发）：桥当应答方，
		// 把请求文件变成审批卡，用户点完写回响应文件（见 approval/ps-forwarding.ts）。
		// 所以这里继续直接放行，不能改成落到桥的弹卡逻辑：PS 的 ask 是在它自己的拦截逻辑里
		// 等待父会话应答的，等它放行后本函数会被再调用一次，那时再弹一张卡就是对同一次
		// 调用弹两次卡（两次判定还可能不一致）。
		if (config.approval?.policyEngine === "pi-permission-system") {
			if (piPermissionSystemInstalled()) {
				return undefined;
			}
			// 默认拒绝：扩展没装成 → 桥的审批是唯一防线，绝不能同时关掉
			log.error("feishu.approval.policy_engine_unavailable", {
				expected: "@gotgenes/pi-permission-system",
				fallback: "bridge",
			});
		}

		// 命令级策略：只读命令免审、危险命令直接拒绝，其余才弹卡。
		// 没有这一层时 bash 只能「全审」—— 每个 ls 都要点一次审批，用户会无脑点批准，审批就失去意义。
		if (input.toolName === "bash" && config.approval?.commandPolicy?.enabled) {
			// 必须用原始命令：展示用的 paramsText 已打码并截断，危险部分可能恰好落在截断位置之后
			const command = input.command;
			if (command) {
				const verdict = classifyCommand(command, config.approval.commandPolicy);
				if (verdict.verdict === "allow") {
					log.info("feishu.approval.command_allow", { reason: verdict.reason, chatId: input.chatId });
					return undefined;
				}
				if (verdict.verdict === "deny") {
					log.warn("feishu.approval.command_deny", { reason: verdict.reason, chatId: input.chatId });
					// 直接拒绝，不弹卡：避免"手滑点批准"执行破坏性命令
					return { block: true, reason: `该命令被安全策略拒绝：${verdict.reason}。如确需执行，请人工在宿主机操作。` };
				}
				log.info("feishu.approval.command_ask", { reason: verdict.reason, chatId: input.chatId });
				// 把判定理由带进卡片：参考 hermes 的 `Reason: {description}`，
				// 让审批人知道"为什么这条命令需要批"，而不是只看到一个命令。
				input.reason = verdict.reason;
			}
		}
		const result = await permissionBridge.gate(input);
		if (result.decision === "allow") return undefined;
		if (result.decision === "deny") return { block: true, reason: "工具调用被策略拒绝" };
		const verdict = await result.verdict;
		if (verdict === "approved") return undefined;
		return { block: true, reason: verdict === "timeout" ? "飞书审批超时，已拒绝" : "飞书审批已拒绝" };
	}

	pi.on("tool_call", async (event, ctx) => {
		const input = event as { toolCallId?: string; toolName?: string; input?: Record<string, unknown> };
		const sessionId = ctx.sessionManager.getSessionId();
		const route = convManager?.routeForSessionId(sessionId);
		if (!route || !input.toolCallId || !input.toolName) return undefined;
		convManager?.markPendingToolBoundary(sessionId);
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
			allowedOperatorIds: effectiveAdmins(config),
		});
	});

	async function compensateMissed(outageStartedAt: number): Promise<void> {
		if (compensationPromise) return compensationPromise;
		compensationPromise = (async () => {
			const endTime = Date.now();
			const result = await compensateKnownChats({
				chatIds: knownChats?.values() ?? [],
				outageStartedAt,
				now: endTime,
				maxWindowMs: 5 * 60_000,
				maxPerChat: 50,
				list: (chatId, startTime, finishTime, limit) => transport?.listChatHistory(chatId, startTime, finishTime, limit) ?? Promise.resolve([]),
				handle: (message) => pipeline?.handle(message) ?? Promise.resolve(),
				onError: (chatId, error) => log.warn("history compensation failed", { chatId, error: error instanceof Error ? error.message : String(error) }),
			});
			compensatedMessages += result.recovered;
			compensationErrors += result.errors;
			compensationTruncated += result.truncatedChats + (result.windowTruncated ? 1 : 0);
			updateStatus();
		})();
		try {
			await compensationPromise;
		} finally {
			compensationPromise = undefined;
		}
	}

	function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const run = lifecycleTail.then(operation, operation);
		lifecycleTail = run.then(() => undefined, () => undefined);
		return run;
	}

	function startBridge(): Promise<string> {
		return serializeLifecycle(startBridgeUnlocked);
	}

	async function startBridgeUnlocked(): Promise<string> {
		if (started) return "already";
		// 父子声明要在任何桥会话创建之前落地（PS 每次工具调用时实时读进程环境）
		syncPsForwardingEnv();
		try {
			appLock = AppLock.acquire(resolveAppLockFile(homeDir, config.appId), config.appId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lastError = message;
			reportedConnState = "error";
			// 锁由其他实例持有时不能覆盖 owner 的共享 status.json。
			setStatus("bridge", `飞书桥启动失败: ${message.slice(0, 60)}`);
			return `启动失败：${message}`;
		}
		started = true;
		stopping = false;
		reportedConnState = "connecting";
		lastError = undefined;
		status.startedAt = Date.now();
		updateStatus();
		try {
			await assemble();
			await transport!.start();
			outbox!.start();
			// 转发应答方要等 transport/outbox 就绪（弹卡要发得出去）。失败不阻塞桥启动：
			// 转发只是审批的升级路径，没起来退化成 PS 自己的判定（无人应答 → 拒绝）。
			try {
				await syncPsForwardingServer();
			} catch (error) {
				log.warn("feishu.approval.ps_forwarding_start_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			// 空闲会话回收巡检（无 active run/排队/审批且超 TTL 才回收句柄）
			convManager?.startLifecycle();
			// 会话文件权限与归档；status 心跳（含告警巡检）
			runRetention();
			startHeartbeat();
			// 定时任务（默认关闭）
			if (config.cron?.enabled) {
				cronScheduler = new CronScheduler({
					file: resolvePaths(homeDir).cronJobsFile,
					timeZone: () => config.timezone,
					catchUp: () => config.cron?.catchUp ?? "skip",
					onFire: fireCronJob,
					log: (level, m, meta) => log[level](m, meta),
				});
				cronScheduler.start();
			}
			// 查询应用归属人（owner/creator）与应用协作者，作为隐式管理员：自己驱动 agent
			// 时不必手工维护 open_id，且换应用后自动刷新（open_id 是按应用视角生成的）。
			// 注意：这些人只豁免群策略层；群内 @ 仍按 adminBypassMention（默认 false）判定。
			try {
				const info = await transport?.rawRequest({
					url: `/open-apis/application/v6/applications/${config.appId}`,
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
					const collab = await transport?.rawRequest({
						url: `/open-apis/application/v6/applications/${config.appId}/collaborators`,
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
				config.appOwnerId = ownerId;
				config.appCollaboratorIds = collaboratorIds.filter((id) => id !== ownerId);
				const hydrated = [...new Set([ownerId, ...collaboratorIds].filter((v): v is string => Boolean(v)))];
				config.implicitAdmins = hydrated;
				log.info("feishu.config.app_owner_hydrated", {
					hasOwner: Boolean(ownerId),
					collaboratorCount: collaboratorIds.length,
					totalImplicitAdmins: hydrated.length,
					adminBypassMention: config.adminBypassMention === true,
				});
			} catch (error) {
				log.warn("feishu.config.app_owner_hydrate_failed", {
					error: error instanceof Error ? error.message : String(error),
					hint: "缺少 application:application:readonly scope 时无法查询应用归属人；管理员仍按 config.admins 生效",
				});
				config.implicitAdmins = [];
			}
			setStatus("conn", "飞书桥启动中…");
			setStatus("bridge", "飞书桥已启动");
			log.info("feishu.bridge.features", { enabled: enabledFeatures(config) });
			log.info("bridge started", { bot: transport?.getBotIdentity() });
			updateStatus();
			return "started";
		} catch (err) {
			started = false;
			const msg = err instanceof Error ? err.message : String(err);
			lastError = msg;
			reportedConnState = "error";
			appLock?.release();
			appLock = undefined;
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
		stopping = true;
		reconnectSupervisor.cancel();
		stopHeartbeat();
		cronScheduler?.stop();
		cronScheduler = undefined;
		try {
			permissionBridge?.shutdown();
			// 先停应答方：未决的转发请求已被 shutdown() 判拒绝，等它们把响应写完再撤心跳，
			// 否则子会话要等满 10 分钟才知道没人服务。
			await psForwarding?.stop();
			// 入站在后台处理，先给在途消息一个有时限的收尾窗口（写进待处理记录后重启可恢复）
			try {
				await Promise.race([transport?.drainInbound(), new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
			} catch { /* best effort */ }
			try { await pipeline?.stop(); } catch { /* best effort */ }
			// 先停空闲回收巡检，避免关闭过程中回收句柄
			convManager?.stopLifecycle();
			// 未决提问全部失效（不假装重启后能恢复）
			const clarifyCancelled = clarificationStore?.shutdown() ?? 0;
			if (clarifyCancelled > 0) log.info("feishu.clarify.shutdown", { cancelled: clarifyCancelled });
			try { await convManager?.shutdown(); } catch { /* best effort */ }
			try { await outbox?.stop(); } catch { /* best effort */ }
			try {
				await transport?.stop();
			} catch {
				/* ignore */
			}
		} finally {
			started = false;
			reportedConnState = "disconnected";
			downSince = undefined;
			appLock?.release();
			appLock = undefined;
			updateStatus();
			setStatus("bridge", "飞书桥已停止");
		}
		return "stopped";
	}

	// 受控重连（指数退避 + 抖动，1s → 60s）；watchdog 每秒巡检，握手宽限期 15s。
	// 细节与 2026-09 重连风暴的根因见 runtime/reconnect-supervisor.ts。
	const reconnectSupervisor = new ReconnectSupervisor({
		isActive: () => started && !stopping,
		target: () => transport,
		// getter：supervisor 在 session_start 加载配置之前就构造了
		get selfHealMaxMs() { return config.transport?.selfHealMaxMs; },
		onScheduled: (attempt, delay) => {
			setStatus("conn", `飞书桥重连中（第 ${attempt} 次）`);
			log.warn("transport reconnect scheduled", { attempts: attempt, delay: Math.round(delay) });
		},
		onError: (err) => {
			lastError = err instanceof Error ? err.message : String(err);
			reportedConnState = "error";
			downSince ??= Date.now();
			log.error("reconnect failed", { error: lastError });
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
			lastErrorClass: status.lastError ? "last_error_present" : undefined,
			outbox: status.outbox,
			conversations: status.conversations,
			pendingApprovals: status.pendingApprovals ?? 0,
			budget: convManager?.budgetSnapshot(),
			piVersion: process.env.PI_VERSION,
			reconnectsLast5m: reconnectSupervisor.reconnectsInWindow(),
			statusHeartbeatMs: config.statusHeartbeatMs ?? 30_000,
			uptimeMs: Math.round(process.uptime() * 1_000),
			transport: { running: Boolean(transport?.isRunning()), connected: Boolean(transport?.isConnected()) },
			forwarding: {
				enabled: Boolean(psForwarding),
				parentSessionId: psForwardingParentId,
				// 心跳新鲜度 = 父会话真的在服务。缺了它子会话会判「父会话不在服务」而提前放弃，
				// 而这种情况在日志里只表现为"等到超时"，很难定位 —— 所以 doctor 里明说。
				serving: psForwarding ? psForwarding.isServing() : undefined,
				alwaysApproved: alwaysApproved
					? {
						enabled: config.approval.forwarding?.alwaysApprove !== false,
						count: alwaysApproved.size,
						patterns: alwaysApproved.list().map((rule) => rule.pattern),
					}
					: undefined,
			},
		};
	}

	function statusText(): string {
		updateStatus();
		const lines = [
			`连接: ${status.connState}（重连 ${status.reconnectCount} 次，近 5 分钟 ${status.reconnectsLast5m ?? 0} 次）`,
			`bot: ${status.botName ?? "?"} (${status.botOpenId ?? "?"})`,
			`会话数: ${status.conversations}`,
			`会话队列: queued ${status.sessionQueues?.queued ?? 0} / active ${status.sessionQueues?.active ?? 0} / waiting ${status.sessionQueues?.waiting ?? 0}`,
			`待审批: ${status.pendingApprovals ?? 0}`,
			`outbox: pending ${status.outbox.pending} / sending ${status.outbox.sending} / sent ${status.outbox.sent} / failed ${status.outbox.failed} / lanes ${status.outbox.lanes} / oldest ${Math.round(status.outbox.oldestAgeMs / 1000)}s`,
			`消息: 总 ${status.messageTotal} / 丢弃 ${status.messageDropped}`,
			`补收: ${status.compensatedMessages} / 错误 ${status.compensationErrors} / 窗口截断 ${status.compensationTruncated}`,
			`策略: 全局 ${config.groupPolicy}${Object.keys(config.groupPolicyByChat).length ? `，覆盖 ${JSON.stringify(config.groupPolicyByChat)}` : ""}`,
			`群白名单: ${config.allowChats.length ? config.allowChats.join(", ") : "（全部群按策略）"}`,
		];
			// 预算/熔断状态（限流冷却时显示恢复时间，明确 final 不受影响）
			const budget = convManager?.budgetSnapshot();
			if (budget) {
				const live = budget.categories.live ?? { tokens: 0, rejected: 0 };
				const notice = convManager?.budgetCooldownNotice?.();
				lines.push(notice
					? `限流预算: ${notice}`
					: `限流预算: live 令牌 ${live.tokens} / 跳过 ${live.rejected} / 连续失败 ${budget.failures}`);
			}
			if (status.lastMessageAt) {
				// 用配置时区而不是容器时区：容器常是 UTC，直接 toLocaleTimeString() 会差 8 小时。
				lines.push(`最近消息: ${formatTimeInZone(status.lastMessageAt, config.timezone)}`);
			}
			if (status.lastError) lines.push(`最近错误: ${status.lastError.slice(0, 200)}`);
			if (feedbackCounts.up || feedbackCounts.down) lines.push(`反馈（本次启动以来）: 👍 ${feedbackCounts.up} / 👎 ${feedbackCounts.down}`);
			if (cronScheduler) lines.push(`定时任务: ${cronScheduler.list().filter((job) => job.enabled).length} 个启用`);
			for (const failure of outbox?.recentFailures(3) ?? []) {
				lines.push(`发送失败: ${failure.kind} @ ${formatTimeInZone(failure.updatedAt, config.timezone)} · ${(failure.lastError ?? "").slice(0, 80)}`);
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
		handler: (_args, _ctx, args: string[]) => alwaysApprovedCommand(args ?? [], { prefix: "/feishu:always" }),
	});
	pi.registerCommand("feishu:policy", {
		description: "设置单群策略：/feishu:policy <chatId> <open|mention|disabled|allowlist|blacklist|admin_only>",
		handler: (_args, _ctx, args: string[]) => {
			const [chatId, policy] = args;
			if (!chatId || !policy || !VALID_POLICIES.includes(policy as GroupPolicy)) return `用法：/feishu:policy <chatId> <${VALID_POLICIES.join("|")}>`;
			return setChatPolicy(chatId, policy as GroupPolicy) ? `已设置 ${chatId} → ${policy}（已落盘）` : "落盘失败，运行态未修改";
		},
	});
	pi.registerCommand("feishu:debug", {
		description: "开关 debug 日志：/feishu:debug on|off",
		handler: (_args, _ctx, args: string[]) => {
			const flag = args[0];
			if (flag !== "on" && flag !== "off") return "用法：/feishu:debug on|off";
			config.debug = flag === "on";
			saveConfigFields(homeDir, config, ["debug"]);
			return `debug = ${config.debug}`;
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
		convManager?.onToolEvent(sessionId, toolName, "start", (ev.args ?? {}) as Record<string, unknown>, toolCallId);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const sessionId = (ctx as { sessionManager?: { getSessionId(): string } })?.sessionManager?.getSessionId() ?? "";
		const toolName = (event as { toolName?: string })?.toolName ?? "tool";
		const endToolCallId = typeof (event as { toolCallId?: unknown }).toolCallId === "string" ? (event as { toolCallId: string }).toolCallId : undefined;
		convManager?.onToolEvent(sessionId, toolName, "end", undefined, endToolCallId);
	});

	pi.on("session_start", async () => {
		homeDir = process.env.FEISHU_BRIDGE_HOME ?? pi.getAgentDir();
		config = loadConfig(homeDir);
		// PS 父会话转发的父子声明越早越好：它要在任何桥会话被创建之前就位。
		syncPsForwardingEnv();
		if (!config.appId || !config.appSecret) {
			log.warn("FEISHU_APP_ID/SECRET 未配置，桥未启动。请配置后运行 /feishu:start。");
			return;
		}
		await startBridge();
		// 网关重启恢复：重发上次中断的未完成消息（hermes resume_pending）
		const recovered = await convManager?.recoverPending() ?? 0;
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
		stopping = true;
		reconnectSupervisor.cancel();
		clearInterval(watchdog);
		await stopBridge();
	});
}

/**
 * pi 配置目录：PS 的转发目录与配置都在它下面。
 * 优先 PI_CODING_AGENT_DIR，其次 pi 自己报告的目录（`pi.getAgentDir()`，扩展加载时记下），
 * 最后才猜 `cwd/pi-agent` —— 只猜 cwd 在非容器环境里会指错。
 */
let piAgentDir: string | undefined;
function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? piAgentDir ?? join(process.cwd(), "pi-agent");
}

/** pi-permission-system 的配置文件。 */
function psConfigFile(): string {
	return join(resolveAgentDir(), "extensions", "pi-permission-system", "config.json");
}

/**
 * 检查 @gotgenes/pi-permission-system 是否真的装在 agent 目录里。
 * 用途：policyEngine=pi-permission-system 时的默认拒绝判定 —— 若扩展缺席，
 * 桥的审批就是唯一防线，此时必须继续用自己的策略而不是静默放行。
 * 父会话转发（approval.forwarding）也复用该判定：扩展不在就没有 ask 会转发过来。
 *
 * 每次工具调用都会判定一次，结果缓存 60 秒（装/卸扩展本来就要重启才生效）。
 */
let psInstalledCache: { at: number; dir: string; value: boolean } | undefined;
function piPermissionSystemInstalled(): boolean {
	const agentDir = resolveAgentDir();
	const now = Date.now();
	if (psInstalledCache && psInstalledCache.dir === agentDir && now - psInstalledCache.at < 60_000) return psInstalledCache.value;
	const candidates = [
		join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system"),
		join(agentDir, "extensions", "pi-permission-system"),
	];
	const value = candidates.some((dir) => {
		try {
			return existsSync(join(dir, "package.json"));
		} catch {
			return false;
		}
	});
	psInstalledCache = { at: now, dir: agentDir, value };
	return value;
}
