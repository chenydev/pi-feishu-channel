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
import { describeApprovalMode, globalApprovalMode } from "../approval/mode.js";
import { PS_LINK_NAME, PS_MIN_VERSION, type PsLinkStatus } from "../approval/pi-permission-system.js";

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
		 * pi-permission-system 授权链环节（全局模式为 pi-permission-system 时才有）。
		 * 环节没生效时 PS 的「询问」一律被拒绝，而桥这边看不到任何调用，所以要在这里说清。
		 */
		psLink?: PsLinkStatus & {
			/** 已挂上环节的会话数。 */
			registered: number;
			/** 「始终批准」规则数 + 规则名（便于发现"谁把审批放开了"）；功能关闭时缺省。 */
			alwaysApproved?: { count: number; patterns: string[] };
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
	const psLines: DoctorCheck[] = [];
	if (diag?.psLink) {
		const link = diag.psLink;
		const problems = [
			!link.installed ? "未安装（会退回内置审批）" : undefined,
			link.installed && !link.versionOk ? `版本 ${link.version} 过低（需要 ≥ ${PS_MIN_VERSION}）` : undefined,
			link.installed && !link.inChain ? `authorizerChain 里没有 ${PS_LINK_NAME}（它的「询问」会被一律拒绝）` : undefined,
		].filter(Boolean);
		psLines.push({
			name: "ps_link",
			ok: problems.length === 0,
			detail: problems.length > 0
				? `pi-permission-system：${problems.join("；")}`
				: `pi-permission-system ${link.version} · authorizerChain 已包含 ${PS_LINK_NAME} · 已挂到 ${link.registered} 个会话`,
		});
		if (link.alwaysApproved) {
			const a = link.alwaysApproved;
			psLines.push({
				name: "ps_always_approved",
				ok: true,
				detail: a.count === 0
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
		...psLines,
		...statusLines,
		{ name: "credentials", ok: Boolean(input.config.appId && input.config.appSecret), detail: input.config.appId && input.config.appSecret ? "已配置" : "缺少 appId/appSecret" },
		{ name: "transport", ok: Boolean(input.transport?.isRunning()), detail: input.transport?.isConnected() ? "WS 已连接" : input.transport?.isRunning() ? "运行中但未连接" : "未启动" },
		{ name: "bot_identity", ok: Boolean(input.transport?.getBotIdentity().openId), detail: input.transport?.getBotIdentity().openId ? "已获取" : "未取得 open_id" },
		{ name: "session_dir", ok: existsSync(input.paths.sessionDir) && writable(input.paths.sessionDir), detail: input.paths.sessionDir },
		{ name: "outbox_dir", ok: existsSync(outboxParent) && writable(outboxParent), detail: outboxParent },
		// 必须看「有效管理员」= 显式 admins + 启动时从开放平台查到的归属人/应用管理员。
		// 只看 config.admins 会误报：admins 常常是空的（本来就靠启动时自动查到的归属人），
		// 而判定链全部走 effectiveAdmins —— 只看 admins 会谎报"审批将默认拒绝"，
		// 实际审批卡是点得动的。
		(() => {
			const effective = effectiveAdmins(input.config);
			const counts = roleCounts(input.config, effective);
			return {
				name: "permissions",
				ok: effective.length > 0,
				detail: effective.length > 0
					? `可审批 ${effective.length} 人：应用归属人 ${counts.owner} · 应用管理员 ${counts.app_admin} · 管理员（config.admins）${counts.admin}`
					: "没有任何管理员（显式与隐式都为空）—— 审批卡将无人能点（默认拒绝）。"
						+ "请确认能查到应用归属人（需要 application:application:readonly scope），或在 config.json 的 admins 里显式配置。",
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
					: `群开通审批策略为「${accessApproverHint(policy)}」，但没有符合的人 —— 开通申请无人可批。检查是否查到了应用归属人，或放宽 onboarding.accessApprovers`,
			};
		})()] : []),
		// 权限范围在未实际探测前写「未验证」，不假装通过，也不自动发送测试消息
		{ name: "feishu_scopes", ok: false, detail: "未验证（需要真实调用才能确认租户权限；本诊断不会发送测试消息）" },
		// 信息项，不判对错：列出打开了哪些默认关闭的能力
		(() => {
			const features = enabledFeatures(input.config);
			return { name: "features", ok: true, detail: features.length ? `已启用：${features.join("、")}` : "无（全部为默认关闭）" };
		})(),
		// 信息项：全局审批模式（会话里的临时设置看 /feishu approvals）
		(() => {
			const approval = globalApprovalMode(input.config);
			return { name: "approval_mode", ok: true, detail: `全局：${describeApprovalMode(approval)}${approval.mode === "off" ? "，工具调用全部直接放行" : ""}` };
		})(),
		{ name: "runtime", ok: true, detail: input.diagnostics?.piVersion ? `Pi ${input.diagnostics.piVersion}` : "Pi 版本未提供" },
		...backlogLines,
	];
}

/**
 * 诊断报告。
 *
 * `detail: false` 是给**非管理员**看的：检查项的 detail 里有宿主绝对路径、配置字段名、
 * 放行规则名（`session_dir`、`ps_always_approved` 等），不该给群里任何被准入的人看到。
 * 结论（哪项异常）仍然给，附一句「详情请管理员看」。
 */
export function formatDoctor(checks: DoctorCheck[], options: { detail?: boolean } = {}): string {
	if (options.detail === false) {
		const failed = checks.filter((check) => !check.ok);
		return [
			"飞书桥诊断：",
			...checks.map((check) => `${check.ok ? "✅" : "❌"} ${check.name}`),
			...(failed.length > 0 ? [`\n有 ${failed.length} 项异常，详情请管理员发送 /feishu doctor`] : []),
		].join("\n");
	}
	return ["飞书桥诊断：", ...checks.map((check) => `${check.ok ? "✅" : "❌"} ${check.name}: ${check.detail}`)].join("\n");
}
