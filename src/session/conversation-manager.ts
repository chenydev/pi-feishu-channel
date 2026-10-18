/**
 * 会话管理器：Map<conversationKey, BridgeSession>，每 chat 独立 session/queue/activeRun。
 * 按会话隔离的思路参考 pi-remote-feishu 的 ConversationRouter。
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { EXTERNAL_CHAT_PREFIX, type FeishuInboundMessage, type ReloadSummary } from "../types.js";
import { buildConversationKey } from "./conversation-key.js";
import { PendingStore } from "./pending-store.js";
import { ConversationStore, type ConversationPointer } from "./conversation-store.js";
import type { IntakeLedger } from "../inbound/pipeline.js";
import type { ResolvedTurnResources } from "../inbound/resource-resolver.js";
import { sanitizeCommand } from "../outbound/progress-render.js";
import { ProgressTracker } from "./progress-tracker.js";
import { LiveChannel, SerialWriter } from "../outbound/live-channel.js";
import { type createRunMetrics, elapsedMs as metricsElapsedMs, renderFooter } from "../outbound/run-metrics.js";
import { resolveFooterEnabled } from "../config.js";
import { cnyPerUsdForModel } from "../outbound/deepseek-usage.js";
import type { UsageSnapshot } from "../commands/usage-card.js";
import { RateBudget } from "../runtime/rate-budget.js";
import { randomUUID } from "node:crypto";
import { budgetState } from "../runtime/usage-ledger.js";
import { previewText } from "./text-utils.js";
import { RunExecutor } from "./run-executor.js";
import { buildTurnInput } from "./turn-input.js";
import { SessionTable } from "./session-table.js";
import { createHistoryOps, type HistoryOps } from "./history-ops.js";
import { createNoticeSender, queuedNoticeText } from "./notices.js";
import { SessionScheduler } from "./scheduler.js";
import { ConversationCommands } from "./conversation-commands.js";
import { sessionUsageStats } from "./model-utils.js";
import { type RunActivity, busyNoticeText, describeProgress, durationLabel } from "./run-activity.js";

export type AgentHandle = import("./agent-types.js").AgentHandle;
import { resolveToolPolicy } from "./tool-policy.js";
export { resolveToolPolicy };
import { MAX_QUEUE, type BridgeSession, type ConversationManagerDeps, type LongReplyInput, type QueuedMessage, type ResetOutcome, type RunRetireReason } from "./session-types.js";
export type {
	BridgeSession, ConversationManagerDeps, LongReplyInput, QueuedMessage, ResetOutcome, RunRetireReason,
};

/**
 * 决定会话文件 —— 有持久指针则用它；否则用确定性路径并写入 generation=1。
 * 首次采用确定性路径时写指针失败只记日志：不得因此指向其他会话。
 */
