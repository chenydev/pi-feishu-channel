/**
 * 一个桥实例在运行期间的全部可变状态。
 *
 * 入口函数只创建一个 `BridgeRuntime`，各处理函数都从它读写，而不是各自持有闭包变量：
 * 这样状态一目了然（都在这一个类里），测试也能直接构造一个实例检查初始值。
 * 这里只放状态，不放行为；组件在 `start` 时装配，`stop` 时清空。
 */
import type { AlwaysApprovedStore } from "../approval/always-approved-store.js";
import type { PermissionBridge } from "../approval/permission-bridge.js";
import type { PsForwardingServer } from "../approval/ps-forwarding.js";
import type { LastSentCache } from "../inbound/admit.js";
import type { InboundPipeline } from "../inbound/pipeline.js";
import type { FeishuTransport } from "../inbound/transport.js";
import type { ClarificationStore } from "../interaction/clarification-store.js";
import type { Outbox } from "../outbound/outbox.js";
import type { Sender } from "../outbound/sender.js";
import type { UsageProvider } from "../outbound/usage-provider.js";
import type { ConversationManager } from "../session/conversation-manager.js";
import type { BridgeConfig, BridgeStatus } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { AccessRequestTracker } from "./access-request.js";
import type { AlertMonitor } from "./alerts.js";
import type { AppLock } from "./app-lock.js";
import type { KnownChatStore } from "./known-chat-store.js";
import type { UsageLedger } from "./usage-ledger.js";

/** 尚未启动时的状态快照（`status.json` 的初始内容）。 */
export function initialStatus(): BridgeStatus {
	return {
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
}

export class BridgeRuntime {
	// ── 生命周期 ──
	started = false;
	stopping = false;
	config: BridgeConfig = DEFAULT_CONFIG;
	/** 运行时目录（配置、状态文件、会话都在它下面）；未启动时为空串。 */
	homeDir = "";
	appLock: AppLock | undefined;
	/** 生命周期事件按顺序串行处理（上一条处理完才处理下一条）。 */
	lifecycleTail: Promise<void> = Promise.resolve();
	heartbeatTimer: ReturnType<typeof setInterval> | undefined;

	// ── 核心组件（start 时装配） ──
	transport: FeishuTransport | undefined;
	pipeline: InboundPipeline | undefined;
	convManager: ConversationManager | undefined;
	sender: Sender | undefined;
	outbox: Outbox | undefined;
	lastSent: LastSentCache | undefined;
	knownChats: KnownChatStore | undefined;

	// ── 审批 ──
	permissionBridge: PermissionBridge | undefined;
	/** pi-permission-system 父会话转发（默认关）：桥充当应答方，把 PS 的 ask 变成审批卡。 */
	psForwarding: PsForwardingServer | undefined;
	/** 「始终批准」规则表（转发路径）；未启用时为 undefined。 */
	alwaysApproved: AlwaysApprovedStore | undefined;
	psForwardingParentId: string | undefined;
	/** 本进程自己声明过的父会话 id（撤回时只删自己设的值，不动外层启动方的声明）。 */
	psForwardingOwnEnvId: string | undefined;
	/** 澄清提问（与审批完全独立，选择不授予任何工具权限）。 */
	clarificationStore: ClarificationStore | undefined;

	// ── 连接状态与断线补收 ──
	reportedConnState: BridgeStatus["connState"] = "disconnected";
	downSince: number | undefined;
	lastError: string | undefined;
	compensatedMessages = 0;
	compensationErrors = 0;
	compensationTruncated = 0;
	compensationPromise: Promise<void> | undefined;
	status: BridgeStatus = initialStatus();

	// ── 可选能力 ──
	/** DeepSeek 余额客户端（首次用到才建，避免启动时做外部请求）。 */
	usageProvider: UsageProvider | undefined;
	/** 按天用量记录。 */
	usageLedger: UsageLedger | undefined;
	/** 告警（`alerts.enabled` 时才建）。 */
	alertMonitor: AlertMonitor | undefined;
	/** 开通申请限流状态（按群）。 */
	accessRequests: AccessRequestTracker | undefined;
}
