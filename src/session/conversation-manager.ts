/**
 * 会话管理器：Map<conversationKey, BridgeSession>，每 chat 独立 session/queue/activeRun。
 * 按会话隔离的思路参考 pi-remote-feishu 的 ConversationRouter。
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { type BridgeConfig, type DeliveryTarget, EXTERNAL_CHAT_PREFIX, type FeishuInboundMessage, type SessionBackend } from "../types.js";
import type { Sender } from "../outbound/sender.js";
import type { Outbox } from "../outbound/outbox.js";
import { buildConversationKey } from "./conversation-key.js";
import { PendingStore } from "./pending-store.js";
import { ConversationStore, type ConversationPointer } from "./conversation-store.js";
import type { IntakeLedger } from "../inbound/pipeline.js";
import type { ResourceResolver, ResolvedTurnResources } from "../inbound/resource-resolver.js";
import { sanitizeCommand } from "../outbound/progress-render.js";
import { ProgressTracker } from "./progress-tracker.js";
import { LiveChannel, SerialWriter } from "../outbound/live-channel.js";
import { type createRunMetrics, elapsedMs as metricsElapsedMs, renderFooter } from "../outbound/run-metrics.js";
import { resolveFooterEnabled } from "../config.js";
import { cnyPerUsdForModel } from "../outbound/deepseek-usage.js";
import { stripFooterFromQuote } from "../outbound/run-metrics.js";
import type { RunUsage, UsageSnapshot } from "../commands/usage-card.js";
import { RateBudget } from "../runtime/rate-budget.js";
import { randomUUID } from "node:crypto";
import { budgetState, type UsageLedger } from "../runtime/usage-ledger.js";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { ResourceRef } from "../types.js";
import { extractText, stripContextPrefix } from "./text-utils.js";
import { RunExecutor } from "./run-executor.js";
import { SessionScheduler } from "./scheduler.js";
import { ConversationCommands } from "./conversation-commands.js";
import { sessionUsageStats } from "./model-utils.js";

export type AgentHandle = Awaited<ReturnType<SessionBackend["createSession"]>>;

/** 只读档位允许的工具（与实际注册工具取交集）。 */
const READONLY_TOOLS = ["read", "grep", "find", "ls", "web_search", "web_fetch", "feishu_notify", "feishu_ask"];

/** 把档位/白名单解析成具体工具名（只保留实际存在的）。 */
export function resolveToolPolicy(policy: string[] | "readonly" | "standard" | "full", all: string[]): string[] {
	if (policy === "full") return all;
	if (policy === "readonly") return all.filter((name) => READONLY_TOOLS.includes(name));
	if (policy === "standard") return all.filter((name) => name !== "bash");
	return all.filter((name) => policy.includes(name));
}

