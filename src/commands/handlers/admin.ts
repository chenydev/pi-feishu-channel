/**
 * 管理类命令：诊断包导出、群策略、页脚、审批模式、「始终批准」规则、提示词、费用上限。
 * 需要管理员的命令在各自的处理函数里校验（帮助里的 adminOnly 只是标注）。
 */
import type { CommandHandler } from "../dispatch.js";
import type { CommandServices } from "./services.js";
import { formatTimeInZone, resolveFooterEnabled, resolvePaths, saveConfigFields } from "../../config.js";
import { buildDiagnosticsBundle, writeDiagnosticsBundle } from "../../runtime/diagnostics.js";
import { runDoctor } from "../../runtime/doctor.js";
import { APPROVAL_MODE_LABEL, effectiveApprovalMode, globalApprovalMode, parseApprovalMode } from "../../approval/mode.js";
import { piPermissionSystemInstalled, psConfigFile } from "../../approval/pi-permission-system.js";
import { loadPsConfig, summarizeApprovalPolicy } from "../../approval/policy-summary.js";
import { buildConversationKey } from "../../session/conversation-key.js";
import type { FeishuInboundMessage, GroupPolicy } from "../../types.js";
import { splitGlobalFlag } from "./model.js";

export function adminCommands(svc: CommandServices): Record<string, CommandHandler> {
	return {
		"/feishu export": async ({ msg, isAdmin, reply }) => {
			if (!isAdmin) { reply("仅管理员或应用归属人可导出诊断包"); return; }
			try {
				const bundle = buildDiagnosticsBundle({
					config: svc.rt.config, context: svc.diagnosticsContext(),
					checks: runDoctor({ config: svc.rt.config, paths: resolvePaths(svc.rt.homeDir), transport: svc.rt.transport, diagnostics: svc.diagnosticsContext() }),
					redactPaths: [svc.rt.homeDir, resolvePaths(svc.rt.homeDir).sessionDir, process.cwd()],
				});
				const dir = writeDiagnosticsBundle(svc.rt.homeDir, bundle);
				// 同时以文件形式私聊发给操作的管理员（不必再登录宿主机取）
				const sent = await sendDiagnosticsToAdmin(svc, msg.senderId, bundle);
				reply(`已导出脱敏诊断包：${dir}/（0600，仅含计数与枚举；不含密钥、正文与绝对路径）${sent ? "\n已私聊发送给你。" : ""}`);
			} catch (error) {
				reply(`诊断包导出失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`);
			}
		},
		"/feishu policy": ({ msg, args, isAdmin, reply }) => {
			if (!isAdmin) { reply("仅管理员或应用归属人可修改群策略"); return; }
			if (msg.chatType === "p2p") { reply("群策略只能在群聊或话题中修改"); return; }
			const policy = args[0] as GroupPolicy | undefined;
			if (!policy || !VALID_POLICIES.includes(policy)) { reply(`用法：/feishu policy <${VALID_POLICIES.join("|")}>`); return; }
			reply(setChatPolicy(svc, msg.chatId, policy) ? `已设置本群策略：${policy}` : "策略落盘失败，运行态未修改");
		},
		"/feishu footer": ({ msg, args, isAdmin, reply }) => {
			// 页脚是"给人看的元信息"，每个群的信息密度需求不同 —— 交给该群管理员当场决定，
			// 而不是让所有人一起去改配置文件。缺省跟随全局 footer.enabled（默认开）。
			const state = resolveFooterEnabled(svc.rt.config, msg.chatId);
			const action = args[0]?.toLowerCase();
			if (!action) {
				reply([
					`本会话页脚：${state.enabled ? "开" : "关"}（${state.source === "chat" ? "管理员设置" : "全局默认"}）`,
					"用法：/feishu footer off 关闭本会话页脚；/feishu footer on 恢复显示（仅管理员或应用归属人）。",
				].join("\n"));
				return;
			}
			if (action !== "on" && action !== "off") { reply("用法：/feishu footer [on|off]"); return; }
			if (!isAdmin) { reply("仅管理员或应用归属人可修改本会话页脚设置"); return; }
			const wanted = action === "on";
			const previous = svc.rt.config.footerByChat?.[msg.chatId];
			svc.rt.config.footerByChat = { ...(svc.rt.config.footerByChat ?? {}), [msg.chatId]: wanted };
			if (saveConfigFields(svc.rt.homeDir, svc.rt.config, [`footerByChat.${msg.chatId}`])) {
				svc.log.info("feishu.footer.toggled", { chatId: msg.chatId, enabled: wanted, operator: msg.senderId });
				reply(wanted
					? "已开启本会话页脚（模型/耗时/上下文/累计用量/费用）。用 /feishu footer off 可关闭。"
					: "已关闭本会话页脚。用 /feishu footer on 可恢复；/feishu usage 仍可随时查看完整用量。");
			} else {
				// 落盘失败就回滚运行态：否则重启后又变回去，用户以为设置没生效
				if (previous === undefined) delete svc.rt.config.footerByChat[msg.chatId];
				else svc.rt.config.footerByChat[msg.chatId] = previous;
				reply("页脚设置落盘失败，运行态未修改");
			}
		},
		"/feishu approvals": ({ msg, rest, isAdmin, reply }) => {
			reply(approvalsCommand(svc, msg, rest, isAdmin));
		},
		"/feishu always": ({ msg, args, isAdmin, reply }) => {
			// 「始终批准」是持久放行：必须能看、能撤，否则一次点击就等于永久放开一部分审批。
			reply(isAdmin ? alwaysApprovedCommand(svc, args, { prefix: "/feishu always", operator: msg.senderId }) : "仅管理员或应用归属人可查看或撤销「始终批准」规则");
		},
		"/feishu prompt": ({ msg, args, rest, isAdmin, reply }) => {
			reply(handlePromptCommand(svc, msg, args, rest, isAdmin));
		},
		"/feishu budget": ({ msg, args, isAdmin, reply }) => {
			const current = svc.rt.convManager?.budgetStatus(msg.chatId);
			const action = args[0]?.toLowerCase();
			if (!action) {
				reply(current?.limit
					? `本群每日费用上限：$${current.limit}；今日已用 $${current.spent.toFixed(4)}。\n用法：/feishu budget <美元> 设置；/feishu budget off 取消（管理员）。`
					: `本群未设每日费用上限；今日已用 $${(current?.spent ?? 0).toFixed(4)}。\n用法：/feishu budget <美元>（管理员）。`);
				return;
			}
			if (!isAdmin) { reply("仅管理员或应用归属人可设置费用上限"); return; }
			const value = action === "off" ? undefined : Number.parseFloat(action.replace(/^\$/, ""));
			if (value !== undefined && (!Number.isFinite(value) || value <= 0)) { reply("用法：/feishu budget <大于 0 的美元数> | off"); return; }
			const previous = svc.rt.config.groupRules[msg.chatId];
			const next = { ...(previous ?? {}) };
			if (value === undefined) delete next.dailyBudgetUsd;
			else next.dailyBudgetUsd = value;
			svc.rt.config.groupRules[msg.chatId] = next;
			if (saveConfigFields(svc.rt.homeDir, svc.rt.config, [`groupRules.${msg.chatId}.dailyBudgetUsd`])) {
				svc.log.info("feishu.budget.set", { chatId: msg.chatId, value: value ?? null, operator: msg.senderId });
				reply(value === undefined ? "已取消本群每日费用上限。" : `已设置本群每日费用上限：$${value}（超限后新任务暂停到次日，80% 时提醒一次）。`);
			} else {
				if (previous === undefined) delete svc.rt.config.groupRules[msg.chatId];
				else svc.rt.config.groupRules[msg.chatId] = previous;
				reply("预算落盘失败，运行态未修改");
			}
		},
	};
}

