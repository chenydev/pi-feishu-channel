/**
 * 按当前配置装配桥的核心组件（每次启动一次）：飞书长连接、审批（含「始终批准」规则表）、澄清提问、发送器与持久发送队列、
 * 会话管理（含子会话的内联扩展）、入站流水线。组件都挂在 `BridgeRuntime` 上。
 *
 * 组件之间的回调（连接状态、卡片点击、平台事件、命令、准入拒绝……）由调用方通过 `AssembleContext` 提供，
 * 这里只负责把它们接到对应组件上。
 */
import { join } from "node:path";
import { AlwaysApprovedStore } from "../approval/always-approved-store.js";
import { buildApprovalCard } from "../approval/cards.js";
import type { ToolGateResult } from "../approval/gate.js";
import { PermissionBridge, redactParams } from "../approval/permission-bridge.js";
import { loadJsonFile, saveConfigFields, resolvePaths } from "../config.js";
import type { FeatureHost } from "../features/feature.js";
import { LastSentCache, effectiveAdmins } from "../inbound/admit.js";
import { DedupeStore } from "../inbound/dedupe-store.js";
import { deliverDocCommentReply } from "../inbound/doc-comments.js";
import { InboundPipeline } from "../inbound/pipeline.js";
import { ResourceResolver } from "../inbound/resource-resolver.js";
import type { LarkSdkLike, TransportDeps } from "../inbound/transport.js";
import { ClarificationStore, buildClarificationCard, clarificationAnswersText, clarificationTextFallback, isAtomicClarificationCard, skippedCardFor, type ClarificationRecord } from "../interaction/clarification-store.js";
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

/**
 * 待答提问给会话的「保护窗口」：这段时间内会话不算空闲（别把等待中的会话回收掉），
 * 之后照常回收 —— 记录和卡片是持久的，用户点卡片时会按指针重建会话。
 * 不能直接用卡片 TTL（24 小时）：那样空闲会话基本永远回收不了。
 */
const CLARIFY_PROTECT_MS = 15 * 60_000;

/** 把「已跳过」的提问卡重绘成只读，免得之后误点插进过时答案。 */
function redrawClarificationCards(rt: { transport?: { updateCard(messageId: string, card: unknown): Promise<boolean> } }, records: ClarificationRecord[]): void {
	for (const record of records) {
		if (!record.cardMessageId) continue;
		void rt.transport?.updateCard(record.cardMessageId, skippedCardFor(record)).catch(() => undefined);
	}
}

/**
 * 等待超时：卡片**保持可点**，只在原子卡上加一行「等待已结束」。
 *
 * 表单卡不重绘 —— 用户可能正在里面勾选/填写，整卡替换会把他没提交的输入清掉。
 */
