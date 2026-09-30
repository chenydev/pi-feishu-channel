/**
 * 桥的状态输出：`status.json`（外部探活与排障的依据）、pi 状态栏、`/feishu status` 的正文
 * 与诊断上下文（供 `/feishu doctor` 和诊断包复用）。
 */
import { formatTimeInZone, resolvePaths } from "../config.js";
import { enabledFeatures } from "../features/switches.js";
import type { BridgeRuntime } from "./bridge-runtime.js";
import type { BridgeLogger } from "./logger.js";
import { writeStatus } from "./status-store.js";

export interface StatusReporterDeps {
	rt: BridgeRuntime;
	log: BridgeLogger;
	/** pi 状态栏（没有界面时为空操作）。 */
	setUiStatus(key: string, text: string): void;
	/** 重连计数（累计 / 近 5 分钟）。 */
	reconnects(): { total: number; last5m: number };
	/** 可选能力追加到 `/feishu status` 的行。 */
	featureLines(): string[];
}

export class StatusReporter {
	constructor(private readonly deps: StatusReporterDeps) {}

	/** pi 状态栏：`feishu-conn`（连接）与 `feishu-bridge`（桥本身）。 */
	setUi(key: "conn" | "bridge", text: string): void {
		try {
			this.deps.setUiStatus(`feishu-${key}`, text);
		} catch {
			/* 没有界面 */
		}
	}

	/** 重新汇总状态并写 status.json。 */
	update(): void {
		const { rt, log } = this.deps;
		const stats = rt.pipeline?.getStats();
		const outboxStats = rt.outbox?.stats() ?? { pending: 0, sending: 0, sent: 0, failed: 0, lanes: 0, oldestAgeMs: 0 };
		const reconnects = this.deps.reconnects();
		rt.status = {
			appId: rt.config.appId || undefined,
			pid: process.pid,
			updatedAt: Date.now(),
			connState: rt.transport?.isConnected() ? "connected" : rt.reportedConnState === "error" ? "error" : rt.transport?.isRunning() ? "connecting" : "disconnected",
			downSince: rt.downSince,
			lastError: rt.lastError,
			reconnectCount: reconnects.total,
			reconnectsLast5m: reconnects.last5m,
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

	/** 诊断上下文（只含计数与枚举，供 doctor/导出复用）。 */
	diagnosticsContext() {
		const { rt } = this.deps;
		this.update();
		return {
			lastErrorClass: rt.status.lastError ? "last_error_present" : undefined,
			outbox: rt.status.outbox,
			conversations: rt.status.conversations,
			pendingApprovals: rt.status.pendingApprovals ?? 0,
			budget: rt.convManager?.budgetSnapshot(),
			piVersion: process.env.PI_VERSION,
			reconnectsLast5m: this.deps.reconnects().last5m,
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

	/** `/feishu status` 的正文。 */
	text(): string {
		const { rt } = this.deps;
		this.update();
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
		if (rt.feedback.up || rt.feedback.down) lines.push(`反馈（本次启动以来）: 👍 ${rt.feedback.up} / 👎 ${rt.feedback.down}`);
		lines.push(...this.deps.featureLines());
		for (const failure of rt.outbox?.recentFailures(3) ?? []) {
			lines.push(`发送失败: ${failure.kind} @ ${formatTimeInZone(failure.updatedAt, rt.config.timezone)} · ${(failure.lastError ?? "").slice(0, 80)}`);
		}
		return lines.join("\n");
	}
}