function resolveSessionFile(
	sessionDir: string,
	key: string,
	inMemorySuffix: string | undefined,
	pointer: ConversationPointer | undefined,
	store: ConversationStore | undefined,
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void,
): string {
	if (pointer) return pointer.sessionFile;
	const sessionFile = join(sessionDir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}${inMemorySuffix ?? ""}.jsonl`);
	if (store) {
		try {
			store.set({ conversationKey: key, sessionFile, generation: 1 });
		} catch (error) {
			log?.("error", "feishu.conv.pointer_init_failed", {
				conversationKey: key,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return sessionFile;
}

export class ConversationManager {
	private sessions = new SessionTable<BridgeSession>();
	/**
	 * 恢复提示（对齐 hermes build_resume_recovery_note）：崩溃恢复后给模型注入
	 * 一条方括号元信息，告诉它"上次中断了，不要重跑历史里未完成的工具调用"。
	 * 按 conversationKey 索引 —— 恢复后用户会发**新**消息（新 messageId），
	 * 按被中断那条消息的 id 索引永远匹配不上。注入一次即删除；
	 * 只在内存里，不落盘、不发给用户。
	 */
	private readonly recoveryNotes = new Map<string, string>();
	private runIdleTimeoutMs: number;
	private runToolIdleTimeoutMs: number;
	private runMaxDurationMs: number;
	private now: () => number;
	/** 进度气泡独立成类，见 progress-tracker.ts。 */
	private readonly progress: ProgressTracker;
	private readonly pendingFile: string;
	private readonly pendingEnabled: boolean;
	private readonly pendingStore?: PendingStore;
	/** 调度（pump/公平性/并发上限）独立成类，见 scheduler.ts。 */
	private readonly scheduler: SessionScheduler<BridgeSession, QueuedMessage>;
	/** 单轮执行独立成类，见 run-executor.ts。 */
	private readonly executor: RunExecutor;
	/** 模型/思考/历史会话/工作区命令（见 conversation-commands.ts）；调用方直接用 `manager.commands.xxx()`。 */
	readonly commands: ConversationCommands;
	private get activeItems(): Map<string, QueuedMessage> { return this.scheduler.activeItems; }
	private readonly liveChannel?: LiveChannel;
	private readonly nextSessionSuffix = new Map<string, string>();
	/** 会话指针持久化（/new 后重启仍指向新会话）。 */
	private readonly conversationStore?: ConversationStore;
	/** 内存工作区别名（与持久化指针互补，避免无 store 时丢失当前工作区认知）。 */
	private readonly workspaceAliasByKey = new Map<string, string>();
	/** 共享请求预算（流式更新通道让路给最终交付与审批）。 */
	private readonly rateBudget: RateBudget;
	/** 空闲回收参数与定时器。 */
	private readonly idleTtlMs: number;
	private readonly maxResidentSessions: number;
	private readonly sweepIntervalMs: number;
	private sweepTimer?: ReturnType<typeof setInterval>;
	private shuttingDown = false;
	private readonly shutdownTimeoutMs: number;
	/** 已发过的预算提醒（chatId:date:state）。 */
	private readonly budgetNotices = new Set<string>();

	private readonly notices: ReturnType<typeof createNoticeSender>;
	private readonly history: HistoryOps;

	constructor(private deps: ConversationManagerDeps) {
		// deps 是构造参数属性，字段初始化时还读不到 —— 只能在这里建
		this.notices = createNoticeSender({ sender: deps.sender, durableOutbox: deps.durableOutbox, log: deps.log });
		// 对齐 hermes 的做法：**不设固定总时长**（长时间跑测试是正常的），
		// 只在「完全没有事件产出」时才判定卡死 —— 空闲超时。
		this.runIdleTimeoutMs = deps.runIdleTimeoutMs ?? 600_000;
		this.runToolIdleTimeoutMs = deps.runToolIdleTimeoutMs ?? 3_600_000;
		this.runMaxDurationMs = deps.runMaxDurationMs ?? 0;
		this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 2_000;
		this.now = deps.now ?? Date.now;
		this.pendingFile = deps.pendingFile ?? "";
		this.pendingEnabled = Boolean(deps.pendingFile);
		this.pendingStore = this.pendingEnabled
			? new PendingStore(this.pendingFile, { now: this.now, onDone: (messageId) => this.deps.onPendingDone?.(messageId) })
			: undefined;
		this.conversationStore = deps.conversationFile
			? new ConversationStore(deps.conversationFile, { now: this.now })
			: undefined;
		this.history = createHistoryOps({
			config: deps.config,
			sessions: this.sessions,
			busyReason: (key) => this.busyReason(key),
			openAgent: (msg) => this.idleAgent(msg),
			requeue: async (msg, item) => {
				await this.route({ ...msg, text: item.text, msgType: "text", resources: item.resources, replyToMessageId: item.replyToMessageId, replyToText: item.replyToText } as FeishuInboundMessage, { behavior: "queue" });
			},
			conversationStore: this.conversationStore,
			exportsDir: deps.exportsDir,
			sendLocalFile: deps.sendLocalFile,
			onApprovalInvalidate: deps.onApprovalInvalidate,
			discardChannel: (key) => this.liveChannel?.discard(key),
			log: deps.log,
			now: () => this.now(),
		});

		this.idleTtlMs = Math.max(0, deps.config.sessionLifecycle?.idleTtlMs ?? 30 * 60_000);
		this.maxResidentSessions = Math.max(1, deps.config.sessionLifecycle?.maxResidentSessions ?? 32);
		this.sweepIntervalMs = Math.max(1_000, deps.config.sessionLifecycle?.sweepIntervalMs ?? 60_000);
		this.rateBudget = new RateBudget();
		if (deps.editMessage) {
			this.liveChannel = new LiveChannel({ edit: deps.editMessage, budget: this.rateBudget, log: deps.log });
		}
		this.progress = new ProgressTracker({
			config: deps.config, sender: deps.sender, editMessage: deps.editMessage, recallMessage: deps.recallMessage,
			liveChannel: this.liveChannel,
			// 进度消息的串行写入器（与流式通道同语义，避免同一目标并发/乱序）
			writer: deps.editMessage ? new SerialWriter({ edit: deps.editMessage, log: deps.log }) : undefined,
			log: deps.log,
			now: () => this.now(),
		});
		// 协作者通过 host 访问管理器：用 getter/闭包而不是快照，运行期被改的字段（测试、配置热更）立即可见
		const self = this;
		this.commands = new ConversationCommands(deps, {
			get sessions() { return self.sessions; },
			get conversationStore() { return self.conversationStore; },
			get liveChannel() { return self.liveChannel; },
			nextSessionSuffix: this.nextSessionSuffix,
			workspaceAliasByKey: this.workspaceAliasByKey,
			now: () => this.now(),
			getOrCreateSession: (msg, key) => this.getOrCreateSession(msg, key),
			ensureAgentSession: (session) => this.ensureAgentSession(session),
			pendingWork: (key) => this.pendingWork(key),
		});
		this.scheduler = new SessionScheduler<BridgeSession, QueuedMessage>({
			maxActive: () => this.deps.config.maxActiveSessions,
			isShuttingDown: () => this.shuttingDown,
			runTurn: (sess, item) => this.executor.run(sess, item),
			log: deps.log,
		});
		this.executor = new RunExecutor(deps, {
			get shuttingDown() { return self.shuttingDown; },
			get runIdleTimeoutMs() { return self.runIdleTimeoutMs; },
			get runMaxDurationMs() { return self.runMaxDurationMs; },
			get progress() { return self.progress; },
			get liveChannel() { return self.liveChannel; },
			get rateBudget() { return self.rateBudget; },
			now: () => this.now(),
			ensureAgentSession: (sess) => this.ensureAgentSession(sess),
			prepareAgentInput: (item, key) => this.prepareAgentInput(item, key),
			touchRunActivity: (sess) => this.touchRunActivity(sess),
			footerFor: (metrics, sess) => this.footerFor(metrics, sess),
			rememberSentFooter: (footer) => this.rememberSentFooter(footer),
			recordRunUsage: (sess, item, metrics) => this.recordRunUsage(sess, item, metrics),
			removeProcessingReaction: (sess, item) => this.removeProcessingReaction(sess, item),
			clearPending: (item) => this.clearPending(item),
			drainPiSteerQueue: (sess) => this.drainPiSteerQueue(sess),
			notify: (...args) => this.notify(...args),
		});
	}

	/**
	 * sessionId → 会话（索引的自我修正在 `SessionTable.byId` 里）。
	 */
	private sessionById(sessionId: string): BridgeSession | undefined {
		return this.sessions.byId(sessionId);
	}

	/** 工具事件 → 追加一行进度日志（`pi.on("tool_execution_start/end")` 转接用）。
	 *
	 * 主路径其实是 `subscribe()` 回调（见 `runOneTurn`）：那里本来就拿着 `sess`，不需要猜
	 * sessionId。这个方法保留给能直接拿到 sessionId 的传输层，两条路径靠 `toolCallId` 去重。
	 */
	onToolEvent(sessionId: string, toolName: string, kind: "start" | "end", args?: Record<string, unknown>, toolCallId?: string): void {
		const sess = this.sessionById(sessionId);
		if (!sess) {
			// 找不到会话是「进度不出现」最常见的成因（sessionId 对不上），得能一眼看出来
			this.deps.log?.("debug", "feishu.progress.unknown_session", { sessionId: sessionId || "(empty)", toolName, kind });
			return;
		}
		if (kind === "end") return;
		this.progress.append(sess, toolName, args, toolCallId);
	}

	/** 优雅关闭：撤回所有进行中的进度消息与处理中表情（SIGTERM 调用）。 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.scheduler.clearWaiting();
		const tasks: Promise<unknown>[] = [];
		for (const [key, sess] of this.sessions) {
			const st = this.progress.get(key);
			if (st?.messageId && this.deps.recallMessage) {
				const messageId = st.messageId;
				st.messageId = undefined;
				// 先 drain 再撤回，避免关闭期间还有迟到写入落到已撤回消息上。
				tasks.push((async () => {
					await this.progress.drain(messageId);
					await this.deps.recallMessage!(messageId);
				})().catch(() => false));
			}
			for (const item of sess.queue) {
				if (item.emojiReactionId && this.deps.reactions) {
					tasks.push(this.deps.reactions.remove(item.messageId, item.emojiReactionId).catch(() => false));
				}
			}
			// 未开始的消息保留在 pending ledger，交给下次启动恢复；关闭期间不得继续消费。
			sess.queue.length = 0;
			const activeItem = this.activeItems.get(key);
			if (activeItem?.emojiReactionId && this.deps.reactions) {
				tasks.push(this.deps.reactions.remove(activeItem.messageId, activeItem.emojiReactionId).catch(() => false));
				activeItem.emojiReactionId = undefined;
			}
			if (sess.agent) {
				const agent = sess.agent;
				sess.agent = undefined;
				sess.sessionId = undefined;
				tasks.push((async () => {
					if (sess.activeRun) {
						try { await agent.abort(); } catch { /* best effort */ }
					}
					try { await agent.dispose(); } catch { /* best effort */ }
				})());
			}
		}
		this.progress.clear();
		await Promise.allSettled(tasks.map((task) => this.settleWithinShutdown(task)));
		await Promise.allSettled(this.scheduler.runningPumps().map((task) => this.settleWithinShutdown(task)));
	}

	private async settleWithinShutdown(task: Promise<unknown>): Promise<void> {
		await boundedWait(task, this.shutdownTimeoutMs);
	}

	/**
	 * 同一条消息被「启动恢复」重复接管的最大次数。超过就停止自动重放：
	 * 一条消息如果每次跑到一半就把进程带走，重放它是无限重启循环 —— 桥梁重启频率比消息本身更糟。
	 */
	private static readonly MAX_AUTO_REPLAYS = 3;

	/** 启动时恢复上次中断的未完成消息（hermes resume_pending）。 */
	async recoverPending(): Promise<number> {
		if (!this.pendingEnabled) return 0;
		const entries = this.pendingStore?.recoverable() ?? [];
		// 命令类消息（never）不会出现在这里：PendingStore.recoverable() 在待处理记录层已排除并清理。
		for (const e of entries) {
			const exhausted = e.replayPolicy !== "manual" && e.attempts > ConversationManager.MAX_AUTO_REPLAYS;
			this.deps.log?.(exhausted ? "error" : "warn", exhausted ? "feishu.conv.recover_pending_exhausted" : "feishu.conv.recover_pending", {
				chatId: e.message.chatId, messageId: e.message.messageId, attempts: e.attempts,
			});
			if (exhausted) {
				const handled = await this.notify(
					e.message.chatId,
					`这条消息已经 ${e.attempts - 1} 次在启动恢复时中断（可能是它触发的任务让进程退出）。为避免反复重启，不再自动重跑；请确认现场后重新发送。`,
					{ replyTo: replyTargetOf(e.message), threadId: e.message.threadId },
					`${e.message.messageId}:recovery-exhausted`,
					e.conversationKey,
					"error",
				);
				if (handled) this.pendingStore?.ack(e.id);
				continue;
			}
			if (e.replayPolicy === "manual") {
				const handled = await this.notify(
					e.message.chatId,
					"上次任务在工具执行期间中断。为避免重复副作用，系统未自动重跑；请确认现场后重新发送任务。",
					{ replyTo: replyTargetOf(e.message), threadId: e.message.threadId },
					`${e.message.messageId}:recovery-manual`,
					e.conversationKey,
					"error",
				);
				// 同时让模型自己也知道"上次中断过" —— 对齐 hermes 的
				// "Do NOT re-execute old tool calls"，避免它从历史里自行
				// 推断并重试旧工具调用（用户看不到这条，它只进模型上下文）。
				this.recoveryNotes.set(e.conversationKey,
					"[系统提示：本会话上次在工具执行期间被中断。不要重新执行对话历史中未完成的工具调用；"
					+ "如果用户要求继续，先确认当前实际状态再决定下一步。]");
				if (handled) this.pendingStore?.ack(e.id);
				continue;
			}
			await this.route({ ...e.message, raw: undefined }, { pendingClaimed: true, conversationKey: e.conversationKey });
		}
		return entries.length;
	}

	private clearPending(item: QueuedMessage): void {
		this.pendingStore?.ack(item.messageId);
	}

	count(): number {
		return this.sessions.size;
	}

	/**
	 * 入站流水线用的持久待处理记录：准入通过即写入，使合并窗口内崩溃可恢复。
	 * 返回 undefined 表示 pending ledger 未启用，调用方需退化为纯内存行为。
	 */
	intakeLedger(): IntakeLedger | undefined {
		const store = this.pendingStore;
		if (!store) return undefined;
		return {
			claim: (msg, conversationKey) => {
				store.claim(msg, conversationKey);
			},
			markNever: (id) => {
				store.markNever(id);
			},
			markAuto: (id) => {
				store.markAuto(id);
			},
			ack: (id) => {
				store.ack(id);
			},
			has: (id) => store.has(id),
			merge: (primaryId, memberIds, merged) => {
				store.mergeInto(
					primaryId,
					memberIds,
					merged as Omit<FeishuInboundMessage, "raw">,
					merged.sourceMessageIds ?? memberIds,
				);
			},
		};
	}

	queueStats(): { queued: number; active: number; waiting: number } {
		return {
			queued: [...this.sessions.values()].reduce((total, session) => total + session.queue.length, 0),
			active: this.scheduler.active,
			waiting: this.scheduler.waiting.length,
		};
	}

	routeForSessionId(sessionId: string): { conversationKey: string; chatId: string; threadId?: string; sourceMessageId?: string; runId?: string; senderId?: string; chatType?: FeishuInboundMessage["chatType"] } | undefined {
		const session = this.sessionById(sessionId);
		if (!session) return undefined;
		const active = this.activeItems.get(session.conversationKey);
		return {
			conversationKey: session.conversationKey,
			chatId: session.chatId,
			threadId: session.threadId,
			// 回复目标而不是 messageId：合成消息（定时任务、按钮）的 id 不是真实飞书消息，挂不上回复
			sourceMessageId: active?.replyTo,
			runId: active?.runId,
			chatType: active?.chatType,
			// 审批免审判定用这个而不是解析 conversationKey（后者在私聊/话题下拿不到用户）
			senderId: active?.senderId,
		};
	}

	/**
	 * 取出 pi 侧还在排队的 steer / followUp 文本（并清空它）。
	 *
	 * 一轮收尾时调用：run 已经结束了，pi 队列里还留着的文本就是**没被执行**的 ——
	 * 调用方据此把这些消息退回桥自己的队列，而不是按「已并入」确认掉（那样消息就丢了）。
	 * 老 SDK 没有 `clearQueue` 时返回 undefined，调用方退化为按 turn 边界判断。
	 */
	/** 常驻内存的条目数（status.json / 诊断用）：实时写入链 + 待处理记录。 */
	cacheSizes(): { liveChains: number; pendingRecords: number } {
		return { liveChains: this.liveChannel?.pendingWrites ?? 0, pendingRecords: this.pendingStore?.depth() ?? 0 };
	}

	drainPiSteerQueue(sess: BridgeSession): string[] | undefined {
		const agent = sess.agent;
		if (!agent?.clearQueue) return undefined;
		try {
			const queue = agent.clearQueue();
			return [...(queue.steering ?? []), ...(queue.followUp ?? [])];
		} catch {
			return undefined;
		}
	}

	/** tool_call hook 在工具真正执行前调用，防止崩溃恢复时重复外部副作用。 */
	markPendingToolBoundary(sessionId: string): void {
		const session = this.sessionById(sessionId);
		if (!session) return;
		const item = this.activeItems.get(session.conversationKey);
		if (item) this.pendingStore?.markManual(item.messageId);
		for (const steered of session.steered) this.pendingStore?.markManual(steered.messageId);
	}

	/**
	 * 路由入站消息：同 chat 串行（排队），跨 chat 并行。
	 * 回复链路：入站 replyToText 注入提示词；出站 send 挂 chat 上一条 bot 消息。
	 */
	async route(
		msg: FeishuInboundMessage,
		options: { pendingClaimed?: boolean; conversationKey?: string; behavior?: "auto" | "queue" | "steer" } = {},
	): Promise<"queued" | "steered" | "rejected"> {
		if (this.shuttingDown) throw new Error("conversation manager is shutting down");
		// 会话 key（对齐 hermes build_session_key）：
		// 1. 话题消息：chatId:t:threadId → 话题独立会话（thread_sessions_per_user=false：
		//    话题内所有参与者共享同一话题会话——B 回复 A 的话题消息复用同一上下文）
		// 2. 群普通消息：默认 chatId（全群共用）；按人隔离的群（groupRules.<id>.sessionsPerUser，没设时看 groupSessionsPerUser）→ chatId:u:senderId
		//    （B 在主聊天发无关联新消息 → B 自己的新会话）
		// 3. 私聊：chatId（p2p chat）
		const key = options.conversationKey ?? buildConversationKey(msg, this.deps.config);
		const sess = this.getOrCreateSession(msg, key);

		const queued: QueuedMessage = {
			runId: randomUUID(),
			chatId: msg.chatId,
			messageId: msg.messageId,
			text: msg.text,
			resources: msg.resources ?? [],
			replyToMessageId: msg.replyToMessageId,
			replyToText: msg.replyToText,
			threadId: msg.threadId,
			...(msg.sourceMessageIds?.length ? { sourceMessageIds: msg.sourceMessageIds } : {}),
			replyTo: replyTargetOf(msg),
			...(msg.synthetic ? { synthetic: true } : {}),
			...(msg.deliverTo ? { deliverTo: msg.deliverTo } : {}),
			senderId: msg.senderId,
			senderName: msg.senderName,
			chatType: msg.chatType,
			mentions: (msg.mentions ?? [])
				.filter((mention) => !mention.isSelf && mention.key !== "@_all")
				.map((mention) => ({ name: mention.name, openId: mention.id?.open_id })),
			atAll: (msg.mentions ?? []).some((mention) => mention.key === "@_all"),
		};
		if (sess.queue.length >= MAX_QUEUE) {
			this.deps.log?.("warn", "feishu.conv.queue_full", { chatId: key });
			await this.notify(msg.chatId, "消息过多，当前队列已满，请稍后再试。", {
				replyTo: replyTargetOf(msg),
				threadId: msg.threadId,
			}, `${msg.messageId}:queue-full`, key);
			// 流水线已在准入后提前登记；明确拒绝时清除该记录，避免重启后重放被拒消息。
			this.pendingStore?.ack(msg.messageId);
			return "rejected";
		}
		// 本群今日预算用尽 → 拒绝新任务（已经在跑的不打断；恢复重放的不拦）
		if (!options.pendingClaimed) {
			const { spent, limit } = this.budgetStatus(msg.chatId);
			if (budgetState(spent, limit) === "exceeded") {
				this.deps.log?.("warn", "feishu.conv.budget_exceeded", { chatId: msg.chatId, spent, limit });
				await this.notify(msg.chatId, `本群今日费用已达上限（$${spent.toFixed(2)} / $${limit}），新任务暂停到明天。管理员可用 /feishu budget 调整。`, {
					replyTo: replyTargetOf(msg), threadId: msg.threadId,
				}, `${msg.messageId}:budget`, key);
				this.pendingStore?.ack(msg.messageId);
				return "rejected";
			}
		}
		if (!options.pendingClaimed) this.pendingStore?.claim(msg, key);
		// 处理中表情（hermes 式）：确认可入队后添加，runOne 结束后撤回
		if (this.deps.config.reaction.enabled && this.deps.reactions && !msg.synthetic) {
			try {
				const reactionId = await this.deps.reactions.add(msg.messageId, this.deps.config.reaction.processingEmoji);
				queued.reactionId = msg.messageId;
				queued.emojiReactionId = reactionId ?? "";
			} catch { /* reaction 失败不影响已持久登记的消息 */ }
		}
		if (options.behavior !== "queue" && await this.trySteer(sess, queued)) {
			await this.markSteered(sess, queued);
			// /steer 命令自己有回执；普通消息在工具执行中会被压到这一步结束，先告诉用户
			if (options.behavior !== "steer") await this.noticeBusy(sess, queued);
			return "steered";
		}

		const wasBusy = sess.activeRun;
		sess.queue.push(queued);
		if (!sess.activeRun) {
			sess.activeRun = true;
			this.scheduler.schedule(sess);
		}
		// 普通消息没能并入（例如当前 run 已过注入点）而进了队列 → 告诉用户排在第几
		// （/queue 命令自己有回执；恢复重放的不提示）
		if (wasBusy && options.behavior !== "queue" && !options.pendingClaimed) await this.noticeQueued(sess, queued);
		return "queued";
	}

	/** 普通忙碌消息与 /steer 都优先注入当前 Pi run；空闲时退化为普通新 turn。 */
	async steerConversation(msg: FeishuInboundMessage): Promise<"queued" | "steered" | "rejected"> {
		return this.route(msg, { behavior: "steer" });
	}

	/** /queue 始终排成独立完整 turn，不受忙碌时默认 steer 行为影响。 */
	async queueConversation(msg: FeishuInboundMessage): Promise<"queued" | "rejected"> {
		const result = await this.route(msg, { behavior: "queue" });
		return result === "rejected" ? "rejected" : "queued";
	}

	private async prepareAgentInput(item: QueuedMessage, conversationKey: string): Promise<{
		text: string;
		images?: import("../types.js").PiImageContent[];
		resources?: ResolvedTurnResources;
	}> {
		const session = this.sessions.get(conversationKey);
		const recoveryNote = this.recoveryNotes.get(conversationKey);
		const built = await buildTurnInput({
			item, conversationKey, session, recoveryNote,
			deps: {
				config: this.deps.config,
				resourceResolver: this.deps.resourceResolver,
				lastSent: this.deps.lastSent,
				resolveUserName: this.deps.resolveUserName,
				sentFooters: this.sentFooters,
			},
		});
		// 群设定提示注入一次之后记在会话上，后续轮次不再加
		if (built.promptInjected !== undefined && session) session.promptInjected = built.promptInjected;
		if (recoveryNote) this.recoveryNotes.delete(conversationKey);
		return { text: built.text, images: built.images, resources: built.resources };
	}

	/**
	 * 按群限制可用工具（`groupRules.<chatId>.tools`）。会话创建时生效。
	 * 与审批是两层独立防线：不在白名单里的工具模型根本看不到（系统提示也随之重建）。
	 * 只取与实际注册工具的交集 —— 写错名字不会凭空"开启"什么，也不会报错。
	 */
	private applyToolPolicy(session: BridgeSession, agent: AgentHandle): void {
		const policy = this.toolPolicyOf(session.chatId);
		if (!policy || policy === "full" || !agent.setActiveTools) return;
		const all = agent.allToolNames?.() ?? agent.activeToolNames?.() ?? [];
		const wanted = resolveToolPolicy(policy, all);
		try {
			agent.setActiveTools(wanted);
			this.deps.log?.("info", "feishu.conv.tool_policy", { conversationKey: session.conversationKey, policy: Array.isArray(policy) ? "custom" : policy, tools: wanted });
		} catch (error) {
			this.deps.log?.("warn", "feishu.conv.tool_policy_failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** 生效的工具档位（云文档评论的虚拟会话缺省只读：评论区没有审批卡可点）。 */
	private toolPolicyOf(chatId: string): string[] | "readonly" | "standard" | "full" | undefined {
		if (chatId.startsWith(EXTERNAL_CHAT_PREFIX)) return this.deps.config.docComments?.tools ?? "readonly";
		return this.deps.config.groupRules?.[chatId]?.tools;
	}

	/** 当前会话的工具档位（`/feishu status` 展示）。 */
	toolPolicyFor(chatId: string): string {
		const policy = this.toolPolicyOf(chatId);
		if (!policy) return "full（未限制）";
		return Array.isArray(policy) ? `自定义：${policy.join(", ")}` : policy;
	}

	/**
	 * 标记会话的 run 有活动（收到任意 agent 事件时调用），重置空闲计时器。
	 * 对齐 hermes 的做法：不做固定总时长超时（跑长测试是正常的），
	 * 只在「完全无产出」时判定卡死。
	 */
	touchRunActivity(sess: BridgeSession): void {
		if (!sess.runIdleReject) return;
		if (sess.runIdleTimer) { clearTimeout(sess.runIdleTimer); sess.runIdleTimer = undefined; }
		// 分两段：工具执行中（构建、跑测试长时间没输出很正常）用更长的时限，等模型时用短的
		const tool = sess.run?.current();
		const limit = tool ? this.runToolIdleTimeoutMs : this.runIdleTimeoutMs;
		if (limit <= 0) return;
		sess.runIdleTimer = setTimeout(() => {
			const now = this.now();
			sess.runIdleInfo = { phase: tool ? "tool" : "model", ...(tool ? { tool: tool.name } : {}), idleMs: limit };
			this.deps.log?.("warn", "feishu.conv.run_idle_timeout", {
				chatId: sess.chatId, conversationKey: sess.conversationKey, idleMs: limit, phase: tool ? "tool" : "model",
				...(tool ? { tool: tool.name, toolMs: now - tool.startedAt } : {}),
				...(sess.run ? { runMs: now - sess.run.startedAt, toolCalls: sess.run.toolCalls } : {}),
			});
			sess.runIdleReject?.(new Error("run idle timeout"));
		}, limit);
		sess.runIdleTimer.unref?.();
	}

	/**
	 * Pi 的 agent_settled 信号：本轮彻底结束（不会再有 retry / compaction / follow-up）。
	 * 比 turn_end / agent_end 更准确 —— 官方文档明确 agent_end 之后 Pi 仍可能继续。
	 * 记录到活动项上，供收尾逻辑与诊断使用。
	 */
	markSettled(sessionId: string): void {
		const session = this.sessionById(sessionId);
		if (!session) return;
		const item = this.activeItems.get(session.conversationKey);
		if (item) item.settled = true;
	}

	/** 无 durable outbox 时的直发通知（工具反馈里会标明「已投递」而非「已排队」）。 */
	async notifyNow(chatId: string, text: string, opts: { replyTo?: string; threadId?: string }, dedupeKey: string): Promise<{ success: boolean; error?: string }> {
		const res = await this.deps.sender.send(chatId, text, opts);
		this.deps.log?.("info", "feishu.conv.notify_sent", { chatId, dedupeKey, success: res.success });
		return { success: res.success, error: res.error };
	}

	/** 启动空闲回收巡检（幂等）。 */
	startLifecycle(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => { void this.reclaimIdle(); }, this.sweepIntervalMs);
		this.sweepTimer.unref?.();
	}

	stopLifecycle(): void {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = undefined;
	}

	/**
	 * 回收空闲会话句柄（不删除 Pi 历史、pending 或 outbox）。
	 * 可回收条件：无 active run、无排队/steer、无未决审批、不在初始化中，且空闲超 TTL。
	 * 超过驻留上限时按 LRU 再回收一批（与 maxActiveSessions 的并发上限语义分开）。
	 */
	async reclaimIdle(now: number = this.now()): Promise<number> {
		let reclaimed = 0;
		for (const [key, session] of [...this.sessions]) {
			if (!this.canReclaim(key, session, now)) continue;
			await this.retireSession(key, session);
			reclaimed += 1;
		}
		// 驻留上限：仍超限则按最近活动时间升序回收（不触碰不可回收者）
		if (this.sessions.size > this.maxResidentSessions) {
			const candidates = [...this.sessions.entries()]
				.filter(([key, session]) => this.canReclaim(key, session, Number.POSITIVE_INFINITY))
				.sort((a, b) => (a[1].lastActivityAt ?? a[1].createdAt) - (b[1].lastActivityAt ?? b[1].createdAt));
			for (const [key, session] of candidates) {
				if (this.sessions.size <= this.maxResidentSessions) break;
				await this.retireSession(key, session);
				reclaimed += 1;
			}
		}
		return reclaimed;
	}

	/** 预算快照（status/doctor 展示限流冷却）。 */
	budgetSnapshot() {
		return this.rateBudget.snapshot();
	}

	/** 冷却提示文案（无冷却时返回 undefined）。 */
	budgetCooldownNotice(): string | undefined {
		return this.rateBudget.cooldownNotice();
	}

	/** 把 API 结果反馈给预算（限频/网络失败累计触发冷却）。 */
	recordApiOutcome(outcome: { errorClass?: string; retryAfterMs?: number; ok?: boolean }): void {
		this.rateBudget.record(outcome);
	}

	/** 当前驻留会话数（诊断用）。 */
	residentCount(): number {
		return this.sessions.size;
	}

	private canReclaim(key: string, session: BridgeSession, now: number): boolean {
		if (!this.isQuiet(key, session)) return false;
		const idleSince = session.lastActivityAt ?? session.createdAt;
		return now - idleSince >= this.idleTtlMs;
	}

	/** 没有在跑、排队、待审批的事，释放句柄不影响任何进行中的工作。 */
	private isQuiet(key: string, session: BridgeSession): boolean {
		if (session.activeRun || session.creatingAgent) return false;
		if (session.queue.length > 0 || session.steered.length > 0) return false;
		if (this.activeItems.has(key)) return false;
		return (this.deps.pendingApprovalCount?.(key) ?? 0) === 0;
	}

	/**
	 * 会话模式变了的会话（群共享 `<chatId>` 和群里各人的 `<chatId>:u:*`）不等空闲超时，现在就释放句柄。
	 *
	 * 某人的个人会话 `/resume` 进群后，群指针和他的个人指针是同一个文件、同一个 session id；
	 * 切换模式后旧句柄还驻留时，按 session id 转发的工具事件和审批会落到旧会话上。
	 * 有工作在进行的不动，返回它们的键。私聊的键也是 `<chatId>`，释放空闲句柄对它无害（等同提前回收）。
	 */
	async releaseSessionsForChats(changed: (chatId: string) => boolean): Promise<{ released: string[]; busy: string[] }> {
		const released: string[] = [];
		const busy: string[] = [];
		for (const [key, session] of [...this.sessions]) {
			if (key !== session.chatId && !key.startsWith(`${session.chatId}:u:`)) continue;
			if (!changed(session.chatId)) continue;
			if (!this.isQuiet(key, session)) {
				busy.push(key);
				continue;
			}
			await this.retireSession(key, session);
			released.push(key);
		}
		return { released, busy };
	}

	/** 回收单个会话句柄：先从索引移除，再（有界等待）dispose，失败只记日志。 */
	private async retireSession(key: string, session: BridgeSession): Promise<void> {
		this.sessions.delete(key);
		this.liveChannel?.discard(key);
		const agent = session.agent;
		session.agent = undefined;
		session.sessionId = undefined;
		if (!agent) return;
		await boundedWait(agent.dispose(), 3_000);
		this.deps.log?.("info", "feishu.conv.session_reclaimed", {
			conversationKey: key,
			resident: this.sessions.size,
		});
	}

	/**
	 * final 页脚（配置关闭时返回空串）。
	 *
	 * 上下文占用取自 SDK 会话统计（拿不到就不显示该段）：不能用 run 指标里的 token
	 * 加总代替 —— 那个是「本轮花了多少」，上下文是「当前窗口占了多少」，压缩后两者
	 * 会差一个数量级。
	 */
	private footerFor(metrics: ReturnType<typeof createRunMetrics>, sess: BridgeSession): string {
		const footerCfg = this.deps.config.footer;
		// 群级开关优先（管理员可用 /feishu footer off 当场关掉本群页脚）
		if (!resolveFooterEnabled(this.deps.config, sess.chatId).enabled) return "";
		try {
			const stats = footerCfg.showSession === false ? undefined : sessionUsageStats(sess.agent);
			return renderFooter(metrics, {
				elapsedMs: metricsElapsedMs(metrics),
				// 模型优先用会话当下的（本轮没收到 usage 事件时 metrics.model 是空的）
				model: metrics.model ?? sess.agent?.modelId,
				showCost: footerCfg.showCost !== false,
				showCny: footerCfg.showCny !== false,
				cnyPerUsd: (this.deps.cnyPerUsd ?? cnyPerUsdForModel)(metrics.model ?? sess.agent?.modelId),
				context: footerCfg.showContext === false ? undefined : stats?.contextUsage,
				...(stats
					? { session: { ...(stats.tokens ? { tokens: stats.tokens } : {}), ...(typeof stats.cost === "number" ? { cost: stats.cost } : {}) } }
					: {}),
			});
		} catch {
			return "";
		}
	}

	/**
	 * `/feishu usage` 的数据源 —— 会话累计（SDK 统计）+ 本轮 run 指标。
	 *
	 * 不新建会话：没有会话就是没有用量，回 null 让命令层告诉用户去发条消息。
	 */
	usageSnapshot(msg: FeishuInboundMessage): UsageSnapshot | undefined {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.sessions.get(key);
		if (!session) return undefined;
		const stats = sessionUsageStats(session.agent);
		const modelLabel = session.agent?.modelId;
		return {
			...(modelLabel ? { modelLabel } : {}),
			...(stats ? { session: stats } : {}),
			...(session.lastRun ? { run: session.lastRun } : {}),
		};
	}

	/**
	 * 最近发出的文本页脚原文（FIFO，上限 50 条）。
	 *
	 * 为什么记：引用回复时要把页脚从注入的引用块里去掉。单靠行形态判断是"超集"，
	 * 有极小概率误删正文；先按注册表做整段后缀精确匹配，就能做到"确定删掉我们写进去的那段"。
	 * 进程重启后为空 → 退化成行形态判断，仍然能删干净。
	 */
	private readonly sentFooters: string[] = [];

	private rememberSentFooter(footer: string): void {
		const text = footer.trim();
		if (!text) return;
		const existing = this.sentFooters.indexOf(text);
		if (existing >= 0) this.sentFooters.splice(existing, 1);
		this.sentFooters.push(text);
		if (this.sentFooters.length > 50) this.sentFooters.shift();
	}

	private async trySteer(sess: BridgeSession, item: QueuedMessage): Promise<boolean> {
		const agent = sess.agent;
		if (!sess.activeRun || !agent?.steer || !this.activeItems.has(sess.conversationKey)) return false;
		sess.steered.push(item);
		let prepared: Awaited<ReturnType<ConversationManager["prepareAgentInput"]>> | undefined;
		let accepted = false;
		try {
			prepared = await this.prepareAgentInput(item, sess.conversationKey);
			if (!sess.activeRun || sess.agent !== agent || !this.activeItems.has(sess.conversationKey)) return false;
			// 注入点要**在 await 之前**取：await 期间可能已经结束了一个 turn，
			// 取晚了下标偏大，收尾时就分不清「这条被消费了」还是「压根没排上」。
			item.steeredAtTurnEnds = sess.run?.turnEnds ?? 0;
			item.steerText = prepared.text;
			await agent.steer(prepared.text, prepared.images);
			accepted = true;
			this.deps.log?.("info", "feishu.conv.steered", {
				messageId: item.messageId, conversationKey: sess.conversationKey, runId: item.runId,
			});
			return true;
		} catch (error) {
			this.deps.log?.("warn", "feishu.conv.steer_fallback_queue", {
				messageId: item.messageId,
				conversationKey: sess.conversationKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			try { prepared?.resources?.cleanup(); } catch { /* best effort */ }
			if (!accepted) {
				const index = sess.steered.indexOf(item);
				if (index >= 0) sess.steered.splice(index, 1);
			}
		}
	}

	/**
	 * /new：切换到新会话：
	 * - 有执行中/排队任务时默认拒绝（不静默丢弃队列），force 才取消；
	 * - 先原子落盘新指针，再切运行态（避免“运行态已切、重启又回退到旧会话”）；
	 * - 指针写失败则不切换并报错，不得静默继续用旧会话。
	 */
	async resetConversation(msg: FeishuInboundMessage, options: { force?: boolean } = {}): Promise<ResetOutcome> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.sessions.get(key);
		const pending = (session?.queue.length ?? 0)
			+ (session?.steered.length ?? 0)
			+ (this.activeItems.has(key) ? 1 : 0);
		if (pending > 0 && !options.force) return { status: "busy", pending };

		const previous = this.conversationStore?.get(key);
		const previousName = session?.agent?.sessionName?.();
		const generation = (previous?.generation ?? 0) + 1;
		const base = key.replace(/[^a-zA-Z0-9_-]/g, "_");
		const sessionFile = join(this.deps.sessionDir, `${base}-${randomUUID()}.jsonl`);

		// ① 先落盘新指针：失败则不切换（否则重启会回退到旧会话）。
		if (this.conversationStore) {
			try {
				this.conversationStore.set({ conversationKey: key, sessionFile, generation });
			} catch (error) {
				this.deps.log?.("error", "feishu.conv.pointer_write_failed", {
					conversationKey: key,
					error: error instanceof Error ? error.message : String(error),
				});
				return { status: "error", reason: "会话指针写入失败" };
			}
		} else {
			// 未配置持久指针时退化为进程内的后缀（重启后仍会回退，已由日志可见）。
			this.nextSessionSuffix.set(key, `-${randomUUID()}`);
		}

		// ② force 路径：取消执行/排队中的任务，并为每条落终态（从 ledger 移除）。
		const cancelled = [...(session?.queue ?? []), ...(session?.steered ?? [])];
		if (session) {
			session.queue.length = 0;
			session.steered.length = 0;
		}
		for (const item of cancelled) this.clearPending(item);

		// ③ 切运行态。
		this.sessions.delete(key);
		this.liveChannel?.discard(key);
		if (session?.agent) {
			if (session.activeRun) { try { await session.agent.abort(); } catch { /* best effort */ } }
			try { await session.agent.dispose(); } catch { /* best effort */ }
			session.agent = undefined;
		}
		// ④ 会话重置后旧审批卡一律失效（不携带 runId → 按会话全量撤销）。
		this.deps.onApprovalInvalidate?.({ conversationKey: key, reason: "reset" });
		return {
			status: "reset", generation, cancelled: cancelled.length,
			...(previousName ? { previousName } : {}),
			hadPrevious: Boolean(previous && this.conversationStore && existsSync(previous.sessionFile)),
		};
	}

	async stopConversation(msg: FeishuInboundMessage): Promise<boolean> {
		const session = this.sessions.get(buildConversationKey(msg, this.deps.config));
		// 直接执行的命令也能 /stop
		if (session?.bashRunning && session.agent?.abortBash) {
			session.agent.abortBash();
			return true;
		}
		if (!session?.agent || !session.activeRun) return false;
		session.stopRequested = true;
		await session.agent.abort();
		return true;
	}

	async compactConversation(msg: FeishuInboundMessage, instructions?: string): Promise<string> {
		const session = this.sessions.get(buildConversationKey(msg, this.deps.config));
		if (!session?.agent) return "当前会话尚未建立";
		if (session.activeRun) return "当前会话仍在执行，请稍后压缩";
		if (!session.agent.compact) return "当前 Pi 版本不支持远程压缩";
		return session.agent.compact(instructions);
	}

	/**
	 * `/reload`：重新加载当前会话的扩展、技能、提示模板和上下文文件，对话历史不变。
	 * pi 重建运行时会把扩展工具全部重新启用，所以之后要再套一遍按群工具档位。
	 */
	async reloadConversation(msg: FeishuInboundMessage): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.sessions.get(key);
		if (!session?.agent) return "当前会话还没有加载，下一条消息会直接用上最新的技能和扩展";
		const busy = this.busyReason(key);
		if (busy) return busy;
		const agent = session.agent;
		if (!agent.reload) return "当前 Pi 版本不支持重新加载";
		let summary: ReloadSummary;
		try {
			summary = await agent.reload();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log?.("warn", "feishu.conv.reload_failed", { conversationKey: key, error: message });
			return `重新加载失败：${message}`;
		}
		this.applyToolPolicy(session, agent);
		this.deps.log?.("info", "feishu.conv.reloaded", {
			conversationKey: key, extensions: summary.extensions, skills: summary.skills.length,
			prompts: summary.prompts, problems: summary.problems.length,
		});
		return formatReloadSummary(summary);
	}

	/** 审批卡上的上下文（发起人 · 会话名 · 工作区）；拿不到的部分省略。 */
	async approvalContextLine(conversationKey: string): Promise<string | undefined> {
		const session = this.sessions.get(conversationKey);
		const item = this.activeItems.get(conversationKey);
		const parts: string[] = [];
		if (item?.senderId) {
			const name = item.senderName ?? await this.deps.resolveUserName?.(item.senderId).catch(() => undefined);
			parts.push(`发起人：${name ?? `…${item.senderId.slice(-4)}`}`);
		}
		const sessionName = session?.agent?.sessionName?.();
		if (sessionName) parts.push(`会话：${sessionName}`);
		if (session?.workspaceAlias) parts.push(`工作区：${session.workspaceAlias}`);
		return parts.length ? parts.join(" · ") : undefined;
	}

	/** 被会话指针引用的文件（当前 + 历史，不参与归档）。 */
	referencedSessionFiles(): Set<string> {
		const files = new Set<string>();
		for (const pointer of this.conversationStore?.list() ?? []) {
			files.add(pointer.sessionFile);
			for (const entry of pointer.history ?? []) files.add(entry.sessionFile);
		}
		for (const session of this.sessions.values()) files.add(session.sessionFile);
		return files;
	}

	// ------------------------------------------------------------ 队列 ----

	/** 队列快照（/queue list）。只给预览，不回显全文。 */
	queueSnapshot(msg: FeishuInboundMessage): { active?: string; queued: string[]; steered: number } {
		const key = buildConversationKey(msg, this.deps.config);
		const sess = this.sessions.get(key);
		const active = this.activeItems.get(key);
		return {
			...(active ? { active: previewText(active.text) } : {}),
			queued: (sess?.queue ?? []).map((item) => previewText(item.text)),
			steered: sess?.steered.length ?? 0,
		};
	}

	/**
	 * 清空排队（/queue clear）。正在执行的任务不受影响（要停它用 /stop）；
	 * 被清掉的消息在待处理记录里落终态（重启不重放）并撤掉处理中表情。
	 */
	async clearQueued(msg: FeishuInboundMessage): Promise<number> {
		const sess = this.sessions.get(buildConversationKey(msg, this.deps.config));
		if (!sess) return 0;
		const removed = sess.queue.splice(0);
		for (const item of removed) {
			this.clearPending(item);
			await this.removeProcessingReaction(sess, item);
		}
		this.deps.log?.("info", "feishu.conv.queue_cleared", { conversationKey: sess.conversationKey, removed: removed.length });
		return removed.length;
	}

	/** 并入当前任务的消息换成"已并入"表情（与"处理中"区分开）。 */
	private async markSteered(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		const emoji = this.deps.config.reaction?.steerEmoji;
		if (!emoji || !this.deps.config.reaction?.enabled || !this.deps.reactions) return;
		await this.removeProcessingReaction(sess, item);
		if (item.synthetic) return;
		// 记下 id：这一轮结束时和「处理中」一样撤掉，换成完成 / 失败表情
		try { item.emojiReactionId = await this.deps.reactions.add(item.messageId, emoji) ?? ""; } catch { /* 表情失败不影响注入 */ }
	}

	/**
	 * 工具执行了一阵（≥ 1 分钟）时收到普通消息：它要等这一步结束才交给模型，先回一句正在做什么（同一会话 5 分钟内只提示一次）。
	 * 不提示的情况：在等模型（消息很快就会被处理）、合成消息（卡片点击等）、关了 queueNotice。
	 */
	private async noticeBusy(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		if (this.deps.config.queueNotice === false || item.synthetic || !sess.run) return;
		const now = this.now();
		const tool = sess.run.current();
		if (!tool || now - tool.startedAt < 60_000) return;
		if (sess.lastBusyNoticeAt && now - sess.lastBusyNoticeAt < 5 * 60_000) return;
		const text = busyNoticeText(sess.run, now);
		if (!text) return;
		sess.lastBusyNoticeAt = now;
		await this.notify(item.chatId, text, { replyTo: item.replyTo, threadId: item.threadId }, `${item.messageId}:busy`, sess.conversationKey);
	}

	/**
	 * `/progress`：不经过模型，直接报告这一轮做到哪了。自己的会话空闲时，列出同一个群里别人正在执行的任务
	 * （只给人和时长，不给命令内容：群里各人会话独立时那是别人的任务）。
	 */
	progressReport(msg: FeishuInboundMessage): string {
		const key = buildConversationKey(msg, this.deps.config);
		const own = this.sessions.get(key);
		const now = this.now();
		if (own?.run && this.activeItems.has(key)) {
			return describeProgress({ activity: own.run, now, task: this.activeItems.get(key)?.text, steered: own.steered.length, queued: own.queue.length });
		}
		const lines = [own?.queue.length ? `当前没有执行中的任务，排队 ${own.queue.length} 个` : "当前没有执行中的任务"];
		const others = [...this.sessions.values()].filter((session) => session !== own && session.chatId === msg.chatId && session.run && this.activeItems.has(session.conversationKey));
		if (others.length > 0) {
			lines.push(`这个群里另有 ${others.length} 个任务在执行：`);
			for (const other of others.slice(0, 5)) {
				const activity = other.run as RunActivity;
				const who = this.activeItems.get(other.conversationKey)?.senderName ?? "其他成员";
				lines.push(`· ${who}：已运行 ${durationLabel(now - activity.startedAt)}，${activity.inTool ? "正在执行工具" : "在等模型回复"}`);
			}
		}
		return lines.join("\n");
	}

	/** 忙碌时排队的消息回复一次"已排队，第 N 个"（同一会话 10 秒内只提示一次）。 */
	private async noticeQueued(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		if (this.deps.config.queueNotice === false) return;
		const now = this.now();
		if (sess.lastQueueNoticeAt && now - sess.lastQueueNoticeAt < 10_000) return;
		sess.lastQueueNoticeAt = now;
		const position = sess.queue.indexOf(item) + 1;
		await this.notify(item.chatId, queuedNoticeText(position), {
			replyTo: item.replyTo, threadId: item.threadId,
		}, `${item.messageId}:queued`, sess.conversationKey);
	}

	// ------------------------------------------------------------ 模型 ----

	// ------------------------------------------------------------ 重试/回退/分叉 ----

	/** 会话里未完成的工作量（排队 + 已并入 + 执行中）—— "是否忙碌"的唯一算法。 */
	private pendingWork(key: string): number {
		const session = this.sessions.get(key);
		return (session?.queue.length ?? 0) + (session?.steered.length ?? 0) + (this.activeItems.has(key) ? 1 : 0);
	}

	/** 有执行中或排队的任务时返回拒绝文案（/retry、/undo、/fork 这类改历史的操作必须在空闲时做）。 */
	private busyReason(key: string): string | undefined {
		const session = this.sessions.get(key);
		const pending = this.pendingWork(key);
		if (session?.activeRun || session?.bashRunning || pending > 0) return "当前会话仍在执行或有排队任务，请先 /stop 或等待完成";
		return undefined;
	}

	private async idleAgent(msg: FeishuInboundMessage): Promise<{ key: string; session: BridgeSession; agent: AgentHandle } | string> {
		const key = buildConversationKey(msg, this.deps.config);
		const busy = this.busyReason(key);
		if (busy) return busy;
		const session = this.getOrCreateSession(msg, key);
		try {
			return { key, session, agent: await this.ensureAgentSession(session) };
		} catch {
			return "会话初始化失败，请稍后重试";
		}
	}

	// 改历史的命令（/undo /retry /fork /export）搬到了 history-ops：这里只做转发，
	// 管理器的主干留给「一轮怎么跑」。

	/** 撤销最近一轮（只回退对话；原分支仍在会话文件里）。 */
	async undoConversation(msg: FeishuInboundMessage): Promise<string> {
		return this.history.undo(msg);
	}

	/** 用同一条消息重新生成上一轮（常用于换模型/思考等级后再试）。 */
	async retryConversation(msg: FeishuInboundMessage): Promise<string> {
		return this.history.retry(msg);
	}

	/** `/fork list` 的数据（第 N 条用户消息预览）。 */
	async forkCandidates(msg: FeishuInboundMessage): Promise<string> {
		return this.history.forkCandidates(msg);
	}

	/** 分叉：无参复制当前会话；`#N` 从第 N 条之前分叉。 */
	async forkConversation(msg: FeishuInboundMessage, selector?: string): Promise<string> {
		return this.history.fork(msg, selector);
	}

	/** 导出当前会话为文件并经持久 outbox 发回本会话。 */
	async exportConversation(msg: FeishuInboundMessage, format: "html" | "md" | "summary"): Promise<string> {
		return this.history.export(msg, format);
	}

	// ------------------------------------------------------------ 撤回取消 ----

	/**
	 * 用户撤回消息 → 取消对应任务。排队中的直接移除；正在执行的只 abort 本轮（同 /stop），
	 * 不影响后面的任务；已经注入当前任务的无法单独撤回；已完成的不处理。
	 */
	async cancelByMessageId(messageId: string): Promise<{
		status: "none" | "dequeued" | "aborted" | "steered";
		chatId?: string; threadId?: string; conversationKey?: string; sideEffects?: boolean;
	}> {
		const matches = (item: QueuedMessage) => item.messageId === messageId || (item.sourceMessageIds?.includes(messageId) ?? false);
		for (const sess of this.sessions.values()) {
			const base = { chatId: sess.chatId, threadId: sess.threadId, conversationKey: sess.conversationKey };
			const index = sess.queue.findIndex(matches);
			if (index >= 0) {
				const [item] = sess.queue.splice(index, 1);
				this.clearPending(item);
				await this.removeProcessingReaction(sess, item);
				this.deps.log?.("info", "feishu.conv.recall_dequeued", { messageId, conversationKey: sess.conversationKey });
				return { status: "dequeued", ...base };
			}
			const active = this.activeItems.get(sess.conversationKey);
			if (active && matches(active) && sess.agent && sess.activeRun) {
				const sideEffects = (this.progress.get(sess.conversationKey)?.lines.length ?? 0) > 0;
				sess.stopRequested = true;
				try { await sess.agent.abort(); } catch { /* best effort */ }
				this.deps.log?.("info", "feishu.conv.recall_aborted", { messageId, conversationKey: sess.conversationKey, sideEffects });
				return { status: "aborted", ...base, sideEffects };
			}
			if (sess.steered.some(matches)) return { status: "steered", ...base };
		}
		return { status: "none" };
	}

	// ------------------------------------------------------------ 直接执行 ----

	/** 直接执行命令（不经过模型；结果记入会话，模型后续能看到）。权限与分级由调用方负责。 */
	async runDirectBash(msg: FeishuInboundMessage, command: string, timeoutMs: number): Promise<
		{ ok: false; reason: string } | { ok: true; output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; timedOut: boolean }
	> {
		const ready = await this.idleAgent(msg);
		if (typeof ready === "string") return { ok: false, reason: ready };
		const { session, agent } = ready;
		if (!agent.executeBash) return { ok: false, reason: "当前 Pi 版本不支持直接执行命令" };
		session.bashRunning = true;
		session.lastActivityAt = this.now();
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; agent.abortBash?.(); }, Math.max(1_000, timeoutMs));
		timer.unref?.();
		try {
			const result = await agent.executeBash(command);
			return { ok: true, output: result.output, exitCode: result.exitCode, cancelled: result.cancelled, truncated: result.truncated, timedOut };
		} catch (error) {
			return { ok: false, reason: `执行失败：${error instanceof Error ? error.message.slice(0, 160) : "未知错误"}` };
		} finally {
			clearTimeout(timer);
			session.bashRunning = false;
		}
	}

	// ------------------------------------------------------------ 预算 ----

	/** 本群今天已用（USD）与上限。 */
	budgetStatus(chatId: string): { spent: number; limit?: number } {
		const limit = this.deps.config.groupRules?.[chatId]?.dailyBudgetUsd;
		return { spent: this.deps.usageLedger?.costToday(chatId) ?? 0, ...(limit ? { limit } : {}) };
	}

	/** run 结束记账；首次越过 80% 时提醒一次（按群按天）。 */
	private async recordRunUsage(sess: BridgeSession, item: QueuedMessage, metrics: ReturnType<typeof createRunMetrics>): Promise<void> {
		const ledger = this.deps.usageLedger;
		const usage = metrics.usage;
		if (!ledger || usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return;
		const record = ledger.record({
			chatId: item.chatId, conversationKey: sess.conversationKey, senderId: item.senderId,
			...(metrics.model ? { model: metrics.model } : {}),
			input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
			cost: metrics.hasCost ? metrics.cost : 0,
		});
		const { spent, limit } = this.budgetStatus(item.chatId);
		const state = budgetState(spent, limit);
		if (state === "ok" || !limit) return;
		const marker = `${item.chatId}:${record.date}:${state}`;
		if (this.budgetNotices.has(marker)) return;
		this.budgetNotices.add(marker);
		const text = state === "exceeded"
			? `⚠️ 本群今日费用已达上限（$${spent.toFixed(2)} / $${limit}），新任务将暂停到明天。管理员可用 /feishu budget 调整。`
			: `提醒：本群今日费用已用 ${Math.round((spent / limit) * 100)}%（$${spent.toFixed(2)} / $${limit}）。`;
		await this.notify(item.chatId, text, { threadId: item.threadId }, `budget:${marker}`, sess.conversationKey);
	}

	private getOrCreateSession(msg: FeishuInboundMessage, key: string): BridgeSession {
		const existing = this.sessions.get(key);
		if (existing) return existing;
		// 恢复该会话的工作区（别名 → realpath）；没切换过的会话用 workspaces.default；
		// 别名已被删除或目录不可用时退回进程启动目录
		const storedWorkspace = this.conversationStore?.get(key)?.workspace;
		const effectiveWorkspace = this.workspaceAliasByKey.get(key) ?? storedWorkspace ?? this.deps.config.workspaces?.default;
		const workspaceResolved = effectiveWorkspace ? this.commands.resolveWorkspace(effectiveWorkspace) : undefined;
		const session: BridgeSession = {
			...(workspaceResolved?.ok ? { workspaceAlias: effectiveWorkspace, workspacePath: workspaceResolved.path } : {}),
			conversationKey: key,
			chatId: msg.chatId,
			threadId: msg.threadId,
			sessionFile: resolveSessionFile(
				this.deps.sessionDir,
				key,
				this.nextSessionSuffix.get(key),
				this.conversationStore?.get(key),
				this.conversationStore,
				this.deps.log,
			),
			queue: [],
			steered: [],
			activeRun: false,
			createdAt: this.now(),
		};
		this.sessions.set(key, session);
		return session;
	}

	private async ensureAgentSession(session: BridgeSession): Promise<AgentHandle> {
		if (session.agent) return session.agent;
		if (!session.creatingAgent) {
			session.creatingAgent = this.deps.sessionBackend.createSession({
				chatId: session.chatId,
				conversationKey: session.conversationKey,
				sessionFile: session.sessionFile,
				// 按会话工作区传 cwd（未设置时不传，保持进程默认）
				...(session.workspacePath ? { cwd: session.workspacePath } : {}),
			}).then(async (agent) => {
				if (this.shuttingDown || this.sessions.get(session.conversationKey) !== session) {
					try { await agent.dispose(); } catch { /* best effort */ }
					throw new Error("conversation session was reset during initialization");
				}
				session.agent = agent;
				session.sessionId = agent.sessionId;
				// 新会话句柄 → 群设定需要重新注入一次
				session.promptInjected = undefined;
				this.applyToolPolicy(session, agent);
				return agent;
			}).finally(() => {
				session.creatingAgent = undefined;
			});
		}
		return session.creatingAgent;
	}

	/** 调度等待量诊断（waiting 会话数 + 各会话排队与等待时长）。 */
	schedulerSnapshot(): { waiting: number; queues: Array<{ conversationKey: string; queued: number; active: boolean }> } {
		return {
			waiting: this.scheduler.waiting.length,
			queues: [...this.sessions.values()].map((session) => ({
				conversationKey: session.conversationKey,
				queued: session.queue.length,
				active: Boolean(session.activeRun),
			})),
		};
	}

	private async removeProcessingReaction(_sess: BridgeSession, item: QueuedMessage): Promise<void> {
		if (!this.deps.reactions || !item.messageId || !item.emojiReactionId) return;
		try {
			await this.deps.reactions.remove(item.messageId, item.emojiReactionId);
			item.emojiReactionId = undefined;
		} catch {
			/* ignore */
		}
	}

	private async notify(
		chatId: string,
		text: string,
		opts?: { replyTo?: string; threadId?: string },
		dedupeKey = `${chatId}:${text}`,
		laneKey = chatId,
		kind: "error" | "notify" = "notify",
	): Promise<boolean> {
		return this.notices.send({ chatId, text, opts, dedupeKey, laneKey, kind });
	}

}

