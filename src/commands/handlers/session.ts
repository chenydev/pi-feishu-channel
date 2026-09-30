/**
 * 对话与会话类命令：新会话、停止、排队、插话、重试、撤销、分叉、导出、压缩、历史会话、工作区。
 */
import type { CommandHandler } from "../dispatch.js";
import type { CommandServices } from "./services.js";
import { buildConversationKey } from "../../session/conversation-key.js";
import type { FeishuInboundMessage } from "../../types.js";
import { buildNewSessionCard, buildSessionsCard } from "../cards.js";

export function sessionCommands(svc: CommandServices): Record<string, CommandHandler> {
	return {
		"/new": async ({ msg, args, reply, trySendCard, buttonCtx }) => {
			const force = args[0]?.toLowerCase() === "force";
			const result = await svc.rt.convManager?.resetConversation(msg, { force });
			if (!result) { reply("会话不可用"); return; }
			if (result.status === "error") { reply(`开新会话失败：${result.reason}`); return; }
			if (result.status === "busy") {
				reply(`当前有 ${result.pending} 个任务在执行或排队。回复 /new force 可取消它们并开新会话；或先 /stop 处理当前任务。`);
				return;
			}
			svc.rt.permissionBridge?.resetSession(buildConversationKey(msg, svc.rt.config));
			const text = result.cancelled > 0 ? `已取消 ${result.cancelled} 个排队任务，并创建新的会话上下文` : "已创建新的会话上下文";
			// 回执带上一个会话的名字和"恢复"按钮（误操作能找回）
			if (result.hadPrevious && await trySendCard(buildNewSessionCard(text, { name: result.previousName, selector: "#2" }, buttonCtx), "new")) return;
			reply(result.hadPrevious ? `${text}\n上一个会话${result.previousName ? `「${result.previousName}」` : ""}可用 /resume #2 找回。` : text);
		},
		"/stop": async ({ msg, reply }) => {
			svc.rt.permissionBridge?.resetSession(buildConversationKey(msg, svc.rt.config));
			reply(await svc.rt.convManager?.stopConversation(msg)
				? "已请求停止当前任务；通过 /queue 排队的后续任务将继续执行"
				: "当前没有正在执行的任务");
		},
		"/queue": async ({ msg, args, rest, reply }) => {
			const sub = args[0]?.toLowerCase();
			if (sub === "list" && args.length === 1) {
				const snap = svc.rt.convManager?.queueSnapshot(msg);
				if (!snap || (!snap.active && snap.queued.length === 0)) { reply("当前没有执行中或排队的任务"); return; }
				reply([
					snap.active ? `执行中：${snap.active}${snap.steered ? `（并入 ${snap.steered} 条）` : ""}` : "当前没有执行中的任务",
					...(snap.queued.length ? ["排队：", ...snap.queued.map((text, index) => `${index + 1}. ${text}`)] : ["排队：无"]),
				].join("\n"));
				return;
			}
			if (sub === "clear" && args.length === 1) {
				const removed = await svc.rt.convManager?.clearQueued(msg) ?? 0;
				reply(removed > 0 ? `已清空 ${removed} 个排队任务（执行中的任务不受影响，要停止用 /stop）` : "队列本来就是空的");
				return;
			}
			if (!rest) { reply("用法：/queue <内容> | list | clear（别名 /q）"); return; }
			const result = await svc.rt.convManager?.queueConversation({ ...msg, text: rest });
			const position = svc.rt.convManager?.queueSnapshot(msg).queued.length ?? 0;
			reply(result === "rejected" ? "当前队列已满，请稍后再试" : position > 0 ? `已排队，第 ${position} 个` : "已加入后续任务队列");
		},
		"/steer": async ({ msg, rest, reply }) => {
			if (!rest) { reply("用法：/steer <内容>"); return; }
			const result = await svc.rt.convManager?.steerConversation({ ...msg, text: rest });
			reply(result === "steered" ? "已注入当前任务" : result === "queued" ? "当前任务已结束，已作为新任务执行" : "当前队列已满，请稍后再试");
		},
		"/retry": async ({ msg, reply }) => {
			reply(await svc.rt.convManager?.retryConversation(msg) ?? "会话不可用");
		},
		"/undo": async ({ msg, reply }) => {
			reply(await svc.rt.convManager?.undoConversation(msg) ?? "会话不可用");
		},
		"/fork": async ({ msg, args, reply }) => {
			reply(args[0]?.toLowerCase() === "list"
				? await svc.rt.convManager?.forkCandidates(msg) ?? "会话不可用"
				: await svc.rt.convManager?.forkConversation(msg, args[0]) ?? "会话不可用");
		},
		"/export": async ({ msg, args, isAdmin, reply }) => {
			const format = (args[0]?.toLowerCase() ?? "html") as "html" | "md" | "summary";
			if (!["html", "md", "summary"].includes(format)) { reply("用法：/export [html|md|summary]"); return; }
			// 多人共用的会话：导出会把别人的发言一起带走 —— 非管理员要显式确认
			if (isSharedConversation(svc, msg) && !isAdmin && args[1]?.toLowerCase() !== "confirm") {
				reply(`这是多人共用的会话，导出会包含其他人的发言。确认导出请发送 /export ${format} confirm`);
				return;
			}
			reply(await svc.rt.convManager?.exportConversation(msg, format) ?? "会话不可用");
		},
		"/compact": async ({ msg, rest, reply }) => {
			reply(await svc.rt.convManager?.compactConversation(msg, rest || undefined) ?? "会话不可用");
		},
		"/sessions": async ({ msg, args, reply, trySendCard, buttonCtx }) => {
			const pageIndex = Math.max(1, Number.parseInt(args[0] ?? "1", 10) || 1) - 1;
			const page = await svc.rt.convManager?.commands.sessionsPage(msg, pageIndex);
			if (page === undefined) { reply("会话不可用"); return; }
			if (typeof page === "string") { reply(page); return; }
			// 卡片，每行一个"恢复"按钮
			if (await trySendCard(buildSessionsCard(page.entries, buttonCtx, page.footer), "sessions")) return;
			reply(await svc.rt.convManager?.commands.listSessionsFor(msg, pageIndex) ?? "会话不可用");
		},
		"/name": async ({ msg, rest, reply }) => {
			reply(await svc.rt.convManager?.commands.renameConversation(msg, rest) ?? "会话不可用");
		},
		"/resume": async ({ msg, args, reply }) => {
			reply(await svc.rt.convManager?.commands.resumeConversation(msg, args[0]) ?? "会话不可用");
		},
		"/workspace": async ({ msg, args, isAdmin, reply }) => {
			// 查看（任何人）/ 切换（仅管理员）
			reply(await svc.rt.convManager?.commands.switchWorkspace(msg, args[0], { isAdmin }) ?? "会话不可用");
		},
	};
}

/** 会话是否多人共用（话题、不按人隔离的群）：导出这类会话要二次确认。 */
function isSharedConversation(svc: CommandServices, msg: FeishuInboundMessage): boolean {
	return buildConversationKey(msg, svc.rt.config).includes(":t:") || (msg.chatType === "group" && !svc.rt.config.groupSessionsPerUser);
}