/** 会话管理器的依赖（发送、持久化、审批联动、可选能力）。 */
export interface ConversationManagerDeps {
	config: BridgeConfig;
	/** 会话文件目录（绝对路径；避免相对路径落在 /workspace 无权限）。 */
	sessionDir: string;
	sessionBackend: SessionBackend;
	sender: Sender;
	/** final/error/notify 的可靠投递；进度消息仍由 sender 直接发送。 */
	durableOutbox?: Pick<Outbox, "enqueue"> & Partial<Pick<Outbox, "enqueueMedia">>;
	resourceResolver?: Pick<ResourceResolver, "resolve">;
	/** 本 bot 最近已发消息缓存（回复"自己消息"判定，hermes reply_to_is_own_message 等价）。 */
	lastSent?: { has(messageId: string): boolean };
	/** 处理中表情（reaction）能力：入队时添加、回复发出后撤回。 */
	reactions?: {
		add(messageId: string, emoji: string): Promise<string | undefined>;
		remove(messageId: string, reactionId: string): Promise<boolean>;
	};
	/** 进度消息编辑/撤回（方案 A：处理中消息实时更新工具进度）。 */
	editMessage?: (messageId: string, text: string) => Promise<boolean>;
	recallMessage?: (messageId: string) => Promise<boolean>;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	/** 流式卡片需要直连飞书 API（复用 transport.rawRequest）。 */
	rawRequest?: (opts: { url: string; method: string; params?: unknown; data?: unknown }) => Promise<unknown>;
	/** run 空闲超时：有活动就不计时，停止产出才中止（默认 10 分钟）。0 = 关闭。 */
	runIdleTimeoutMs?: number;
	/** run 总时长硬上限（默认 0 = 不限制，只靠空闲超时兜底）。 */
	runMaxDurationMs?: number;
	/** 该会话未决审批数；>0 时不回收会话句柄。 */
	pendingApprovalCount?: (conversationKey: string) => number;
	/**
	 * 审批失效回调 —— run 结束（带 runId）或会话重置（无 runId）时撤销未决审批，
	 * 使已超时/结束/替换的任务再也无法通过旧卡授予 session/always 权限。
	 */
	onApprovalInvalidate?: (input: { conversationKey: string; runId?: string; reason: RunRetireReason }) => void;
	/** shutdown 对单个外部清理动作的等待上限；默认 2s，必须短于 SIGTERM 强退窗口。 */
	shutdownTimeoutMs?: number;
	now?: () => number;
	/** pending 中断恢复文件路径（hermes resume_pending；不设则禁用）。 */
	pendingFile?: string;
	/** open_id → 姓名（可选；拿不到时退化为 open_id 尾号）。 */
	resolveUserName?: (openId: string) => Promise<string | undefined>;
	/** 非聊天目标的交付（云文档评论回复）。返回是否送达。 */
	deliverExternal?: (target: DeliveryTarget, text: string) => Promise<boolean>;
	/** 按天用量账本（预算判定与周报）。 */
	usageLedger?: UsageLedger;
	/** 页脚美元→人民币折算（缺省按 DeepSeek 费率表；usage.provider = none 时恒为 undefined）。 */
	cnyPerUsd?: (modelId: string | undefined) => number | undefined;
	/** 导出与长回答附件的落盘目录（不设则相关功能不可用）。 */
	exportsDir?: string;
	/** 把本地文件经持久 outbox 发到会话（由桥层实现：校验 + 暂存 + enqueueMedia）。 */
	sendLocalFile?: (chatId: string, path: string, opts: { replyTo?: string; threadId?: string }, meta: { dedupeKey: string; laneKey: string }) => { ok: boolean; error?: string };
	/**
	 * 会话指针文件（conversationKey → 当前会话文件/世代）。
	 * 不设时退化为旧的内存后缀行为（/_new 重启会回退到初始文件）。
	 */
	conversationFile?: string;
	/** 模型切换历史文件（不设则只在内存里，重启清空）。 */
	modelUsageFile?: string;
}

export interface BridgeSession {
	conversationKey: string;
	/** 已注入过的群设定（变更或会话重建后重新注入）。 */
	promptInjected?: string;
	/** 原始 chatId（发送目标）；key 用于会话隔离。 */
	chatId: string;
	/** 话题 id（话题会话的发送目标 threadId）。 */
	threadId?: string;
	agent?: AgentHandle;
	/** 防止命令与首条消息并发时重复创建同一个 Pi session。 */
	creatingAgent?: Promise<AgentHandle>;
	/** agent 运行时 sessionId（tool 事件映射用，pi.on ctx.sessionManager.getSessionId()）。 */
	sessionId?: string;
	sessionFile: string;
	queue: Array<QueuedMessage>;
	/** 已由 Pi 接受、将在当前 run 的 turn 边界注入的消息。 */
	steered: Array<QueuedMessage>;
	activeRun: boolean;
	stopRequested?: boolean;
	createdAt: number;
	/** 最近活动时间（空闲回收依据）。 */
	lastActivityAt?: number;

	/** 该会话的工作区 realpath（解析自白名单别名）。 */
	workspacePath?: string;

	/** 工作区别名（诊断/展示用，不泄露绝对路径）。 */
	workspaceAlias?: string;
	/** run 空闲计时器：收到任意 agent 事件就重置；长时间无产出才中止。 */
	runIdleTimer?: ReturnType<typeof setTimeout>;
	/** 空闲超时时用来 reject run 的句柄（按会话，避免多会话并发互相覆盖）。 */
	runIdleReject?: (error: Error) => void;
	/** 最近一轮 run 的指标快照（`/feishu usage` 展示用）。 */
	lastRun?: RunUsage;
	/** 最近一次执行的用户消息（/retry 用原文重发，而不是带注入上下文的版本）。 */
	lastItem?: QueuedMessage;
	/** 上次"已排队"提示的时间（10 秒内只提示一次）。 */
	lastQueueNoticeAt?: number;
	/** 直接执行命令进行中（/stop 用 abortBash 中止）。 */
	bashRunning?: boolean;
}

