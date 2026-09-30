/**
 * 按当前配置装配桥的核心组件（每次启动一次）：飞书长连接、审批、澄清提问、发送器与持久发送队列、
 * 会话管理（含子会话的内联扩展）、入站流水线。组件都挂在 `BridgeRuntime` 上。
 *
 * 组件之间的回调（连接状态、卡片点击、平台事件、命令、准入拒绝……）由调用方通过 `AssembleContext` 提供，
 * 这里只负责把它们接到对应组件上。
 */
import { join } from "node:path";
import { buildApprovalCard } from "../approval/cards.js";
import type { ToolGateResult } from "../approval/gate.js";
import { PermissionBridge, redactParams } from "../approval/permission-bridge.js";
import { saveConfigFields, resolvePaths } from "../config.js";
import type { FeatureHost } from "../features/feature.js";
import { LastSentCache, effectiveAdmins } from "../inbound/admit.js";
import { DedupeStore } from "../inbound/dedupe-store.js";
import { deliverDocCommentReply } from "../inbound/doc-comments.js";
import { InboundPipeline } from "../inbound/pipeline.js";
import { ResourceResolver } from "../inbound/resource-resolver.js";
import type { LarkSdkLike, TransportDeps } from "../inbound/transport.js";
import { ClarificationStore, buildClarificationCard, clarificationTextFallback } from "../interaction/clarification-store.js";
import { queueLocalFile } from "../outbound/local-file-tool.js";
import { Outbox } from "../outbound/outbox.js";
import { Sender } from "../outbound/sender.js";
import type { UsageProvider } from "../outbound/usage-provider.js";
import { ConversationManager, type ConversationManagerDeps } from "../session/conversation-manager.js";
import { createBridgeInlineExtension, type BridgeGateInput } from "../session/pi-bridge-hooks.js";
import { PiSessionBackend } from "../session/pi-session-backend.js";
import type { FeishuInboundMessage, SessionBackend } from "../types.js";
import type { BridgeRuntime } from "./bridge-runtime.js";
import { KnownChatStore } from "./known-chat-store.js";
import type { BridgeLogger } from "./logger.js";
import { UsageLedger } from "./usage-ledger.js";

export interface AssembleContext {
	rt: BridgeRuntime;
	log: BridgeLogger;
	features: FeatureHost;
	/** 测试替身（生产不传）。 */
	larkSdk?: LarkSdkLike;
	sessionBackend?: SessionBackend;
	/** 飞书长连接状态变化。 */
	onConnState: NonNullable<TransportDeps["onStatus"]>;
	onCardAction: NonNullable<TransportDeps["onCardAction"]>;
	onLifecycleEvent: NonNullable<TransportDeps["onLifecycleEvent"]>;
	/** 工具调用审批检查（子会话内联扩展调用）。 */
	gateToolCall(input: BridgeGateInput): Promise<ToolGateResult>;
	/** 斜杠命令；返回 false 表示不是桥的命令。 */
	dispatchCommand(msg: FeishuInboundMessage): Promise<boolean>;
	/** 准入拒绝（未放行的群里 @ 机器人等）。 */
	onAdmissionDrop(msg: FeishuInboundMessage, reason: string, mentioned: boolean): Promise<void>;
	updateStatus(): void;
	usageProvider(): UsageProvider;
	sendLocalFile: NonNullable<ConversationManagerDeps["sendLocalFile"]>;
}

export async function assembleBridge(ctx: AssembleContext): Promise<void> {
	const { rt, log } = ctx;
	const paths = resolvePaths(rt.homeDir);
	rt.knownChats = new KnownChatStore(paths.knownChatsFile);
	const { createFeishuTransport } = await import("../inbound/transport-factory.js");
	rt.transport = await createFeishuTransport(rt.config, {
		onMessage: async (msg) => {
			if (msg.chatId) rt.knownChats?.add(msg.chatId);
			await rt.pipeline?.handle(msg);
		},
		onStatus: ctx.onConnState,
		onCardAction: ctx.onCardAction,
		onLifecycleEvent: ctx.onLifecycleEvent,
		log: (level, m, meta) => log[level](m, meta),
	}, ctx.larkSdk);
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
		onChange: ctx.updateStatus,
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
		sessionBackend: ctx.sessionBackend ?? new PiSessionBackend({
			sessionDir: paths.sessionDir,
			log: (l, m, x) => log[l](m, x),
			// 给每个子会话注入桥侧 hook（审批 gate + 文件工具），共享 outer 桥状态；
			// 同时剔除网关扩展，避免子会话重复启动飞书 WS / 创建空状态。
			bridgeExtensionFactory: createBridgeInlineExtension({
				routeForSessionId: (sessionId) => rt.convManager?.routeForSessionId(sessionId),
				markToolBoundary: (sessionId) => rt.convManager?.markPendingToolBoundary(sessionId),
				gateToolCall: (input) => ctx.gateToolCall(input),
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
				// agent 自定义卡片（可选能力，默认关闭：关闭时子会话里根本不注册这个工具）
				cardTool: () => ctx.features.first("sendCard") !== undefined,
				// 云文档读取工具（可选能力，默认关闭）
				docTool: () => ctx.features.first("readDoc") !== undefined,
				readDoc: (ref) => ctx.features.first("readDoc")?.(ref) ?? Promise.resolve({ content: [{ type: "text", text: "云文档读取未启用（config.docTools.enabled）" }], isError: true }),
				sendCard: (input) => ctx.features.first("sendCard")?.(input) ?? Promise.resolve({ content: [{ type: "text", text: "agent 自定义卡片未启用（config.cardTool.enabled）" }], isError: true }),
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
		cnyPerUsd: (model) => ctx.usageProvider().cnyPerUsd(model),
		exportsDir: paths.exportsDir,
		sendLocalFile: ctx.sendLocalFile,
		replyAsFile: (input) => ctx.features.first("replyAsFile")?.(input) ?? input.text,
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
			// 语音转写（可选能力，默认关闭）
			transcribe: ctx.features.first("transcribe"),
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
		onCommand: ctx.dispatchCommand,
		onDrop: (msg, reason, mentioned) => { void ctx.onAdmissionDrop(msg, reason, mentioned); },
		log: (level, m, meta) => log[level](m, meta),
	});
}
