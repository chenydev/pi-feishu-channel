/**
 * 对话与会话类命令：新会话、停止、排队、插话、重试、撤销、分叉、导出、压缩、重载、历史会话、工作区。
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommandHandler } from "../dispatch.js";
import type { CommandServices } from "./services.js";
import { saveConfigFields } from "../../config.js";
import { buildConversationKey, groupSessionsPerUser } from "../../session/conversation-key.js";
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
		"/progress": async ({ msg, reply }) => {
			reply(svc.rt.convManager?.progressReport(msg) ?? "会话不可用");
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
		"/reload": async ({ msg, reply }) => {
			reply(await svc.rt.convManager?.reloadConversation(msg) ?? "会话不可用");
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
		"/resume": async ({ msg, args, isAdmin, reply }) => {
			reply(await svc.rt.convManager?.commands.resumeConversation(msg, args[0], { isAdmin }) ?? "会话不可用");
		},
		"/workspace": async ({ msg, args, rest, isAdmin, reply }) => {
			// 查看（任何人）/ 切换、增删、设默认（仅管理员）
			const sub = args[0]?.toLowerCase();
			if (sub === "add" || sub === "rm" || sub === "default") {
				reply(isAdmin ? manageWorkspaces(svc, msg, sub, args[1], rest) : "仅管理员或应用归属人可管理工作区");
				return;
			}
			reply(await svc.rt.convManager?.commands.switchWorkspace(msg, args[0], { isAdmin }) ?? "会话不可用");
		},
	};
}

/** 会话是否多人共用（话题、不按人隔离的群）：导出这类会话要二次确认。 */
function isSharedConversation(svc: CommandServices, msg: FeishuInboundMessage): boolean {
	return buildConversationKey(msg, svc.rt.config).includes(":t:") || (msg.chatType === "group" && !groupSessionsPerUser(svc.rt.config, msg.chatId));
}

/** 别名：字母、数字、下划线、连字符（含中文），不能和子命令重名；不允许 `.`，否则写回配置时会被当成路径分隔。 */
const WORKSPACE_ALIAS = /^[\p{L}\p{N}_-]{1,32}$/u;
const WORKSPACE_SUBCOMMANDS = new Set(["add", "rm", "default", "reset"]);

/**
 * `/workspace add <别名> <绝对路径>` / `rm <别名>` / `default <别名>|reset`：运行中增删工作区，立即写回配置。
 * 只校验目录存在；能把 agent 指到哪里由管理员决定（命令本身仅管理员可用）。
 */
function manageWorkspaces(svc: CommandServices, msg: FeishuInboundMessage, sub: "add" | "rm" | "default", alias: string | undefined, rest: string): string {
	const { rt, log } = svc;
	const workspaces = rt.config.workspaces ?? { aliases: {} };
	const aliases = workspaces.aliases ?? {};
	const save = (next: typeof workspaces, field: string): boolean => {
		const previous = rt.config.workspaces;
		rt.config.workspaces = next;
		if (saveConfigFields(rt.homeDir, rt.config, [field])) return true;
		rt.config.workspaces = previous;
		return false;
	};

	if (sub === "add") {
		const path = expandHome(rest.replace(/^\s*add\s+\S+/i, "").trim());
		if (!alias || !path) return "用法：/workspace add <别名> <绝对路径>";
		if (!WORKSPACE_ALIAS.test(alias) || WORKSPACE_SUBCOMMANDS.has(alias.toLowerCase())) return "别名只能用字母、数字、中文、下划线和连字符（不超过 32 个字），且不能是 add / rm / default / reset";
		if (aliases[alias]) return `别名已存在：${alias}（${aliases[alias]}）。要改目录请先 /workspace rm ${alias}`;
		if (!isAbsolute(path)) return "请给出绝对路径（可以用 ~/ 开头）";
		try {
			if (!statSync(realpathSync(path)).isDirectory()) return `不是目录：${path}`;
		} catch {
			return `目录不存在或不可访问：${path}`;
		}
		if (!save({ ...workspaces, aliases: { ...aliases, [alias]: path } }, `workspaces.aliases.${alias}`)) return "工作区写入配置失败，运行态未修改";
		log.info("feishu.conv.workspace_added", { alias, operator: msg.senderId });
		return `已添加工作区 ${alias}：${path}\n用 /workspace ${alias} 切换当前会话；/workspace default ${alias} 设为新会话默认`;
	}

	if (sub === "rm") {
		if (!alias) return "用法：/workspace rm <别名>";
		if (!aliases[alias]) return `没有这个工作区：${alias}`;
		if (workspaces.default === alias) return `${alias} 是默认工作区，先用 /workspace default reset 或改成别的再删除`;
		const { [alias]: _removed, ...remaining } = aliases;
		if (!save({ ...workspaces, aliases: remaining }, `workspaces.aliases.${alias}`)) return "工作区写入配置失败，运行态未修改";
		log.info("feishu.conv.workspace_removed", { alias, operator: msg.senderId });
		return `已删除工作区 ${alias}。正在用它的会话不受影响，下次新建会话时回到默认工作区`;
	}

	if (!alias) return "用法：/workspace default <别名>|reset";
	if (alias.toLowerCase() === "reset") {
		const { default: _previous, ...withoutDefault } = workspaces;
		if (!save(withoutDefault, "workspaces.default")) return "工作区写入配置失败，运行态未修改";
		log.info("feishu.conv.workspace_default_changed", { alias: null, operator: msg.senderId });
		return "已清除默认工作区：新会话使用 pi 进程的启动目录（没切换过工作区的已有会话在 /new 或重启后生效）";
	}
	if (!aliases[alias]) return `没有这个工作区：${alias}（先 /workspace add ${alias} <绝对路径>）`;
	if (!save({ ...workspaces, default: alias }, "workspaces.default")) return "工作区写入配置失败，运行态未修改";
	log.info("feishu.conv.workspace_default_changed", { alias, operator: msg.senderId });
	return `默认工作区：${alias}（新会话生效；没切换过工作区的已有会话在 /new 或重启后生效，也可以用 /workspace ${alias} 立即切换）`;
}

function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
