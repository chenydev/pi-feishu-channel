/**
 * 工具调用的审批检查（外层 tool_call 与子会话内联扩展共用同一个实现，
 * 避免「组件有实现但运行时没接上」）。返回 `{ block, reason }` 时阻断执行。
 *
 * 判定顺序：
 * 1. 桥未启动（没有 PermissionBridge）→ 不拦截；
 * 2. 管理员免审（`approval.adminSkipApproval`）；
 * 3. 策略交给 PS（`approval.policyEngine=pi-permission-system`）且 PS 已安装 → 放行；PS 缺席则继续用桥的策略；
 * 4. bash 命令分级：只读免审、危险直接拒绝、其余带理由弹卡；
 * 5. PermissionBridge 的自动放行规则 / 审批卡。
 */
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import { effectiveAdmins } from "../inbound/admit.js";
import type { BridgeGateInput } from "../session/pi-bridge-hooks.js";
import { classifyCommand } from "./command-policy.js";
import { piPermissionSystemInstalled } from "./pi-permission-system.js";

export type ToolGateResult = { block?: boolean; reason?: string } | undefined;

export interface ToolGateDeps {
	rt: BridgeRuntime;
	log: BridgeLogger;
	/** PS 是否已安装（测试可替换）。 */
	psInstalled?: () => boolean;
}

export function createToolGate({ rt, log, psInstalled = piPermissionSystemInstalled }: ToolGateDeps): (input: BridgeGateInput) => Promise<ToolGateResult> {
	return async (input) => {
		if (!rt.permissionBridge) return undefined;
		// 管理员/归属人免审批（approval.adminSkipApproval=true 时生效）。
		// 必须用显式传入的 senderId：conversationKey 只在「群聊+按人隔离」形态下带用户 ID，
		// 话题（`oc:t:th`）与私聊（裸 `oc`）都取不到。
		if (rt.config.approval?.adminSkipApproval) {
			const sender = input.senderId;
			if (sender && effectiveAdmins(rt.config).includes(sender)) {
				log.info("feishu.approval.admin_skip", { toolName: input.toolName, conversationKey: input.conversationKey });
				return undefined;
			}
		}

		// 把策略交给 PS：它的 tool_call 拦截在桥之前执行，deny 时桥的 handler 根本不会被调用
		// （实测：PS 先 → 桥后，首个 block 立即返回）。因此桥这一步只需"放行自己不再判断"。
		//
		// PS 的 ask **不经过这里** —— 走 approval.forwarding（PS 的父会话转发）：桥当应答方，
		// 把请求文件变成审批卡（见 ps-forwarding.ts）。所以这里继续直接放行，不能改成落到桥的弹卡逻辑：
		// PS 放行后本函数会被再调用一次，那时再弹一张卡就是对同一次调用弹两次卡（两次判定还可能不一致）。
		if (rt.config.approval?.policyEngine === "pi-permission-system") {
			if (psInstalled()) return undefined;
			// 默认拒绝：扩展没装成 → 桥的审批是唯一防线，绝不能同时关掉
			log.error("feishu.approval.policy_engine_unavailable", { expected: "@gotgenes/pi-permission-system", fallback: "bridge" });
		}

		// 命令级策略：只读命令免审、危险命令直接拒绝，其余才弹卡。
		// 没有这一层时 bash 只能「全审」—— 每个 ls 都要点一次审批，用户会无脑点批准，审批就失去意义。
		if (input.toolName === "bash" && rt.config.approval?.commandPolicy?.enabled) {
			// 必须用原始命令：展示用的 paramsText 已打码并截断，危险部分可能恰好落在截断位置之后
			const command = input.command;
			if (command) {
				const verdict = classifyCommand(command, rt.config.approval.commandPolicy);
				if (verdict.verdict === "allow") {
					log.info("feishu.approval.command_allow", { reason: verdict.reason, chatId: input.chatId });
					return undefined;
				}
				if (verdict.verdict === "deny") {
					log.warn("feishu.approval.command_deny", { reason: verdict.reason, chatId: input.chatId });
					// 直接拒绝，不弹卡：避免"手滑点批准"执行破坏性命令
					return { block: true, reason: `该命令被安全策略拒绝：${verdict.reason}。如确需执行，请人工在宿主机操作。` };
				}
				log.info("feishu.approval.command_ask", { reason: verdict.reason, chatId: input.chatId });
				// 把判定理由带进卡片，让审批人知道"为什么这条命令需要批"，而不是只看到一个命令。
				input.reason = verdict.reason;
			}
		}
		const result = await rt.permissionBridge.gate(input);
		if (result.decision === "allow") return undefined;
		if (result.decision === "deny") return { block: true, reason: "工具调用被策略拒绝" };
		const verdict = await result.verdict;
		if (verdict === "approved") return undefined;
		return { block: true, reason: verdict === "timeout" ? "飞书审批超时，已拒绝" : "飞书审批已拒绝" };
	};
}