function notifyWaitEnded(rt: { transport?: { updateCard(messageId: string, card: unknown): Promise<boolean> } }, record: ClarificationRecord): void {
	if (!record.cardMessageId || !isAtomicClarificationCard(record)) return;
	void rt.transport?.updateCard(record.cardMessageId, buildClarificationCard(record, {
		note: "⏳ 已经等了一会儿还没收到你的选择 —— 这张卡仍然有效，点一下就行（或直接回复编号）。",
	})).catch(() => undefined);
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
	// 谁能作答由卡片按钮按准入判定（能在这里 @ 机器人的人），见 interaction/card-ops.ts
	rt.clarificationStore = new ClarificationStore({
		file: paths.clarificationsFile,
		ttlMs: rt.config.clarify?.ttlMs,
		onAudit: (event) => log.info("feishu.clarify.audit", event),
	});
	// 「始终批准」规则表（pi-permission-system 模式下的审批卡用；每次启动按配置重建）
	rt.alwaysApproved = rt.config.approval.plugin?.alwaysApprove === false
		? undefined
		: new AlwaysApprovedStore({ file: paths.alwaysApprovedFile });
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
		onCardRefresh: async (pending) => {
			if (!pending.cardMessageId) return true;
			try {
				return (await rt.transport?.updateCard(pending.cardMessageId, buildApprovalCard(pending))) ?? false;
			} catch (error) {
				log.warn("feishu.approval.card_refresh_failed", { approvalId: pending.id, error: error instanceof Error ? error.message : String(error) });
				return false;
			}
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
			// 以文件里当前的名单为底：配置只在启动时读一次，进程运行期间手工加进文件的项
			// 不能被内存里的旧名单覆盖掉（合并后内存也同步成文件的样子）。
			const onDisk = loadJsonFile<{ approval?: { autoApprove?: unknown } }>(paths.configFile)?.approval?.autoApprove;
			const base = Array.isArray(onDisk) ? onDisk.filter((item): item is string => typeof item === "string") : previous;
			rt.config.approval.autoApprove = base.includes(toolName) ? base : [...base, toolName];
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
		onTerminalFailure: (entry, info) => {
			if (entry.kind !== "final" && entry.kind !== "error") return;
			const reason = /230072|edited/i.test(entry.lastError ?? "") ? "消息编辑次数已达上限"
				: /permission|403|forbidden|not in chat|230002/i.test(entry.lastError ?? "") ? "机器人在该会话没有发言权限"
				: "飞书接口持续报错";
			// 长回答会拆成多条：有兄弟条目说明这次只有一段没发出去，其它段照常送达 ——
			// 提示必须说「可能不完整」，否则读者会以为整条回复都没到。
			const text = (info?.siblings ?? 0) > 0
				? `⚠️ 回复的一部分没有发送成功（${reason}），上面的内容可能不完整；请重试这一句或联系管理员。`
				: `⚠️ 回复发送失败（${reason}），请重试或联系管理员。`;
			try {
				rt.outbox?.enqueue(entry.route.chatId, text, { threadId: entry.route.threadId }, {
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
		runToolIdleTimeoutMs: rt.config.runToolIdleTimeoutMs,
		runMaxDurationMs: rt.config.runMaxDurationMs,
		sessionBackend: ctx.sessionBackend ?? new PiSessionBackend({
			sessionDir: paths.sessionDir,
			log: (l, m, x) => log[l](m, x),
			// 给每个子会话注入桥侧 hook（审批 gate + 文件工具），共享 outer 桥状态；
			// 同时剔除网关扩展，避免子会话重复启动飞书 WS / 创建空状态。
			bridgeExtensionFactory: createBridgeInlineExtension({
				routeForSessionId: (sessionId) => rt.convManager?.routeForSessionId(sessionId),
				// pi-permission-system 的「询问」→ 审批卡（PS 没装时只是多听一个不会触发的事件）
				attachPermissions: (pi) => rt.psAuthorizer?.attach(pi),
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
			// 澄清提问：发出卡片就返回，不等待（本轮随即结束）；用户点选项会以新消息进入会话
			askChoice: async (input) => {
				if (!rt.clarificationStore) return { status: "unavailable" as const, detail: "澄清存储未初始化" };
				if (!input.route?.chatId) return { status: "unavailable" as const, detail: "没有活动会话" };
				const record = rt.clarificationStore.create({
					conversationKey: input.route.conversationKey, chatId: input.route.chatId, threadId: input.route.threadId,
					chatType: input.route.chatType, askerId: input.route.senderId,
					question: input.question, options: input.options,
					...(input.questions?.length
						? { questions: input.questions }
						: input.multiSelect || input.allowOther || input.recommended || input.reason
							? { questions: [{
								id: "q1", question: input.question, options: input.options,
								...(input.multiSelect ? { multiSelect: true } : {}),
								...(input.allowOther ? { allowOther: true } : {}),
								...(input.recommended ? { recommended: input.recommended } : {}),
								...(input.reason ? { reason: input.reason } : {}),
							}] }
							: {}),
					...(input.radio && !input.questions?.length && !input.multiSelect && !input.allowOther ? { radio: true } : {}),
					...(rt.config.clarify?.panels === false ? { panels: false } : {}),
				});
				try {
					const messageId = await rt.transport?.sendCard(input.route.chatId, buildClarificationCard(record), {
						replyTo: input.route.sourceMessageId, threadId: input.route.threadId,
					});
					if (rt.clarificationStore.attachCard(record.id, messageId)) {
						log.info("feishu.clarify.asked", { conversationKey: record.conversationKey, clarificationId: record.id, options: record.options.length });
						// 有界等待：等到就当作工具结果返回（同一轮继续）；超时按 onTimeout 处理。
						// 默认 60 秒：多数人几十秒内会点，再长就不是「等着」而是「挂起」了。
						const waitMs = Math.max(0, input.waitSeconds !== undefined
							? Math.round(input.waitSeconds * 1000)
							: (rt.config.clarify?.waitMs ?? 60_000));
						if (waitMs === 0) return { status: "card" as const };
						const outcome = await rt.clarificationStore.waitForAnswer(record.id, waitMs, input.signal);
						if (outcome.kind === "answered") {
							return { status: "answered" as const, text: clarificationAnswersText(outcome.answers), late: Boolean(outcome.record.timedOutAt) };
						}
						if (outcome.kind === "cancelled") {
							log.info("feishu.clarify.wait_cancelled", { clarificationId: record.id });
							return { status: "cancelled" as const };
						}
						if (outcome.kind === "dropped") {
							return { status: "abandoned" as const, detail: `提问已失效（${outcome.reason}）` };
						}
						// 超时：只报告「还没答」，绝不替用户选。卡片保留（点选项仍然有效），
						// 原子卡顺手重绘一行「等待已结束」，否则用户会以为还在等他。
						log.info("feishu.clarify.wait_timeout", { clarificationId: record.id, waitMs });
						notifyWaitEnded(rt, record);
						return { status: "pending" as const, waitedMs: waitMs };
					}
				} catch (error) {
					log.warn("feishu.clarify.card_failed", { error: error instanceof Error ? error.message : String(error) });
				}
				// 卡片发不出去（例如无卡片权限）：退化为文字选择题，用户直接回复文字
				rt.clarificationStore.discard(record.id);
				if (!rt.outbox) return { status: "unavailable" as const, detail: "卡片和文字都发不出去" };
				rt.outbox.enqueue(input.route.chatId, clarificationTextFallback(record), { replyTo: input.route.sourceMessageId, threadId: input.route.threadId }, {
					dedupeKey: `${input.route.conversationKey}:${input.toolCallId}:clarify`, laneKey: input.route.conversationKey, kind: "notify",
				});
				return { status: "text" as const };
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
		// 待处理记录终结时告知入站去重层（已处理完的）—— 否则平台重投同一条会被当成
		// 「准入前崩溃」的 orphan 重新准入并再执行一遍。pipeline 在之后才装配，所以晚绑定。
		onPendingDone: (messageId) => rt.pipeline?.markCompleted(messageId),
		// 会话指针持久化 —— /new 后重启仍处于新会话，不回退到旧上下文。
		conversationFile: join(paths.sessionDir, "..", "conversations.jsonl"),
		modelUsageFile: paths.modelUsageFile,
		// run 结束/会话重置时撤销未决审批卡（旧卡不得再授予权限）。
		// 有未决审批的会话不允许回收句柄（避免审批卡失去响应目标）。
		// 澄清提问不算：它不阻塞会话，记录落盘，句柄回收后点击照样进入会话
		pendingApprovalCount: (conversationKey) => rt.permissionBridge?.pendingForConversation(conversationKey) ?? 0,
		pendingClarificationCount: (conversationKey) => rt.clarificationStore?.pendingRecentCount(conversationKey, CLARIFY_PROTECT_MS) ?? 0,
		resolveClarifyText: (conversationKey, text) => rt.clarificationStore?.attemptTextResponse(conversationKey, text),
		onClarifySkipped: (records) => {
			log.info("feishu.clarify.skipped", { count: records.length });
			redrawClarificationCards(rt, records);
		},
		onApprovalInvalidate: ({ conversationKey, runId, reason }) => {
			if (!rt.permissionBridge) return;
			const cancelled = runId
				? rt.permissionBridge.cancelRun(conversationKey, runId)
				: rt.permissionBridge.cancelConversation(conversationKey);
			// 澄清提问只在会话重置时失效：发出提问后本轮就结束了，run 结束不能带走它
			const clarifyCancelled = runId ? 0 : rt.clarificationStore?.cancelConversation(conversationKey) ?? 0;
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
