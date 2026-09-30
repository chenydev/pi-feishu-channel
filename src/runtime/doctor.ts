import { accessApproverHint, accessApproverPolicy, accessApprovers, roleCounts } from "./admin-roles.js";
import { accessSync, constants, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { BridgeConfig } from "../types.js";
import type { ConfigPaths } from "../config.js";
import { effectiveAdmins } from "../inbound/admit.js";
import { existsSync as fileExists, readFileSync, statSync } from "node:fs";
import { unknownConfigFields } from "../config/schema.js";
import { enabledFeatures } from "../features/switches.js";

export interface DoctorCheck { name: string; ok: boolean; detail: string }

function writable(path: string): boolean {
	const probe = join(path, `.feishu-doctor-${process.pid}-${randomUUID()}.tmp`);
	try {
		accessSync(path, constants.W_OK);
		const fd = openSync(probe, "wx", 0o600);
		closeSync(fd);
		unlinkSync(probe);
		return true;
	} catch {
		try { unlinkSync(probe); } catch { /* best effort */ }
		return false;
	}
}

export function runDoctor(input: {
	config: BridgeConfig;
	paths: ConfigPaths;
	transport?: { isRunning(): boolean; isConnected(): boolean; getBotIdentity(): { openId?: string } };
	/** 诊断上下文（缺省时相关项写「未验证」，而不是假通过）。 */
	diagnostics?: {
		lastErrorClass?: string;
		outbox?: { pending: number; failed: number; oldestAgeMs?: number };
		pendingApprovals?: number;
		budget?: { open: boolean; resumeAt?: number; failures: number };
		piVersion?: string;
		/** 近 5 分钟重连次数（≥10 视为抖动）。 */
		reconnectsLast5m?: number;
		/** 心跳间隔（0 = 关闭；status.json 的 mtime 判据据此给出）。 */
		statusHeartbeatMs?: number;
		now?: number;
		/**
		 * PS 父会话转发状态。缺省（无 forwarder）时写「未验证」，而不是假装通过 ——
		 * 与诊断的其它检查项同一约定。
		 */
		forwarding?: {
			enabled: boolean;
			parentSessionId?: string;
			/** 心跳文件是否新鲜（父会话在服务）。 */
			serving?: boolean;
			/** 「始终批准」规则数 + 规则名（便于发现"谁把闸门挖空了"）。 */
			alwaysApproved?: { count: number; patterns: string[]; enabled: boolean };
		};
	};
}): DoctorCheck[] {
	const outboxParent = dirname(input.paths.outboxFile);
	const diag = input.diagnostics;
	const backlogLines: DoctorCheck[] = [];
	if (diag?.outbox) {
		const { pending, failed, oldestAgeMs } = diag.outbox;
		backlogLines.push({
			name: "backlog",
			ok: failed === 0,
			detail: `pending ${pending} / failed ${failed} / oldest ${Math.round((oldestAgeMs ?? 0) / 1000)}s`,
		});
	}
	if (diag) {
		backlogLines.push({
			name: "error_state",
			ok: !diag.lastErrorClass,
			detail: diag.lastErrorClass ? `最近错误类别：${diag.lastErrorClass}` : "无未处理错误",
		});
		if (diag.budget) {
			backlogLines.push({
				name: "rate_budget",
				ok: !diag.budget.open,
				detail: diag.budget.open
					? `限流冷却中（连续失败 ${diag.budget.failures}，恢复约 ${Math.max(0, Math.round((diag.budget.resumeAt ?? 0) - Date.now()) / 1000)}s；final/审批不受影响）`
					: `正常（连续失败 ${diag.budget.failures}）`,
			});
		}
		backlogLines.push({
			name: "pending_work",
			ok: (diag.pendingApprovals ?? 0) === 0,
			detail: diag.pendingApprovals ? `${diag.pendingApprovals} 个审批等待处理` : "无待审批",
		});
	}
	// PS 父会话转发（<agentDir>/sessions/permission-forwarding/）与桥自己的状态目录分属
	// 两个根，出问题时容易看错地方 —— 所以在这里显式列出来。
	const forwardingLines: DoctorCheck[] = [];
	if (diag?.forwarding) {
		const f = diag.forwarding;
		forwardingLines.push({
			name: "ps_forwarding",
			ok: !f.enabled || f.serving !== false,
			detail: !f.enabled
				? "未启用（PS 的 ask 将无人应答 → 子会话判拒绝）"
				: `已启用 · 父会话 ${f.parentSessionId ?? "?"} · ${f.serving === false ? "⚠️ 心跳缺失/过期（子会话会判父会话不在服务）" : "心跳正常"}`,
		});
		if (f.enabled && f.alwaysApproved) {
			const a = f.alwaysApproved;
			forwardingLines.push({
				name: "ps_always_approved",
				ok: true,
				detail: !a.enabled
					? "「始终批准」已关闭"
					: a.count === 0
						? "「始终批准」已开启，当前无放行规则"
						: `「始终批准」放行 ${a.count} 条规则：${a.patterns.slice(0, 3).join("、")}${a.count > 3 ? " …" : ""}`,
			});
		}
	}

	// status.json 心跳新鲜度 —— 健康的桥每 30s 刷一次，mtime 超过 3 个周期就是桥停了（或卡住了）
	const statusLines: DoctorCheck[] = [];
	const heartbeat = diag?.statusHeartbeatMs ?? 30_000;
	if (diag && heartbeat > 0 && fileExists(input.paths.statusFile)) {
		try {
			const ageMs = (diag.now ?? Date.now()) - statSync(input.paths.statusFile).mtimeMs;
			const limit = Math.max(90_000, heartbeat * 3);
			statusLines.push({ name: "status_heartbeat", ok: ageMs <= limit, detail: `status.json ${Math.round(ageMs / 1000)}s 前更新（判据 ≤ ${Math.round(limit / 1000)}s）` });
		} catch { /* 读不到就不报 */ }
	}
	if (diag?.reconnectsLast5m !== undefined) {
		statusLines.push({
			name: "connection_stability",
			ok: diag.reconnectsLast5m < 10,
			detail: diag.reconnectsLast5m >= 10 ? `连接抖动：近 5 分钟重连 ${diag.reconnectsLast5m} 次` : `近 5 分钟重连 ${diag.reconnectsLast5m} 次`,
		});
	}
	// 配置文件里桥不认识的字段（多半是拼错了，静默不生效）
	if (fileExists(input.paths.configFile)) {
		try {
			const unknown = unknownConfigFields(JSON.parse(readFileSync(input.paths.configFile, "utf8")));
			statusLines.push({
				name: "config_fields",
				ok: unknown.length === 0,
				detail: unknown.length ? `不认识的字段（拼错了？）：${unknown.slice(0, 8).join("、")}${unknown.length > 8 ? " …" : ""}` : "全部字段可识别",
			});
		} catch { statusLines.push({ name: "config_fields", ok: false, detail: "config.json 不是合法 JSON" }); }
	}

	return [
		...forwardingLines,
		...statusLines,
		{ name: "credentials", ok: Boolean(input.config.appId && input.config.appSecret), detail: input.config.appId && input.config.appSecret ? "已配置" : "缺少 appId/appSecret" },
		{ name: "transport", ok: Boolean(input.transport?.isRunning()), detail: input.transport?.isConnected() ? "WS 已连接" : input.transport?.isRunning() ? "运行中但未连接" : "未启动" },
		{ name: "bot_identity", ok: Boolean(input.transport?.getBotIdentity().openId), detail: input.transport?.getBotIdentity().openId ? "已水合" : "未取得 open_id" },
		{ name: "session_dir", ok: existsSync(input.paths.sessionDir) && writable(input.paths.sessionDir), detail: input.paths.sessionDir },
		{ name: "outbox_dir", ok: existsSync(outboxParent) && writable(outboxParent), detail: outboxParent },
		// 必须看「有效管理员」= 显式 admins + 启动时水合的归属人/协作者。
		// 只看 config.admins 会误报：admins 常常是空的（本来就靠归属人水合撑着），
		// 而判定链全部走 effectiveAdmins —— 只看 admins 会谎报"审批将 fail closed"，
		// 实际审批卡是点得动的。
		(() => {
			const effective = effectiveAdmins(input.config);
			const counts = roleCounts(input.config, effective);
			return {
				name: "permissions",
				ok: effective.length > 0,
				detail: effective.length > 0
					? `可审批 ${effective.length} 人：应用归属人 ${counts.owner} · 应用协作者 ${counts.collaborator} · 管理员（config.admins）${counts.admin}`
					: "没有任何管理员（显式与隐式都为空）—— 审批卡将无人能点（fail closed）。"
						+ "请确认应用归属人能水合（需要 application:application:readonly scope），或在 config.json 的 admins 里显式配置。",
			};
		})(),
		// 开通申请开启时：按 accessApprovers 必须至少有一个能审批的人，否则申请无人可批
		...(input.config.onboarding?.accessRequest ? [(() => {
			const policy = accessApproverPolicy(input.config.onboarding?.accessApprovers);
			const approvers = accessApprovers(input.config, effectiveAdmins(input.config), policy);
			return {
				name: "access_approvers",
				ok: approvers.length > 0,
				detail: approvers.length > 0
					? `群开通审批：${accessApproverHint(policy)}（${approvers.length} 人）`
					: `群开通审批策略为「${accessApproverHint(policy)}」，但没有符合的人 —— 开通申请无人可批。检查归属人水合，或放宽 onboarding.accessApprovers`,
			};
		})()] : []),
		// 权限范围在未实际探测前写「未验证」，不假装通过，也不自动发送测试消息
		{ name: "feishu_scopes", ok: false, detail: "未验证（需要真实调用才能确认租户权限；本诊断不会发送测试消息）" },
		// 信息项，不判对错：列出打开了哪些默认关闭的能力
		(() => {
			const features = enabledFeatures(input.config);
			return { name: "features", ok: true, detail: features.length ? `已启用：${features.join("、")}` : "无（全部为默认关闭）" };
		})(),
		{ name: "runtime", ok: true, detail: input.diagnostics?.piVersion ? `Pi ${input.diagnostics.piVersion}` : "Pi 版本未提供" },
		...backlogLines,
	];
}

export function formatDoctor(checks: DoctorCheck[]): string {
	return ["飞书桥诊断：", ...checks.map((check) => `${check.ok ? "✅" : "❌"} ${check.name}: ${check.detail}`)].join("\n");
}
