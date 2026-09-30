/**
 * PS 父会话转发（`approval.forwarding`，默认关）的起停：
 * - `syncEnv`：声明/撤回「本进程是 PS 的父会话」的环境变量；
 * - `syncServer`：起停转发应答方（把 PS 的 ask 请求文件变成审批卡，点击后写回响应文件）。
 *
 * 两者都是幂等的，启动、停止与配置变更后各调用一次即可。
 */
import { effectiveAdmins } from "../inbound/admit.js";
import { resolvePaths } from "../config.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import { AlwaysApprovedStore } from "./always-approved-store.js";
import { piPermissionSystemInstalled, resolveAgentDir } from "./pi-permission-system.js";
import {
	PS_FORWARDING_PARENT_ENV_KEYS,
	PS_FORWARDING_UPSTREAM_TIMEOUT_MS,
	PsForwardingServer,
	applyPsForwardingParentEnv,
	psForwardingRootDir,
	resolvePsForwardingConfig,
} from "./ps-forwarding.js";

export interface PsForwardingSyncDeps {
	rt: BridgeRuntime;
	log: BridgeLogger;
	/** PS 是否已安装（测试可替换）。 */
	psInstalled?: () => boolean;
	/** pi 配置目录（测试可替换）。 */
	agentDir?: () => string;
}

export class PsForwardingSync {
	private readonly psInstalled: () => boolean;
	private readonly agentDir: () => string;

	constructor(private readonly deps: PsForwardingSyncDeps) {
		this.psInstalled = deps.psInstalled ?? piPermissionSystemInstalled;
		this.agentDir = deps.agentDir ?? resolveAgentDir;
	}

	/** 配置视图（父会话 id 缺省时用固定值；引擎不是 PS 时视为关闭）。 */
	configured(): { enabled: boolean; parentSessionId: string; blockedBy?: "policyEngine" } {
		return resolvePsForwardingConfig(this.deps.rt.config.approval);
	}

	/**
	 * 声明/撤回「本进程是 PS 的父会话」（见 PS_FORWARDING_PARENT_ENV_KEYS）。
	 *
	 * 变量是进程级的（桥与子会话同进程，无法只给子会话设），而效果恰好是我们想要的：
	 * 进程内所有会话的 ask 都转发给桥；真正的发起会话从请求文件的 requesterSessionId 读。
	 * PS 在每次工具调用时实时读环境变量，因此这里在会话创建前设置即可。
	 *
	 * 关闭时必须撤回自己的声明：否则 PS 会把 ask 转发到一个没人收的收件箱，
	 * 子会话要等满 10 分钟才判拒绝（而正确行为是退回到它自己的判定）。
	 */
	syncEnv(): void {
		const { rt, log } = this.deps;
		const { enabled, parentSessionId, blockedBy } = this.configured();
		if (blockedBy) {
			// 开关开了但引擎不是 PS：开启转发只会让同一次调用弹两张卡，这里明确说明。
			log.warn("feishu.approval.ps_forwarding_inactive", {
				reason: "approval.forwarding 仅在 approval.policyEngine=pi-permission-system 时生效",
				policyEngine: rt.config.approval?.policyEngine ?? "bridge",
			});
		}
		const installed = this.psInstalled();
		const active = enabled && installed;
		if (enabled && !installed) {
			// 与 policyEngine 同一套默认拒绝语义：没装成就不做父子声明。
			log.error("feishu.approval.ps_forwarding_unavailable", { expected: "@gotgenes/pi-permission-system" });
		}
		const before = rt.psForwardingOwnEnvId;
		const result = applyPsForwardingParentEnv({ enabled: active, parentSessionId, previousApplied: before });
		rt.psForwardingOwnEnvId = result.appliedValue;
		if (result.appliedValue !== before) {
			log.info("feishu.approval.ps_forwarding_env", {
				state: result.appliedValue ? "declared" : "withdrawn",
				keys: PS_FORWARDING_PARENT_ENV_KEYS,
				parentSessionId,
			});
		}
		if (result.overridden.length > 0) {
			// 外层启动方已经声明过别的父会话：我们覆盖了它。写一条日志，免得排障时想不到。
			log.warn("feishu.approval.ps_forwarding_env_overridden", { overridden: result.overridden, parentSessionId });
		}
	}

	/**
	 * 起停转发应答方。幂等：已起且父会话 id 未变则不动；id 变了则重建
	 * （心跳与收件箱目录都挂在 id 上，不能混用）。
	 *
	 * 必须等 transport/outbox 起来（弹卡要能发出去）且 PermissionBridge 已就位才能起。
	 */
	async syncServer(): Promise<void> {
		const { rt, log } = this.deps;
		const { enabled, parentSessionId } = this.configured();
		if (!enabled || !this.psInstalled() || !rt.permissionBridge) {
			if (rt.psForwarding) {
				await rt.psForwarding.stop();
				rt.psForwarding = undefined;
				rt.psForwardingParentId = undefined;
			}
			return;
		}
		if (rt.psForwarding && rt.psForwardingParentId === parentSessionId) {
			rt.psForwarding.start();
			return;
		}
		if (rt.psForwarding) {
			await rt.psForwarding.stop();
			rt.psForwarding = undefined;
		}
		// 「始终批准」规则表：开启时审批卡多一个 always 按钮，命中规则的请求直接放行。
		// 每轮同步都重建（配置可能被 /feishu policy 之类改过），成本是一次小文件读。
		rt.alwaysApproved = rt.config.approval.forwarding?.alwaysApprove === false
			? undefined
			: new AlwaysApprovedStore({ file: resolvePaths(rt.homeDir).alwaysApprovedFile });
		rt.psForwarding = new PsForwardingServer({
			forwardingDir: psForwardingRootDir(this.agentDir()),
			parentSessionId,
			alwaysApproved: rt.alwaysApproved,
			routeForSessionId: (sessionId) => rt.convManager?.routeForSessionId(sessionId),
			allowedOperatorIds: () => effectiveAdmins(rt.config),
			requestDecision: async (input) => {
				const result = await rt.permissionBridge!.requestExternal(input, {
					// 审批卡等待上限沿用 approval.timeoutMs；但不得越过 PS 自己的转发总超时，
					// 否则我们会在对方已经放弃后才写响应（子会话拿不到，白留一个孤儿文件）。
					timeoutMs: Math.min(rt.config.approval.timeoutMs, PS_FORWARDING_UPSTREAM_TIMEOUT_MS - 30_000),
					auditDecision: "ps_forwarding_ask",
				});
				// operatorId 一并带回：转发路径的「始终批准」要记下是谁放行的。
				return { verdict: result.verdict, choice: result.choice, operatorId: result.operatorId };
			},
			onAudit: (event) => log.info("feishu.approval.ps_forwarding.audit", event),
			log: (level, msg, meta) => log[level](msg, meta),
		});
		rt.psForwardingParentId = parentSessionId;
		rt.psForwarding.start();
	}
}
