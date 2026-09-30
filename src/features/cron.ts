/**
 * 定时任务（`cron.enabled`，默认关）：按 cron 表达式以创建人身份在原会话里发起一轮任务。
 *
 * 命令：`/cron add|list|rm|pause|resume`（list 任何人可看，其余仅管理员）。
 * 关闭时 `/cron` 只回复「未启用」。
 */
import { formatTimeInZone, resolvePaths } from "../config.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import { CronScheduler, parseCronAdd, type CronFire } from "../runtime/cron.js";
import type { BridgeLogger } from "../runtime/logger.js";
import type { FeishuInboundMessage } from "../types.js";
import type { BridgeFeature } from "./feature.js";

export const cronFeature: BridgeFeature = {
	name: "cron",
	enabled: (config) => config.cron?.enabled === true,
	disabledCommands: {
		"/cron": ({ reply }) => reply("定时任务未启用（config.cron.enabled）"),
	},
	setup({ rt, log }) {
		const scheduler = new CronScheduler({
			file: resolvePaths(rt.homeDir).cronJobsFile,
			timeZone: () => rt.config.timezone,
			catchUp: () => rt.config.cron?.catchUp ?? "skip",
			onFire: (fire) => fireCronJob(rt, fire),
			log: (level, m, meta) => log[level](m, meta),
		});
		return {
			commands: {
				"/cron": ({ msg, args, rest, isAdmin, reply }) => reply(cronCommand(rt, log, scheduler, msg, args, rest, isAdmin)),
			},
			start: () => scheduler.start(),
			stop: () => scheduler.stop(),
			statusLines: () => [`定时任务: ${scheduler.list().filter((job) => job.enabled).length} 个启用`],
		};
	},
};

/** `/cron add|list|rm|pause|resume`。 */
function cronCommand(rt: BridgeRuntime, log: BridgeLogger, scheduler: CronScheduler, msg: FeishuInboundMessage, args: string[], rest: string, isAdmin: boolean): string {
	const cron = rt.config.cron ?? {};
	const sub = args[0]?.toLowerCase() ?? "list";
	const zone = rt.config.timezone;
	if (sub === "list") {
		const jobs = scheduler.list(msg.chatId);
		if (jobs.length === 0) return "本会话没有定时任务。/cron add \"0 9 * * 1-5\" <任务内容> 新建（管理员）。";
		return [
			`本会话定时任务（${jobs.length}）：`,
			...jobs.map((job) => {
				const next = job.enabled ? scheduler.nextFor(job) : undefined;
				return `· ${job.id}　${job.expression}　${job.enabled ? "启用" : "暂停"}${next ? `　下次 ${formatTimeInZone(next, zone)}` : ""}\n　${job.text.slice(0, 60)}`;
			}),
		].join("\n");
	}
	if (!isAdmin) return "仅管理员或应用归属人可管理定时任务";
	if (sub === "add") {
		const parsed = parseCronAdd(rest.replace(/^add\s*/i, ""));
		if (!parsed) return "用法：/cron add \"<分 时 日 月 周>\" <任务内容>（例如 /cron add \"0 9 * * 1-5\" 汇总昨天的告警）";
		if ((scheduler.list().length) >= (cron.maxJobs ?? 20)) return `定时任务已达上限（${cron.maxJobs ?? 20} 个）`;
		try {
			const job = scheduler.add({
				expression: parsed.expression, text: parsed.text, chatId: msg.chatId, chatType: msg.chatType,
				...(msg.threadId ? { threadId: msg.threadId } : {}), creatorId: msg.senderId,
			});
			const next = scheduler.nextFor(job);
			log.info("feishu.cron.added", { jobId: job.id, expression: job.expression, chatId: msg.chatId, operator: msg.senderId });
			return `已创建定时任务 ${job.id}（${job.expression}，时区 ${zone}）${next ? `\n下次执行：${formatTimeInZone(next, zone)}` : ""}\n任务里的工具调用同样需要审批；无人审批时按超时拒绝。`;
		} catch (error) {
			return `表达式无效：${error instanceof Error ? error.message : String(error)}`;
		}
	}
	const id = args[1];
	if (!id) return `用法：/cron ${sub} <任务 id>（/cron list 查看）`;
	const owned = scheduler.list(msg.chatId).some((job) => job.id === id);
	if (!owned) return `本会话没有任务 ${id}`;
	try {
		if (sub === "rm" || sub === "remove" || sub === "del") return scheduler.remove(id) ? `已删除定时任务 ${id}` : `没有任务 ${id}`;
		if (sub === "pause") return scheduler.setEnabled(id, false) ? `已暂停定时任务 ${id}` : `没有任务 ${id}`;
		if (sub === "resume") return scheduler.setEnabled(id, true) ? `已恢复定时任务 ${id}（从现在起算）` : `没有任务 ${id}`;
	} catch (error) {
		return `操作失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
	}
	return "用法：/cron add|list|rm|pause|resume";
}

/** 定时任务触发 → 以创建人身份构造合成消息，走正常会话链路（审批、发送队列、进度全部复用）。 */
async function fireCronJob(rt: BridgeRuntime, fire: CronFire): Promise<void> {
	if (!rt.convManager) throw new Error("conversation manager unavailable");
	const { job, plannedAt, missed } = fire;
	const note = missed > 0 ? `[定时任务 ${job.id}：停机期间错过 ${missed} 次，本次照常执行]\n` : "";
	await rt.convManager.route({
		messageId: `cron:${job.id}:${plannedAt}`,
		chatId: job.chatId, chatType: job.chatType, ...(job.threadId ? { threadId: job.threadId } : {}),
		senderId: job.creatorId, isBot: false, msgType: "text",
		text: `${note}[定时任务 ${job.id}（${job.expression}）] ${job.text}`,
		mentions: [], resources: [], raw: undefined, ts: plannedAt,
		synthetic: true, replyTarget: null,
	}, { behavior: "queue" });
}