export interface QueuedMessage {
	runId: string;
	/** 回复目标（真实消息 = messageId；合成消息 = 卡片 id 或不挂回复）。 */
	replyTo?: string;
	/** 合成消息不加表情（messageId 不是真实飞书消息）。 */
	synthetic?: boolean;
	/** 合批消息的全部原始 id（撤回任意一条都能定位到这个任务）。 */
	sourceMessageIds?: string[];
	chatId: string;
	messageId: string;
	text: string;
	resources: ResourceRef[];
	replyToMessageId?: string;
	replyToText?: string;
	/** 话题（thread_id）透传：hermes 话题模式。 */
	threadId?: string;
	/**
	 * 发起人 open_id。审批免审判定必须用它 —— conversationKey 只在「群聊+按人隔离」
	 * 这一种形态下才带用户 ID（话题是 `oc:t:th`、私聊是裸 `oc`），
	 * 从 key 里正则提取会漏掉后两种，导致管理员在私聊/话题里仍需逐次审批。
	 */
	senderId?: string;
	/** 发言人姓名（入站自带或由 resolveUserName 解析）。 */
	senderName?: string;
	chatType?: FeishuInboundMessage["chatType"];
	/** 本条消息 @ 的其他人（不含本 bot）。 */
	mentions?: Array<{ name?: string; openId?: string }>;
	atAll?: boolean;
	/** 处理中表情：reaction_id（add 时返回）。 */
	reactionId?: string;
	emojiReactionId?: string;
	/** Pi 的 agent_settled 信号：本轮确实不会再继续（比 turn_end 更终局）。 */
	settled?: boolean;
	/** 非聊天交付目标（云文档评论）。 */
	deliverTo?: DeliveryTarget;
}

const MAX_QUEUE = 50;

/** run 退出原因（决定未决审批卡的失效语义）。 */
export type RunRetireReason = "completed" | "timeout" | "stopped" | "shutdown" | "failed" | "reset";