/** 可设置的群策略。 */
export const VALID_POLICIES: readonly GroupPolicy[] = ["open", "mention", "disabled", "allowlist", "blacklist", "admin_only"];

/** 设置单群策略（飞书与 TUI 共用；落盘失败回滚运行态 —— 两边语义一致）。 */
export function setChatPolicy(svc: Pick<CommandServices, "rt">, chatId: string, policy: GroupPolicy): boolean {
	const previous = svc.rt.config.groupPolicyByChat[chatId];
	svc.rt.config.groupPolicyByChat[chatId] = policy;
	if (saveConfigFields(svc.rt.homeDir, svc.rt.config, [`groupPolicyByChat.${chatId}`])) return true;
	if (previous === undefined) delete svc.rt.config.groupPolicyByChat[chatId];
	else svc.rt.config.groupPolicyByChat[chatId] = previous;
	return false;
}

/**
 * 「始终批准」查看/撤销 —— 飞书 `/feishu always` 与 TUI `/feishu:always` 共用一份逻辑，
 * 不要各写一份（文案与撤销语义会不一致）。身份校验由调用方负责。
 */
export function alwaysApprovedCommand(svc: Pick<CommandServices, "rt" | "log">, args: string[], opts: { prefix: string; operator?: string }): string {
	if (!svc.rt.alwaysApproved) return "「始终批准」未启用（需要 pi-permission-system 转发模式）";
	if (args[0]?.toLowerCase() === "revoke") {
		const pattern = args.slice(1).join(" ").trim();
		if (!pattern) return `用法：${opts.prefix} revoke <规则名>（规则名见 ${opts.prefix}）`;
		const removed = svc.rt.alwaysApproved.remove(pattern);
		svc.log.info("feishu.approval.always_revoked", { pattern, removed, operator: opts.operator ?? "tui" });
		return removed ? `已撤销规则「${pattern}」—— 下次同类请求会重新弹卡。` : `没有找到规则「${pattern}」。`;
	}
	const rules = svc.rt.alwaysApproved.list();
	if (rules.length === 0) return "当前没有「始终批准」的规则（所有 ask 都会弹卡）。";
	const lines = rules.map((rule) => `· ${rule.pattern}（${formatTimeInZone(rule.approvedAt, svc.rt.config.timezone)}${rule.approvedBy ? ` · ${rule.approvedBy}` : ""}）`);
	return [`「始终批准」规则共 ${rules.length} 条：`, ...lines, `用 ${opts.prefix} revoke <规则名> 撤销。`].join("\n");
}

