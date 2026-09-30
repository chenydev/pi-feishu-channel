/**
 * 查看类命令：帮助、状态、诊断、审批策略、用量。
 */
import type { CommandHandler } from "../dispatch.js";
import type { CommandServices } from "./services.js";
import { loadPsConfig, summarizeApprovalPolicy } from "../../approval/policy-summary.js";
import { piPermissionSystemInstalled, psConfigFile } from "../../approval/pi-permission-system.js";
import { formatTimeInZone, resolvePaths } from "../../config.js";
import { formatUsageWeek } from "../../runtime/usage-ledger.js";
import { formatDoctor, runDoctor } from "../../runtime/doctor.js";
import { buildHelpCard } from "../cards.js";
import { COMMANDS, formatHelpText } from "../registry.js";
import { buildUsageCard, formatUsageReport } from "../usage-card.js";

export function infoCommands(svc: CommandServices): Record<string, CommandHandler> {
	return {
		"/help": async ({ isAdmin, reply, trySendCard, buttonCtx }) => {
			const piCommands = svc.piCommands();
			if (await trySendCard(buildHelpCard({ ...buttonCtx, isAdmin, piCommands, directBash: Boolean(svc.rt.config.directBash?.enabled) }), "help")) return;
			reply(formatHelpText(COMMANDS, { piCommands: piCommands.filter((command) => command.source !== "extension") }));
		},
		"/feishu status": ({ msg, reply }) => {
			reply(`${svc.statusText()}\n本群工具档位: ${svc.rt.convManager?.toolPolicyFor(msg.chatId) ?? "?"}`);
		},
		"/feishu doctor": ({ reply }) => {
			reply(formatDoctor(runDoctor({ config: svc.rt.config, paths: resolvePaths(svc.rt.homeDir), transport: svc.rt.transport, diagnostics: svc.diagnosticsContext() })));
		},
		"/feishu approvals": ({ reply }) => {
			reply(summarizeApprovalPolicy({
				config: svc.rt.config,
				ps: loadPsConfig(psConfigFile()),
				psInstalled: piPermissionSystemInstalled(),
				...(svc.rt.alwaysApproved ? { alwaysRules: svc.rt.alwaysApproved.list() } : {}),
				pendingApprovals: svc.rt.permissionBridge?.pendingCount() ?? 0,
			}));
		},
		"/feishu usage": async ({ msg, args, isAdmin, reply, trySendCard }) => {
			if (args[0]?.toLowerCase() === "week") {
				// 近 7 天汇总（本群；管理员在私聊里看全部）
				const all = isAdmin && msg.chatType === "p2p";
				const filter = all ? undefined : (record: { chatId: string }) => record.chatId === msg.chatId;
				const byDate = svc.rt.usageLedger?.summary(7, "date", filter) ?? [];
				const bySender = svc.rt.usageLedger?.summary(7, "sender", filter) ?? [];
				const names = new Map<string, string>();
				for (const row of bySender.slice(0, 10)) {
					const name = await svc.rt.transport?.resolveUserName(row.key).catch(() => undefined);
					if (name) names.set(row.key, name);
				}
				const budget = svc.rt.convManager?.budgetStatus(msg.chatId);
				const budgetLine = budget?.limit ? `\n\n本群今日：$${budget.spent.toFixed(2)} / 上限 $${budget.limit}` : "";
				reply(`${all ? "（全部会话）" : "（本群）"}${formatUsageWeek({ byDate, bySender }, (id: string) => names.get(id) ?? `…${id.slice(-4)}`)}${budgetLine}`);
				return;
			}
			// 余额查询会打外部接口，所以走 TTL 缓存；失败也不阻止会话用量展示。
			const snapshot = svc.rt.convManager?.usageSnapshot(msg);
			const input = {
				...(snapshot ?? {}),
				tierText: svc.usageProvider().tierLabel(new Date()),
				accountLabel: svc.usageProvider().accountLabel ?? null,
				cnyPerUsd: (model: string | undefined) => svc.usageProvider().cnyPerUsd(model),
				balance: await svc.usageProvider().balance(),
				localTimeLabel: formatTimeInZone(Date.now(), svc.rt.config.timezone),
			};
			if (await trySendCard(buildUsageCard(input), "usage")) return;
			reply(formatUsageReport(input));
		},
	};
}
