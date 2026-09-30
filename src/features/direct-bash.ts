/**
 * 管理员直接执行命令（`directBash.enabled`，默认关）：在聊天里发 `!<命令>`，不经过模型直接执行。
 *
 * 直接执行不经过工具调用的审批检查，所以这里自己把关：仅管理员；桥的命令分级与
 * pi-permission-system 的 bash 规则任一判拒绝就拒绝；需要审批的命令默认也拒绝（请让 agent 执行，走审批卡）；
 * 每次执行都写审计日志 `feishu.direct_bash.audit`。关闭时 `!<命令>` 当普通消息交给模型。
 */
import { classifyCommand } from "../approval/command-policy.js";
import { redactParams } from "../approval/permission-bridge.js";
import { psConfigFile } from "../approval/pi-permission-system.js";
import { loadPsConfig, psBashVerdict } from "../approval/policy-summary.js";
import { DIRECT_BASH_PREFIX } from "../commands/registry.js";
import { effectiveAdmins } from "../inbound/admit.js";
import type { FeishuInboundMessage } from "../types.js";
import type { BridgeFeature, FeatureContext } from "./feature.js";

export const directBashFeature: BridgeFeature = {
	name: "directBash",
	enabled: (config) => config.directBash?.enabled === true,
	setup(ctx) {
		return {
			commandInterceptor: async (msg) => {
				const raw = msg.text.trim();
				if (!raw.startsWith(DIRECT_BASH_PREFIX)) return false;
				await handleDirectBash(ctx, msg, raw.slice(DIRECT_BASH_PREFIX.length).trim());
				return true;
			},
		};
	},
};

/**
 * `!<命令>` 直接执行。executeBash 不经过 tool_call 拦截，所以桥自己把关：
 * 仅管理员；桥的命令分级 + PS 的 bash 规则，任一 deny 直接拒绝；ask 默认也拒绝（请让 agent 执行以走审批卡）；
 * 每次执行都写审计日志。
 */
async function handleDirectBash(ctx: FeatureContext, msg: FeishuInboundMessage, command: string): Promise<void> {
	const { rt, log } = ctx;
	const { reply } = ctx.replier(msg);
	const audit = (outcome: string, extra: Record<string, unknown> = {}) => log.info("feishu.direct_bash.audit", {
		outcome, chatId: msg.chatId, operator: msg.senderId, command: redactParams({ command }, "bash").slice(0, 300), ...extra,
	});
	if (!command) { reply("用法：!<命令>，例如 !git status"); return; }
	if (!effectiveAdmins(rt.config).includes(msg.senderId)) { audit("rejected_not_admin"); reply("直接执行命令仅限管理员"); return; }
	if (rt.config.directBash?.p2pOnly && msg.chatType !== "p2p") { audit("rejected_not_p2p"); reply("直接执行命令只能在私聊里使用"); return; }
	const bridgeVerdict = classifyCommand(command, rt.config.approval.commandPolicy);
	const psVerdict = rt.config.approval.policyEngine === "pi-permission-system" ? psBashVerdict(loadPsConfig(psConfigFile()), command) : undefined;
	if (bridgeVerdict.verdict === "deny" || psVerdict?.verdict === "deny") {
		audit("denied", { reason: bridgeVerdict.verdict === "deny" ? bridgeVerdict.reason : `PS 规则 ${psVerdict?.rule}` });
		reply(`已拒绝：${bridgeVerdict.verdict === "deny" ? bridgeVerdict.reason : `命中禁止规则「${psVerdict?.rule}」`}`);
		return;
	}
	const needsApproval = bridgeVerdict.verdict === "ask" || psVerdict?.verdict === "ask";
	if (needsApproval && !rt.config.directBash?.allowAsk) {
		audit("rejected_needs_approval", { reason: bridgeVerdict.reason });
		reply(`该命令需要审批（${bridgeVerdict.verdict === "ask" ? bridgeVerdict.reason : `PS 规则 ${psVerdict?.rule}`}），直接执行只放行免审命令。\n可以让 agent 执行它（会弹审批卡），例如：用 bash 执行 ${command.slice(0, 80)}`);
		return;
	}
	const result = await rt.convManager?.runDirectBash(msg, command, rt.config.directBash?.timeoutMs ?? 60_000);
	if (!result) { reply("会话不可用"); return; }
	if (!result.ok) { audit("failed", { reason: result.reason }); reply(result.reason); return; }
	audit("executed", { exitCode: result.exitCode ?? null, cancelled: result.cancelled, timedOut: result.timedOut });
	const status = result.timedOut ? "⏱ 超时已中止" : result.cancelled ? "⏹ 已中止" : result.exitCode === 0 ? "✅ exit 0" : `⚠️ exit ${result.exitCode ?? "?"}`;
	const output = result.output.trimEnd() || "（无输出）";
	const limit = 3_500;
	const shown = output.length > limit ? `…（前面省略 ${output.length - limit} 字）\n${output.slice(-limit)}` : output;
	reply(`$ ${command.slice(0, 200)}\n${status}${result.truncated ? "（输出已被截断）" : ""}\n\`\`\`\n${shown}\n\`\`\``);
}