/** `/feishu prompt [show|set <内容>|clear]` —— 群里改本群设定（管理员），私聊改个人偏好（本人）。 */
function handlePromptCommand(svc: CommandServices, msg: FeishuInboundMessage, args: string[], rest: string, isAdmin: boolean): string {
	const personal = msg.chatType === "p2p";
	const action = args[0]?.toLowerCase() ?? "show";
	const current = personal ? svc.rt.config.userPrompts?.[msg.senderId] : svc.rt.config.groupRules[msg.chatId]?.prompt;
	const scope = personal ? "你的个人提示词" : "本群提示词";
	if (action === "show") {
		return current
			? `${scope}：\n${current}\n\n/feishu prompt set <内容> 修改；/feishu prompt clear 清除。`
			: `${scope}未设置。/feishu prompt set <内容> 设置（${personal ? "只影响你的私聊" : "管理员；会话首轮注入，/new 后对新会话生效"}）。`;
	}
	if (action !== "set" && action !== "clear") return "用法：/feishu prompt [show|set <内容>|clear]";
	if (!personal && !isAdmin) return "仅管理员或应用归属人可修改本群提示词";
	const text = action === "set" ? rest.replace(/^set\s*/i, "").trim() : "";
	if (action === "set" && !text) return "用法：/feishu prompt set <内容>";
	if (text.length > 2_000) return "提示词过长（最多 2000 字）";
	if (personal) {
		const previous = svc.rt.config.userPrompts?.[msg.senderId];
		const next = { ...(svc.rt.config.userPrompts ?? {}) };
		if (text) next[msg.senderId] = text;
		else delete next[msg.senderId];
		svc.rt.config.userPrompts = next;
		if (!saveConfigFields(svc.rt.homeDir, svc.rt.config, [`userPrompts.${msg.senderId}`])) {
			if (previous === undefined) delete svc.rt.config.userPrompts[msg.senderId];
			else svc.rt.config.userPrompts[msg.senderId] = previous;
			return "提示词落盘失败，运行态未修改";
		}
	} else {
		const previous = svc.rt.config.groupRules[msg.chatId];
		const next = { ...(previous ?? {}) };
		if (text) next.prompt = text;
		else delete next.prompt;
		svc.rt.config.groupRules[msg.chatId] = next;
		if (!saveConfigFields(svc.rt.homeDir, svc.rt.config, [`groupRules.${msg.chatId}.prompt`])) {
			if (previous === undefined) delete svc.rt.config.groupRules[msg.chatId];
			else svc.rt.config.groupRules[msg.chatId] = previous;
			return "提示词落盘失败，运行态未修改";
		}
	}
	svc.log.info("feishu.prompt.updated", { scope: personal ? "user" : "chat", chatId: msg.chatId, operator: msg.senderId, cleared: !text });
	return text ? `已更新${scope}（下一轮起生效）。` : `已清除${scope}。`;
}

