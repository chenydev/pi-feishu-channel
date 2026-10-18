/**
 * 查看类命令：帮助、状态、诊断、用量。
 */
import type { CommandHandler } from "../dispatch.js";
import type { CommandServices } from "./services.js";
import { formatTimeInZone, resolvePaths } from "../../config.js";
import { formatUsageWeek } from "../../runtime/usage-ledger.js";
import { formatDoctor, runDoctor } from "../../runtime/doctor.js";
import { buildHelpCard } from "../cards.js";
import { COMMANDS, formatCommandHelp, formatHelpText } from "../registry.js";
import { buildUsageCard, formatUsageReport } from "../usage-card.js";

/**
 * 丢弃原因的一句话解释。与 `AdmitReason` 一一对应（外加桥正在停时的 `stopping`）：
 * 命令里说「怎么放行」，不用再去翻文档。
 */
const DROP_REASON_HINT: Record<string, string> = {
	stopping: "桥正在停止，这条没处理",
	self_echo: "桥自己发的消息（防自触发），正常",
	bot_not_mentioned: "群里没 @ 机器人（mention 策略）",
	bots_disabled: "发送者是 bot 但不在 allowBots（加 \"mentions\" 即可放行任何 @ 本 bot 的消息）",
	not_allowlisted: "群不在 allowChats，或用户不在该群/私聊白名单",
	dm_policy_rejected: "私聊未放行（看 allowUsers）",
	group_policy_rejected: "群策略拒绝（groupPolicy / groupRules）",
	rate_limited: "同一个人发得太快（rateLimit.perUserPerMinute；0 = 不限）",
	duplicate: "平台重投了已经处理过的消息",
};

export function infoCommands(svc: CommandServices): Record<string, CommandHandler> {
	return {
		"/help": async ({ rest, isAdmin, reply, trySendCard, buttonCtx }) => {
			if (rest) {
				reply(formatCommandHelp(rest));
				return;
			}
			const piCommands = svc.piCommands();
			if (await trySendCard(buildHelpCard({ ...buttonCtx, isAdmin, piCommands, directBash: Boolean(svc.rt.config.directBash?.enabled) }), "help")) return;
			reply(formatHelpText(COMMANDS, { piCommands: piCommands.filter((command) => command.source !== "extension") }));
		},
		"/feishu status": ({ msg, reply }) => {
			reply(`${svc.statusText()}\n本群工具档位: ${svc.rt.convManager?.toolPolicyFor(msg.chatId) ?? "?"}`);
		},
		"/feishu dropstats": ({ isAdmin, reply }) => {
			// 只给管理员：原因分布能反推出「谁被挡了」（比如某个 bot 是否在 allowBots 里）
			if (!isAdmin) {
				reply("仅管理员或应用归属人可查看丢弃统计");
				return;
			}
			const stats = svc.rt.pipeline?.getStats();
			if (!stats) {
				reply("入站流水线未启动");
				return;
			}
			const reasons = Object.entries(stats.dropsByReason).sort((a, b) => b[1] - a[1]);
			reply([
				`准入丢弃统计（进程启动以来）：丢弃 ${stats.dropped} / 共收到 ${stats.total}`,
				...(reasons.length > 0
					? reasons.map(([reason, count]) => `- ${reason}: ${count}（${DROP_REASON_HINT[reason] ?? "见 docs/operations.md §3"}）`)
					: ["- 没有丢弃记录"]),
				"（每条丢弃的完整上下文见日志 feishu.pipeline.drop）",
			].join("\n"));
		},
		"/feishu doctor": ({ args, reply, isAdmin }) => {
			const checks = runDoctor({ config: svc.rt.config, paths: resolvePaths(svc.rt.homeDir), transport: svc.rt.transport, diagnostics: svc.diagnosticsContext() });
			// 默认结论版（只看异常）；`full` 才列全部 19 项。
			// detail 里有宿主路径、配置字段、放行规则名：只给管理员看，其他人只看结论。
			const full = args[0]?.toLowerCase() === "full";
			reply(formatDoctor(checks, { detail: isAdmin, onlyProblems: !full }));
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
