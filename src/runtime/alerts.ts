/**
 * 桥自身告警 —— 私聊管理员。
 *
 * 每次巡检拿一份健康快照，逐条判断；同类告警在冷却期内只发一次，状态恢复时补一条"已恢复"。
 * 发送失败只记日志（告警通道本身就依赖飞书，断线时发不出去是预期内的 —— 恢复后会补发"断线 N 分钟"）。
 */

export interface HealthSnapshot {
	now: number;
	/** 断线开始时刻（连接正常时 undefined）。 */
	downSince?: number;
	reconnectsLast5m: number;
	/** outbox 里永久失败的 final/error 条数（累计）。 */
	failedFinals: number;
	pendingApprovals: number;
	/** 最早一条待审批已等待的毫秒数。 */
	oldestApprovalAgeMs?: number;
	/** 断线补收累计失败次数。 */
	compensationErrors: number;
}

export type AlertKind = "disconnected" | "flapping" | "outbox_failed" | "approvals_backlog" | "compensation_failed";

export interface AlertOptions {
	disconnectMs: number;
	reconnectsIn5m: number;
	pendingApprovals: number;
	approvalAgeMs: number;
	cooldownMs: number;
}

export const DEFAULT_ALERT_OPTIONS: AlertOptions = {
	disconnectMs: 2 * 60_000,
	reconnectsIn5m: 10,
	pendingApprovals: 5,
	approvalAgeMs: 3 * 60_000,
	cooldownMs: 30 * 60_000,
};

export interface AlertMessage {
	kind: AlertKind;
	recovered: boolean;
	text: string;
}

function minutes(ms: number): string {
	return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

export class AlertMonitor {
	private active = new Map<AlertKind, number>();
	private lastSentAt = new Map<AlertKind, number>();
	private baseline?: { failedFinals: number; compensationErrors: number };

	constructor(private readonly options: AlertOptions = DEFAULT_ALERT_OPTIONS) {}

	/** 评估一份快照，返回需要发出的告警/恢复消息。 */
	evaluate(snapshot: HealthSnapshot): AlertMessage[] {
		// 累计计数只看"新增"：启动时的存量不算（否则每次重启都告一遍历史失败）
		this.baseline ??= { failedFinals: snapshot.failedFinals, compensationErrors: snapshot.compensationErrors };
		const out: AlertMessage[] = [];
		const o = this.options;
		const conditions: Array<[AlertKind, boolean, () => string]> = [
			["disconnected", snapshot.downSince !== undefined && snapshot.now - snapshot.downSince >= o.disconnectMs,
				() => `🔴 飞书桥已断线 ${minutes(snapshot.now - (snapshot.downSince ?? snapshot.now))}，正在自动重连。`],
			["flapping", snapshot.reconnectsLast5m >= o.reconnectsIn5m,
				() => `🟠 飞书桥连接抖动：近 5 分钟重连 ${snapshot.reconnectsLast5m} 次。`],
			["outbox_failed", snapshot.failedFinals > this.baseline.failedFinals,
				() => `🔴 有 ${snapshot.failedFinals - this.baseline!.failedFinals} 条回复永久发送失败（/feishu status 查看原因）。`],
			["approvals_backlog", snapshot.pendingApprovals >= o.pendingApprovals || (snapshot.oldestApprovalAgeMs ?? 0) >= o.approvalAgeMs,
				() => `🟠 审批积压：${snapshot.pendingApprovals} 条待审批${snapshot.oldestApprovalAgeMs ? `，最早一条已等 ${minutes(snapshot.oldestApprovalAgeMs)}` : ""}。`],
			["compensation_failed", snapshot.compensationErrors > this.baseline.compensationErrors,
				() => "🟠 断线补收失败，断线期间的消息可能没有处理（/feishu doctor 查看）。"],
		];
		for (const [kind, firing, text] of conditions) {
			const since = this.active.get(kind);
			if (firing) {
				if (since === undefined) this.active.set(kind, snapshot.now);
				const last = this.lastSentAt.get(kind);
				if (last === undefined || snapshot.now - last >= o.cooldownMs) {
					this.lastSentAt.set(kind, snapshot.now);
					out.push({ kind, recovered: false, text: text() });
				}
			} else if (since !== undefined) {
				this.active.delete(kind);
				// 只对"发过告警"的状态补恢复通知（没发过就没必要说恢复）
				if (this.lastSentAt.has(kind)) {
					this.lastSentAt.delete(kind);
					out.push({ kind, recovered: true, text: `🟢 已恢复：${recoveredLabel(kind)}（持续 ${minutes(snapshot.now - since)}）。` });
				}
				// 累计类告警恢复后重置基线：下一次新增才再告
				if (kind === "outbox_failed") this.baseline.failedFinals = snapshot.failedFinals;
				if (kind === "compensation_failed") this.baseline.compensationErrors = snapshot.compensationErrors;
			}
		}
		// 累计类：告过一次后立即把基线推到当前值（它们不会"自然恢复"）
		if (snapshot.failedFinals > this.baseline.failedFinals && this.lastSentAt.has("outbox_failed")) this.baseline.failedFinals = snapshot.failedFinals;
		if (snapshot.compensationErrors > this.baseline.compensationErrors && this.lastSentAt.has("compensation_failed")) this.baseline.compensationErrors = snapshot.compensationErrors;
		return out;
	}
}

function recoveredLabel(kind: AlertKind): string {
	switch (kind) {
		case "disconnected": return "飞书桥已重新连接";
		case "flapping": return "连接已稳定";
		case "approvals_backlog": return "审批积压已清空";
		case "outbox_failed": return "回复发送恢复正常";
		case "compensation_failed": return "断线补收恢复正常";
	}
}