/** 诊断包以文件形式私聊给管理员。 */
async function sendDiagnosticsToAdmin(svc: CommandServices, openId: string, bundle: unknown): Promise<boolean> {
	if (!svc.rt.transport) return false;
	try {
		const fileKey = await svc.rt.transport.uploadFile(`feishu-channel-diagnostics-${Date.now()}.json`, Buffer.from(JSON.stringify(bundle, null, 2), "utf8"));
		await svc.rt.transport.sendToUser(openId, "file", { file_key: fileKey });
		return true;
	} catch (error) {
		svc.log.warn("feishu.diagnostics.dm_failed", { error: error instanceof Error ? error.message : String(error) });
		return false;
	}
}

/**
 * `/feishu approvals [off|builtin|plugin|reset] [-g]`：不带参数查看当前会话生效的审批策略（任何人）；
 * 带模式只改本会话（内存，重启失效）；`-g` 写进 config.json 并清掉本会话的临时设置；`reset` 回到全局设置。
 */
function approvalsCommand(svc: CommandServices, msg: FeishuInboundMessage, rest: string, isAdmin: boolean): string {
	const { rt, log } = svc;
	const key = buildConversationKey(msg, rt.config);
	const { wantsGlobal, value } = splitGlobalFlag(rest);
	if (!value && !wantsGlobal) {
		return summarizeApprovalPolicy({
			config: rt.config,
			mode: effectiveApprovalMode(rt.config, rt.approvalModeOverrides, key),
			ps: loadPsConfig(psConfigFile()),
			psInstalled: piPermissionSystemInstalled(),
			...(rt.alwaysApproved ? { alwaysRules: rt.alwaysApproved.list() } : {}),
			pendingApprovals: rt.permissionBridge?.pendingCount() ?? 0,
		});
	}
	const usage = "用法：/feishu approvals [off|builtin|plugin] [-g]；/feishu approvals reset";
	if (!isAdmin) return "仅管理员或应用归属人可切换审批模式";
	if (value.toLowerCase() === "reset" && !wantsGlobal) {
		const had = rt.approvalModeOverrides.delete(key);
		log.info("feishu.approval.mode_changed", { scope: "session", mode: null, conversationKey: key, operator: msg.senderId });
		const global = globalApprovalMode(rt.config);
		return `${had ? "已清除本会话的临时设置" : "本会话没有临时设置"}，当前按全局：${APPROVAL_MODE_LABEL[global.mode]}`;
	}
	const mode = parseApprovalMode(value);
	if (!mode) return usage;
	const notes: string[] = [];
	if (mode !== "off" && !rt.permissionBridge) notes.push("⚠️ 桥未启动，审批暂不生效");
	if (mode === "plugin" && !piPermissionSystemInstalled()) notes.push("⚠️ pi-permission-system 未安装，实际按内置审批执行");
	if (mode === "off" && piPermissionSystemInstalled()) notes.push("⚠️ 已安装 pi-permission-system：它的规则仍会独立生效，本扩展关不掉");
	if (!wantsGlobal) {
		rt.approvalModeOverrides.set(key, mode);
		log.info("feishu.approval.mode_changed", { scope: "session", mode, conversationKey: key, operator: msg.senderId });
		// 转发是进程级的，只跟全局模式走
		if (mode === "plugin" && globalApprovalMode(rt.config).mode !== "plugin") notes.push("父会话转发只跟全局模式走：插件的「询问」在本会话没人应答，会被拒绝");
		return [`本会话审批模式：${APPROVAL_MODE_LABEL[mode]}（临时，重启后失效；加 -g 写入配置）`, ...notes].join("\n");
	}
	const previous = rt.config.approval.mode;
	rt.config.approval.mode = mode;
	if (!saveConfigFields(rt.homeDir, rt.config, ["approval.mode"])) {
		rt.config.approval.mode = previous;
		return "审批模式写入配置失败，运行态未修改";
	}
	rt.approvalModeOverrides.delete(key);
	log.info("feishu.approval.mode_changed", { scope: "global", mode, operator: msg.senderId });
	const effective = globalApprovalMode(rt.config);
	if (effective.source === "env") notes.push(`⚠️ 环境变量 FEISHU_CHANNEL_APPROVAL_MODE 优先，当前实际仍是：${APPROVAL_MODE_LABEL[effective.mode]}`);
	if (mode === "plugin" || previous === "plugin") notes.push("父会话转发的开关重启后才跟着变");
	return [`已写入配置：审批模式 ${APPROVAL_MODE_LABEL[mode]}（全局，立即生效；其他会话的临时设置不受影响）`, ...notes].join("\n");
}