/** /new 的结果：busy 表示有未完成任务需要显式 force。 */
export type ResetOutcome =
	| { status: "reset"; generation: number; cancelled: number; previousName?: string; hadPrevious?: boolean }
	| { status: "busy"; pending: number }
	| { status: "error"; reason: string };

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
	private sessions = new Map<string, BridgeSession>();
	/**
	 * 恢复提示（对齐 hermes build_resume_recovery_note）：崩溃恢复后给模型注入
	 * 一条方括号元信息，告诉它"上次中断了，不要重跑历史里未完成的工具调用"。
	 * 按 conversationKey 索引 —— 恢复后用户会发**新**消息（新 messageId），
	 * 按被中断那条消息的 id 索引永远匹配不上。注入一次即删除；
	 * 只在内存里，不落盘、不发给用户。
	 */
	private readonly recoveryNotes = new Map<string, string>();
	private runIdleTimeoutMs: number;
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
	private readonly sessionKeyById = new Map<string, string>();
	/** 共享请求预算（易失通道让路给最终交付与审批）。 */
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

	constructor(private deps: ConversationManagerDeps) {
		// 对齐 hermes 的做法：**不设固定总时长**（长时间跑测试是正常的），
		// 只在「完全没有事件产出」时才判定卡死 —— 空闲超时。
		this.runIdleTimeoutMs = deps.runIdleTimeoutMs ?? 600_000;
		this.runMaxDurationMs = deps.runMaxDurationMs ?? 0;
		this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 2_000;
		this.now = deps.now ?? Date.now;
		this.pendingFile = deps.pendingFile ?? "";
		this.pendingEnabled = Boolean(deps.pendingFile);
		this.pendingStore = this.pendingEnabled ? new PendingStore(this.pendingFile, { now: this.now }) : undefined;
		this.conversationStore = deps.conversationFile
			? new ConversationStore(deps.conversationFile, { now: this.now })
			: undefined;
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
			notify: (...args) => this.notify(...args),
		});
	}

	/**
	 * sessionId → 会话。每个工具事件都要查好几次，不能每次全表线性扫描。
	 * 索引是自愈缓存：命中后校验一致性，失配（会话被重建/回收）时回退扫描并回填，
	 * 因此不必在每个创建/回收点手工维护。
	 */
	private sessionById(sessionId: string): BridgeSession | undefined {
		if (!sessionId) return undefined;
		const key = this.sessionKeyById.get(sessionId);
		const cached = key ? this.sessions.get(key) : undefined;
		if (cached?.sessionId === sessionId) return cached;
		const found = [...this.sessions.values()].find((candidate) => candidate.sessionId === sessionId);
		if (found) this.sessionKeyById.set(sessionId, found.conversationKey);
		else this.sessionKeyById.delete(sessionId);
		return found;
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

	/** 启动时恢复上次中断的未完成消息（hermes resume_pending）。 */
	async recoverPending(): Promise<number> {
		if (!this.pendingEnabled) return 0;
		const entries = this.pendingStore?.recoverable() ?? [];
		// 命令类消息（never）不会出现在这里：PendingStore.recoverable() 在账本层已排除并清理。
		for (const e of entries) {
			this.deps.log?.("warn", "feishu.conv.recover_pending", { chatId: e.message.chatId, messageId: e.message.messageId });
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
	 * 入站流水线用的持久接管账本：准入通过即写账，使合并窗口内崩溃可恢复。
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
		// 2. 群普通消息：groupSessionsPerUser=true → chatId:u:senderId
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
			// 流水线已在准入后提前接管；明确拒绝时清除该记录，避免重启后重放被拒消息。
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
			} catch { /* reaction 失败不影响已持久接管的消息 */ }
		}
		if (options.behavior !== "queue" && await this.trySteer(sess, queued)) {
			await this.markSteered(sess, queued);
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
		let text = item.text;
		let resources: ResolvedTurnResources | undefined;
		if (item.resources.length > 0 && this.deps.resourceResolver) {
			resources = await this.deps.resourceResolver.resolve(item.resources);
			text += resources.promptSuffix;
		}
		if (item.replyToMessageId && item.replyToText) {
			// 先剔掉桥自己加的页脚块：那是给人看的元信息，不该每轮花 token 喂回模型。
			// 先按注册表精确匹配我们发过的原文，再按行形态兜底（保证一定删干净）。
			const strippedQuote = stripFooterFromQuote(item.replyToText, this.sentFooters);
			// 整条都是页脚（引用了一条纯元信息消息）：注入占位提示，别塞空引用
			const quote = (strippedQuote.trim() || "[无法获取被回复消息原文]").slice(0, 500).replace(/@_user_\w+/g, "@").replace(/\n/g, " ");
		const replyingToSelf = Boolean(this.deps.lastSent?.has(item.replyToMessageId));
			text = replyingToSelf
				? `[你正在回复自己上一条消息，原文："${quote}"]\n\n${text}`
				: `[正在回复的消息原文："${quote}"]\n\n${text}`;
		}
		// 给 agent 的上下文（发言人 / 提及 / 群设定）
		const context = await this.agentContextLines(item, conversationKey);
		if (context.length > 0) text = `${context.join("\n")}\n\n${text}`;
		// 恢复提示：一次性注入。注意必须放在 replyTo 分支之外 ——
		// 崩溃恢复后用户重发的消息通常不带回复引用，若写在分支内就永远不会生效。
		const recoveryNote = this.recoveryNotes.get(conversationKey);
		if (recoveryNote) {
			text = `${recoveryNote}\n\n${text}`;
			this.recoveryNotes.delete(conversationKey);
		}
		return { text, images: resources?.images, resources };
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
	 * 发言人、提及对象、群设定。
	 * - 发言人只在多人共用的会话里加（话题、不按人隔离的群；`agentContext.sender=always` 时群聊都加）——
	 *   否则模型分不清"谁在说话"；按人隔离的会话里永远是同一个人，加了只是浪费 token；
	 * - 提及：让 agent 知道"帮我通知他"的"他"是谁，并拿到 open_id 能 @ 回去；
	 * - 群设定（groupRules.<chatId>.prompt）：会话创建后的首轮注入一次，之后在会话历史里。
	 */
	private async agentContextLines(item: QueuedMessage, conversationKey: string): Promise<string[]> {
		const lines: string[] = [];
		const options = this.deps.config.agentContext ?? {};
		const sess = this.sessions.get(conversationKey);
		// 群里用本群设定；私聊用发起人的个人偏好（/feishu prompt set）
		const personal = item.chatType === "p2p";
		const groupPrompt = (personal
			? (item.senderId ? this.deps.config.userPrompts?.[item.senderId] : undefined)
			: this.deps.config.groupRules?.[item.chatId]?.prompt)?.trim();
		if (groupPrompt && sess && sess.promptInjected !== groupPrompt) {
			lines.push(personal
				? `[用户偏好（本人设置）：${groupPrompt.slice(0, 2_000)}]`
				: `[本群设定（管理员配置，优先遵守）：${groupPrompt.slice(0, 2_000)}]`);
			sess.promptInjected = groupPrompt;
		}
		const senderMode = options.sender ?? "shared";
		const shared = conversationKey.includes(":t:") || (item.chatType === "group" && !this.deps.config.groupSessionsPerUser);
		if (item.senderId && item.chatType !== "p2p" && (senderMode === "always" || (senderMode === "shared" && shared))) {
			const name = item.senderName ?? await this.deps.resolveUserName?.(item.senderId).catch(() => undefined);
			lines.push(`[发言人：${name ?? `用户…${item.senderId.slice(-4)}`}（open_id=${item.senderId}）]`);
		}
		if (options.mentions !== false && ((item.mentions?.length ?? 0) > 0 || item.atAll)) {
			const people = (item.mentions ?? []).map((m) => `${m.name ?? "?"}${m.openId ? `(open_id=${m.openId})` : ""}`);
			if (item.atAll) people.push("@所有人");
			lines.push(`[提及：${people.join("、")}]`);
		}
		return lines;
	}

	/**
	 * 标记会话的 run 有活动（收到任意 agent 事件时调用），重置空闲计时器。
	 * 对齐 hermes 的做法：不做固定总时长超时（跑长测试是正常的），
	 * 只在「完全无产出」时判定卡死。
	 */
	touchRunActivity(sess: BridgeSession): void {
		if (this.runIdleTimeoutMs <= 0 || !sess.runIdleReject) return;
		if (sess.runIdleTimer) clearTimeout(sess.runIdleTimer);
		sess.runIdleTimer = setTimeout(() => {
			this.deps.log?.("warn", "feishu.conv.run_idle_timeout", { chatId: sess.chatId, idleMs: this.runIdleTimeoutMs });
			sess.runIdleReject?.(new Error("run idle timeout"));
		}, this.runIdleTimeoutMs);
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
		if (session.activeRun || session.creatingAgent) return false;
		if (session.queue.length > 0 || session.steered.length > 0) return false;
		if (this.activeItems.has(key)) return false;
		if ((this.deps.pendingApprovalCount?.(key) ?? 0) > 0) return false;
		const idleSince = session.lastActivityAt ?? session.createdAt;
		return now - idleSince >= this.idleTtlMs;
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
	 * 被清掉的消息在接管账本里落终态（重启不重放）并撤掉处理中表情。
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
		try { await this.deps.reactions.add(item.messageId, emoji); } catch { /* 表情失败不影响注入 */ }
	}

	/** 忙碌时排队的消息回复一次"已排队，第 N 个"（同一会话 10 秒内只提示一次）。 */
	private async noticeQueued(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		if (this.deps.config.queueNotice === false) return;
		const now = this.now();
		if (sess.lastQueueNoticeAt && now - sess.lastQueueNoticeAt < 10_000) return;
		sess.lastQueueNoticeAt = now;
		const position = sess.queue.indexOf(item) + 1;
		await this.notify(item.chatId, `已排队，第 ${position} 个（当前任务结束后执行；/queue list 查看，/queue clear 清空）`, {
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

	/** 撤销最近一轮（只回退对话；原分支仍在会话文件里）。 */
	async undoConversation(msg: FeishuInboundMessage): Promise<string> {
		const ready = await this.idleAgent(msg);
		if (typeof ready === "string") return ready;
		const { agent } = ready;
		if (!agent.userMessages || !agent.navigateTo) return "当前 Pi 版本不支持回退";
		const last = agent.userMessages().at(-1);
		if (!last) return "当前会话还没有可撤销的对话";
		const result = await agent.navigateTo(last.entryId);
		if (result.cancelled) return "回退被取消";
		this.deps.log?.("info", "feishu.conv.undo", { conversationKey: ready.key });
		return `已撤销最近一轮：「${previewText(stripContextPrefix(last.text))}」\n只回退对话记录，该轮已经执行的命令、改过的文件不会回滚。`;
	}

	/** 用同一条消息重新生成上一轮（常用于换模型/思考等级后再试）。 */
	async retryConversation(msg: FeishuInboundMessage): Promise<string> {
		const ready = await this.idleAgent(msg);
		if (typeof ready === "string") return ready;
		const { agent, session } = ready;
		if (!agent.userMessages || !agent.navigateTo) return "当前 Pi 版本不支持重试";
		const last = agent.userMessages().at(-1);
		if (!last) return "当前会话还没有可以重试的消息";
		const result = await agent.navigateTo(last.entryId);
		if (result.cancelled) return "重试被取消";
		// 优先用桥记下的原文（不含注入的上下文行 —— 否则重发时发言人/引用会重复注入）
		const original = session.lastItem;
		const text = original?.text ?? stripContextPrefix(result.editorText ?? last.text);
		await this.route({
			...msg, text, msgType: "text",
			resources: original?.resources ?? [],
			replyToMessageId: original?.replyToMessageId, replyToText: original?.replyToText,
		}, { behavior: "queue" });
		this.deps.log?.("info", "feishu.conv.retry", { conversationKey: ready.key, model: agent.modelId });
		return `正在重试上一条消息（模型：${agent.modelId}）`;
	}

	/** `/fork list` 的数据（第 N 条用户消息预览）。 */
	async forkCandidates(msg: FeishuInboundMessage): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try { agent = await this.ensureAgentSession(session); } catch { return "会话初始化失败，请稍后重试"; }
		const list = agent.userMessages?.() ?? [];
		if (list.length === 0) return "当前会话还没有用户消息";
		const start = Math.max(0, list.length - 15);
		return [
			`本会话用户消息（共 ${list.length} 条${start > 0 ? "，只列最近 15 条" : ""}）：`,
			...list.slice(start).map((entry, index) => `#${start + index + 1} ${previewText(stripContextPrefix(entry.text))}`),
			"",
			"/fork #N 从第 N 条消息之前分叉出新会话；/fork 复制当前会话。",
		].join("\n");
	}

	/**
	 * 分叉。无参 = 从当前位置复制一份；`#N` = 从第 N 条用户消息之前分叉。
	 * 新文件接入会话指针（旧会话进历史，/sessions 可回去），与 /resume 同一套切换顺序：先落盘指针，再换运行态。
	 */
	async forkConversation(msg: FeishuInboundMessage, selector?: string): Promise<string> {
		if (!this.conversationStore) return "当前部署未启用会话索引，无法分叉";
		const ready = await this.idleAgent(msg);
		if (typeof ready === "string") return ready;
		const { key, session, agent } = ready;
		if (!agent.branchedSessionFile || !agent.leafId) return "当前 Pi 版本不支持分叉";
		let leaf: string | undefined;
		let note = "";
		if (selector) {
			const match = /^#?(\d+)$/.exec(selector.trim());
			if (!match) return "用法：/fork [#N]（/fork list 查看消息编号）";
			const n = Number.parseInt(match[1], 10);
			const list = agent.userMessages?.() ?? [];
			const target = list[n - 1];
			if (!target) return `没有第 ${n} 条用户消息（共 ${list.length} 条）`;
			const parent = agent.entryParentId?.(target.entryId);
			if (parent === undefined) return "无法定位该消息，请稍后重试";
			if (parent === null) return "第 1 条消息之前没有历史，直接 /new 即可";
			leaf = parent;
			note = `\n分叉点在第 ${n} 条消息之前，那条消息是：「${previewText(stripContextPrefix(target.text))}」`;
		} else {
			leaf = agent.leafId();
		}
		if (!leaf) return "当前会话还没有内容，无需分叉";
		let file: string | undefined;
		try {
			file = agent.branchedSessionFile(leaf);
		} catch (error) {
			return `分叉失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
		}
		if (!file) return "分叉失败：Pi 未返回新会话文件";
		const pointer = this.conversationStore.get(key);
		try {
			this.conversationStore.set({ conversationKey: key, sessionFile: file, generation: (pointer?.generation ?? 0) + 1 });
		} catch {
			return "会话指针写入失败，已保留当前会话";
		}
		// 句柄已经指向新文件，但它的内存状态是分叉前的；重开最稳妥
		this.sessions.delete(key);
		this.liveChannel?.discard(key);
		try { await session.agent?.dispose(); } catch { /* best effort */ }
		this.deps.onApprovalInvalidate?.({ conversationKey: key, reason: "reset" });
		this.deps.log?.("info", "feishu.conv.forked", { conversationKey: key, selector: selector ?? null });
		return `已分叉出新会话，下一条消息在分叉上继续；原会话可用 /sessions 找回。${note}`;
	}

	// ------------------------------------------------------------ 导出 ----

	/** 导出当前会话为文件并经持久 outbox 发回本会话。 */
	async exportConversation(msg: FeishuInboundMessage, format: "html" | "md" | "summary"): Promise<string> {
		const dir = this.deps.exportsDir;
		if (!dir || !this.deps.sendLocalFile) return "当前部署未启用导出";
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try { agent = await this.ensureAgentSession(session); } catch { return "会话初始化失败，请稍后重试"; }
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
		const name = (agent.sessionName?.() || "session").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "session";
		let path: string;
		try {
			if (format === "html") {
				if (!agent.exportHtml) return "当前 Pi 版本不支持导出 HTML";
				path = await agent.exportHtml(join(dir, `${name}-${stamp}.html`));
			} else if (format === "summary") {
				if (!agent.summarizeForBugReport) return "当前 Pi 版本不支持生成摘要";
				const summary = await agent.summarizeForBugReport();
				path = join(dir, `${name}-${stamp}-summary.md`);
				writeFileSync(path, summary, { mode: 0o600 });
			} else {
				path = join(dir, `${name}-${stamp}.md`);
				writeFileSync(path, transcriptMarkdown(session.sessionFile, agent.sessionName?.()), { mode: 0o600 });
			}
			try { chmodSync(path, 0o600); } catch { /* best effort */ }
		} catch (error) {
			this.deps.log?.("warn", "feishu.conv.export_failed", { conversationKey: key, format, error: error instanceof Error ? error.message : String(error) });
			return `导出失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
		}
		const sent = this.deps.sendLocalFile(msg.chatId, path, { replyTo: replyTargetOf(msg), threadId: msg.threadId }, {
			dedupeKey: `${msg.messageId}${msg.dedupeNonce ?? ""}:export`, laneKey: key,
		});
		this.deps.log?.("info", "feishu.conv.exported", { conversationKey: key, format, ok: sent.ok });
		return sent.ok ? `已导出（${format}），文件马上发到这里` : `导出文件已生成，但发送失败：${sent.error ?? "未知错误"}`;
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
		// 恢复该会话的工作区（别名 → realpath；配置被移除时回落到默认）
		const storedWorkspace = this.conversationStore?.get(key)?.workspace;
		const effectiveWorkspace = this.workspaceAliasByKey.get(key) ?? storedWorkspace;
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
		// 虚拟会话（云文档评论）不是飞书会话 —— 发过去只会变成 outbox 里的永久失败；
		// 这类会话面向用户的提示由执行器经 deliverExternal 交付。
		if (chatId.startsWith(EXTERNAL_CHAT_PREFIX)) {
			this.deps.log?.("info", "feishu.conv.notify_skipped_external", { chatId, kind });
			return false;
		}
		try {
			if (this.deps.durableOutbox) {
				return this.deps.durableOutbox.enqueue(chatId, text, opts ?? {}, { dedupeKey, laneKey, kind }).length > 0;
			}
			return (await this.deps.sender.send(chatId, text, opts)).success;
		} catch {
			return false;
		}
	}

}

/**
 * 命令脱敏已移至 `outbound/progress-render.ts`（与渲染同处一地）；
 * 这里用 re-export 保持对外导入路径不变。
 */
export { sanitizeCommand };

// 文本工具移到 text-utils.ts（RunExecutor 与管理器共用）；这里 re-export 保持对外导入路径不变。
export { extractAssistantText, extractText, stripContextPrefix, stripInjectedPrompt } from "./text-utils.js";
export { matchModels, modelLabel } from "./model-utils.js";

/** 列表/回执里的消息预览（单行、截断）。 */
function previewText(text: string, max = 40): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return "（附件）";
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 把 Pi 会话文件整理成 markdown（只含用户与助手的文本，不含工具参数/输出）。 */
export function transcriptMarkdown(sessionFile: string, title?: string): string {
	const out: string[] = [`# ${title || "会话记录"}`, ""];
	let raw = "";
	try { raw = readFileSync(sessionFile, "utf8"); } catch { return `${out.join("\n")}\n（会话文件不存在）\n`; }
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(entry.message.content);
		if (!text) continue;
		out.push(`## ${role === "user" ? "用户" : "助手"}${entry.timestamp ? ` · ${entry.timestamp}` : ""}`, "", text, "");
	}
	return out.join("\n");
}

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
