/**
 * 会话管理器的类型定义。
 *
 * 单独成文件只为一件事：`ConversationManager` 这个类本身已经够长，把 200 行接口堆在
 * 类前面，翻代码要先跳过一屏。这里没有逻辑，全是「会话长什么样、队列里放什么」。
 *
 * 管理器仍然 re-export 这些名字（历史导入路径不变）。
 */
import type { BridgeConfig, DeliveryTarget, FeishuInboundMessage, SessionBackend } from "../types.js";
import type { Sender } from "../outbound/sender.js";
import type { Outbox } from "../outbound/outbox.js";
import type { AgentHandle } from "./agent-types.js";
import type { ResourceResolver } from "../inbound/resource-resolver.js";
import type { RunUsage } from "../commands/usage-card.js";
import type { UsageLedger } from "../runtime/usage-ledger.js";
import type { RunActivity } from "./run-activity.js";
import type { ResourceRef } from "../types.js";

/** 会话管理器的依赖（发送、持久化、审批联动、可选能力）。 */
/** 一轮最终回答（交给超长回答转文件）。 */
export interface LongReplyInput {
	text: string;
	messageId: string;
	chatId: string;
	conversationKey: string;
	replyTo?: string;
	threadId?: string;
}

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
	/** run 空闲超时：等模型时连续这么久没有事件才中止（默认 10 分钟）。0 = 关闭。 */
	runIdleTimeoutMs?: number;
	/** 工具执行中的空闲超时（默认 60 分钟）。0 = 关闭。 */
	runToolIdleTimeoutMs?: number;
	/** run 总时长硬上限（默认 0 = 不限制，只靠空闲超时兜底）。 */
	runMaxDurationMs?: number;
	/** 该会话未决审批数；>0 时不回收会话句柄。 */
	pendingApprovalCount?: (conversationKey: string) => number;
	/** 该会话里还在等作答的提问数（只算最近一段时间，见 CLARIFY_PROTECT_MS）。 */
	pendingClarificationCount?: (conversationKey: string) => number;
	/**
	 * 真实用户消息到达时的文本判定（`attemptTextResponse` 的三分法）：
	 * 数字/选项原文 = 答案；长得像选择但无效 = 保留提问；其它散文 = 照常投递、提问保留。
	 */
	resolveClarifyText?: (conversationKey: string, text: string) => import("../interaction/clarification-store.js").ClarifyTextOutcome | undefined;
	/** 用户回 `skip` 作废了提问 → 调用方把卡片重绘成只读。 */
	onClarifySkipped?: (records: import("../interaction/clarification-store.js").ClarificationRecord[]) => void;
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
	/**
	 * 待处理记录终结（ack）时回调，参数是消息 id。入站去重层用它把「平台重投」
	 * 与「准入前崩溃」分开：前者不得再执行一遍。
	 */
	onPendingDone?: (messageId: string) => void;
	/** open_id → 姓名（可选；拿不到时退化为 open_id 尾号）。 */
	resolveUserName?: (openId: string) => Promise<string | undefined>;
	/** 非聊天目标的交付（云文档评论回复）。返回是否送达。 */
	deliverExternal?: (target: DeliveryTarget, text: string) => Promise<boolean>;
	/** 按天用量记录（预算判定与周报）。 */
	usageLedger?: UsageLedger;
	/** 页脚美元→人民币折算（缺省按 DeepSeek 费率表；usage.provider = none 时恒为 undefined）。 */
	cnyPerUsd?: (modelId: string | undefined) => number | undefined;
	/** 导出与长回答附件的落盘目录（不设则相关功能不可用）。 */
	exportsDir?: string;
	/** 超长回答转文件（可选能力 longReply 提供）：返回要在正文/卡片里展示的文本。 */
	replyAsFile?: (input: LongReplyInput) => string;
	/** 把本地文件经持久 outbox 发到会话（由桥层实现：校验 + 暂存 + enqueueMedia）。 */
	sendLocalFile?: (chatId: string, path: string, opts: { replyTo?: string; threadId?: string }, meta: { dedupeKey: string; laneKey: string }) => { ok: boolean; error?: string };
	/**
	 * 会话指针文件（conversationKey → 当前会话文件/版本号）。
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
	/** 执行中这一轮的实时状态（在跑什么工具、多久了）；空闲时为空。 */
	run?: RunActivity;
	/** run 空闲计时器：收到任意 agent 事件就重置；长时间无产出才中止。 */
	runIdleTimer?: ReturnType<typeof setTimeout>;
	/** 空闲超时触发时卡在哪一段（中止提示用）。 */
	runIdleInfo?: { phase: "tool" | "model"; tool?: string; idleMs: number };
	/** 上次忙碌提示（"正在执行 bash，消息稍后交给模型"）的时间。 */
	lastBusyNoticeAt?: number;
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
	/** 并入当前 run 时实际交给 pi 的文本（判断「这轮到底消费了没有」用）。 */
	steerText?: string;
	/** 注入 steer 时本轮已结束的 turn 数（`RunActivity.turnEnds`）。 */
	steeredAtTurnEnds?: number;
	chatId: string;
	messageId: string;
	text: string;
	resources: ResourceRef[];
	replyToMessageId?: string;
	replyToText?: string;
	/** 话题（thread_id）原样传递：hermes 话题模式。 */
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

export const MAX_QUEUE = 50;

/** run 退出原因（决定未决审批卡的失效语义）。 */
export type RunRetireReason = "completed" | "timeout" | "stopped" | "shutdown" | "failed" | "reset";

/** /new 的结果：busy 表示有未完成任务需要显式 force。 */
export type ResetOutcome =
	| { status: "reset"; generation: number; cancelled: number; previousName?: string; hadPrevious?: boolean }
	| { status: "busy"; pending: number }
	| { status: "error"; reason: string };

