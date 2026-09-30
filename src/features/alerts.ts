/**
 * 桥自身告警（`alerts.enabled`，默认关）：每次状态心跳评估一次连接、重连、发送失败、
 * 审批积压与断线补收错误，越过阈值时私聊告警接收人（默认是管理员），恢复时再发一次。
 */
import { effectiveAdmins } from "../inbound/admit.js";
import { AlertMonitor, DEFAULT_ALERT_OPTIONS } from "../runtime/alerts.js";
import type { BridgeFeature } from "./feature.js";

export const alertsFeature: BridgeFeature = {
	name: "alerts",
	enabled: (config) => config.alerts?.enabled === true,
	setup({ rt, log, reconnectsLast5m }) {
		const alerts = rt.config.alerts ?? {};
		const monitor = new AlertMonitor({
			disconnectMs: alerts.disconnectMs ?? DEFAULT_ALERT_OPTIONS.disconnectMs,
			reconnectsIn5m: alerts.reconnectsIn5m ?? DEFAULT_ALERT_OPTIONS.reconnectsIn5m,
			pendingApprovals: alerts.pendingApprovals ?? DEFAULT_ALERT_OPTIONS.pendingApprovals,
			approvalAgeMs: DEFAULT_ALERT_OPTIONS.approvalAgeMs,
			cooldownMs: alerts.cooldownMs ?? DEFAULT_ALERT_OPTIONS.cooldownMs,
		});
		return {
			async onHeartbeat() {
				const messages = monitor.evaluate({
					now: Date.now(),
					downSince: rt.downSince,
					reconnectsLast5m: reconnectsLast5m(),
					failedFinals: rt.outbox?.stats().failed ?? 0,
					pendingApprovals: rt.permissionBridge?.pendingCount() ?? 0,
					oldestApprovalAgeMs: rt.permissionBridge?.oldestPendingAgeMs(),
					compensationErrors: rt.compensationErrors,
				});
				if (messages.length === 0 || !rt.transport?.isConnected()) return;
				const recipients = alerts.recipients?.length ? alerts.recipients : effectiveAdmins(rt.config);
				for (const message of messages) {
					log.warn("feishu.alert", { kind: message.kind, recovered: message.recovered });
					for (const openId of recipients.slice(0, 10)) {
						try { await rt.transport.sendToUser(openId, "text", { text: `[飞书桥] ${message.text}` }); } catch (error) {
							log.warn("feishu.alert.send_failed", { kind: message.kind, error: error instanceof Error ? error.message : String(error) });
						}
					}
				}
			},
		};
	},
};