/**
 * 命令脱敏已移至 `outbound/progress-render.ts`（与渲染同处一地）；
 * 这里用 re-export 保持对外导入路径不变。
 */
export { sanitizeCommand };

// 文本工具移到 text-utils.ts（RunExecutor 与管理器共用）；这里 re-export 保持对外导入路径不变。
export { extractAssistantText, extractText, previewText, stripContextPrefix, stripInjectedPrompt } from "./text-utils.js";
export { transcriptMarkdown } from "./history-ops.js";
export { matchModels, modelLabel } from "./model-utils.js";

/** 回复目标：合成消息按 replyTarget（null = 不挂回复）；真实消息就是它自己。 */
function replyTargetOf(msg: Pick<FeishuInboundMessage, "messageId" | "replyTarget">): string | undefined {
	if (msg.replyTarget === null) return undefined;
	return msg.replyTarget ?? msg.messageId;
}

/** 有界等待：任务结束或超时即返回（不抛错；用于关闭与回收这类"尽力而为"的清理）。 */
async function boundedWait(task: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
	try { await Promise.race([task.then(() => undefined, () => undefined), timeout]); }
	finally { if (timer) clearTimeout(timer); }
}

/** `/reload` 的回执：数量、技能增减、加载问题（各最多列 10 条）。 */
function formatReloadSummary(summary: ReloadSummary): string {
	const list = (names: string[]) => names.length > 10 ? `${names.slice(0, 10).join("、")} 等 ${names.length} 个` : names.join("、");
	const lines = [`已重新加载：扩展 ${summary.extensions} 个、技能 ${summary.skills.length} 个、提示模板 ${summary.prompts} 个；对话历史不变`];
	if (summary.addedSkills.length) lines.push(`新增技能：${list(summary.addedSkills)}`);
	if (summary.removedSkills.length) lines.push(`移除技能：${list(summary.removedSkills)}`);
	if (summary.problems.length) {
		lines.push(`有 ${summary.problems.length} 处加载问题：`, ...summary.problems.slice(0, 10).map((problem) => `· ${problem.slice(0, 200)}`));
	}
	return lines.join("\n");
}
