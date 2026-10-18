/**
 * 改会话历史的命令：`/undo`、`/retry`、`/fork`、`/export`。
 *
 * 它们和「收消息、跑一轮」不是一类事：这里**不能花钱**（不调模型），全部要等会话空闲，
 * 而且每一步都写历史/换指针 —— 放在管理器里会把「一轮怎么跑」的主干淹掉。
 *
 * 依赖显式传入：会话表、忙判定、打开 agent、把消息重新排进会话。这里不关心消息怎么来、
 * 也不知道调度器长什么样，只负责「让 Pi 把历史挪一下，然后把结果讲给用户」。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationStore } from "./conversation-store.js";
import type { SessionTable, TableSession } from "./session-table.js";
import { extractText, previewText, stripContextPrefix } from "./text-utils.js";
import type { AgentHandle } from "./agent-types.js";
import type { BridgeConfig, FeishuInboundMessage } from "../types.js";

/** 管理器里只需要 `agent` 与 `sessionFile`；这里不复制整个会话类型。 */
export interface HistorySession extends TableSession {
	sessionFile: string;
	/** `/retry` 用的「这一轮是怎么来的」（不含注入的上下文行）。 */
	lastItem?: { text: string; resources: unknown[]; replyToMessageId?: string; replyToText?: string };
	agent?: { dispose(): Promise<void> | void };
}

export interface HistoryOpsDeps<S extends HistorySession = HistorySession> {
	config: BridgeConfig;
	sessions: SessionTable<S>;
	/** 会话忙时的拒绝文案（执行中/有排队）。 */
	busyReason(key: string): string | undefined;
	/** 取（或建）会话并确保 agent 就绪；失败返回一句给用户看的话。 */
	openAgent(msg: FeishuInboundMessage): Promise<{ key: string; session: S; agent: AgentHandle } | string>;
	/** 把一条消息按「排队」重新投进会话（/retry 用）。 */
	requeue(msg: FeishuInboundMessage, item: { text: string; resources: unknown[]; replyToMessageId?: string; replyToText?: string }): Promise<void>;
	conversationStore?: ConversationStore;
	exportsDir?: string;
	sendLocalFile?: (chatId: string, path: string, opts: { replyTo?: string; threadId?: string }, meta: { dedupeKey: string; laneKey: string }) => { ok: boolean; error?: string };
	/** 分叉后旧会话的审批/卡片要失效。 */
	onApprovalInvalidate?: (event: { conversationKey: string; reason: "reset" }) => void;
	discardChannel?(key: string): void;
	log?: (level: "debug" | "info" | "warn" | "error", event: string, meta?: unknown) => void;
	now(): number;
}

export interface HistoryOps {
	undo(msg: FeishuInboundMessage): Promise<string>;
	retry(msg: FeishuInboundMessage): Promise<string>;
	forkCandidates(msg: FeishuInboundMessage): Promise<string>;
	fork(msg: FeishuInboundMessage, selector?: string): Promise<string>;
	export(msg: FeishuInboundMessage, format: "html" | "md" | "summary"): Promise<string>;
}

export function createHistoryOps<S extends HistorySession>(deps: HistoryOpsDeps<S>): HistoryOps {
	const log = deps.log;

	const undo = async (msg: FeishuInboundMessage): Promise<string> => {
		const ready = await deps.openAgent(msg);
		if (typeof ready === "string") return ready;
		const { agent, key } = ready;
		if (!agent.userMessages || !agent.navigateTo) return "当前 Pi 版本不支持回退";
		const last = agent.userMessages().at(-1);
		if (!last) return "当前会话还没有可撤销的对话";
		const result = await agent.navigateTo(last.entryId);
		if (result.cancelled) return "回退被取消";
		log?.("info", "feishu.conv.undo", { conversationKey: key });
		return `已撤销最近一轮：「${previewText(stripContextPrefix(last.text))}」\n只回退对话记录，该轮已经执行的命令、改过的文件不会回滚。`;
	};

	const retry = async (msg: FeishuInboundMessage): Promise<string> => {
		const ready = await deps.openAgent(msg);
		if (typeof ready === "string") return ready;
		const { agent, session, key } = ready;
		if (!agent.userMessages || !agent.navigateTo) return "当前 Pi 版本不支持重试";
		const last = agent.userMessages().at(-1);
		if (!last) return "当前会话还没有可以重试的消息";
		const result = await agent.navigateTo(last.entryId);
		if (result.cancelled) return "重试被取消";
		// 优先用桥记下的原文（不含注入的上下文行 —— 否则重发时发言人/引用会重复注入）
		const original = session.lastItem;
		const text = original?.text ?? stripContextPrefix(result.editorText ?? last.text);
		await deps.requeue(msg, {
			text,
			resources: original?.resources ?? [],
			replyToMessageId: original?.replyToMessageId,
			replyToText: original?.replyToText,
		});
		log?.("info", "feishu.conv.retry", { conversationKey: key, model: agent.modelId });
		return `正在重试上一条消息（模型：${agent.modelId}）`;
	};

	const forkCandidates = async (msg: FeishuInboundMessage): Promise<string> => {
		const ready = await deps.openAgent(msg);
		if (typeof ready === "string") return ready;
		const list = ready.agent.userMessages?.() ?? [];
		if (list.length === 0) return "当前会话还没有用户消息";
		const start = Math.max(0, list.length - 15);
		return [
			`本会话用户消息（共 ${list.length} 条${start > 0 ? "，只列最近 15 条" : ""}）：`,
			...list.slice(start).map((entry, index) => `#${start + index + 1} ${previewText(stripContextPrefix(entry.text))}`),
			"",
			"/fork #N 从第 N 条消息之前分叉出新会话；/fork 复制当前会话。",
		].join("\n");
	};

	/**
	 * 无参 = 从当前位置复制一份；`#N` = 从第 N 条用户消息之前分叉。
	 * 新文件接入会话指针（旧会话进历史，/sessions 可回去），与 /resume 同一套切换顺序：先落盘指针，再换运行态。
	 */
	const fork = async (msg: FeishuInboundMessage, selector?: string): Promise<string> => {
		if (!deps.conversationStore) return "当前部署未启用会话索引，无法分叉";
		const ready = await deps.openAgent(msg);
		if (typeof ready === "string") return ready;
		const { key, session, agent } = ready;
		if (!agent.branchedSessionFile || !agent.leafId) return "当前 Pi 版本不支持分叉";
		let leaf: string | undefined;
		let note = "";
		if (selector) {
			const match = /^#?(\d+)$/.exec(selector.trim());
			if (!match) return "用法：/fork [#N]（/fork list 查看消息编号）";
			const n = Number.parseInt(match[1]!, 10);
			const list = agent.userMessages?.() ?? [];
			const target = list[n - 1];
			if (!target) return `没有第 ${n} 条用户消息（共 ${list.length} 条）`;
			const parent = agent.entryParentId?.(target.entryId);
			if (parent === undefined) return "无法定位该消息，请稍后重试";
			if (parent === null) return "第 1 条消息之前没有历史，直接 /new 即可";
			leaf = parent;
			note = `\n分叉点在第 ${n} 条消息之前，那条消息是：「${previewText(stripContextPrefix(target.text))}」`;
		} else {
			leaf = agent.leafId();
		}
		if (!leaf) return "当前会话还没有内容，无需分叉";
		let file: string | undefined;
		try {
			file = agent.branchedSessionFile(leaf);
		} catch (error) {
			return `分叉失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
		}
		if (!file) return "分叉失败：Pi 未返回新会话文件";
		const pointer = deps.conversationStore.get(key);
		try {
			deps.conversationStore.set({ conversationKey: key, sessionFile: file, generation: (pointer?.generation ?? 0) + 1 });
		} catch {
			return "会话指针写入失败，已保留当前会话";
		}
		// 句柄已经指向新文件，但它的内存状态是分叉前的；重开最稳妥
		deps.sessions.delete(key);
		deps.discardChannel?.(key);
		try { await session.agent?.dispose(); } catch { /* best effort */ }
		deps.onApprovalInvalidate?.({ conversationKey: key, reason: "reset" });
		log?.("info", "feishu.conv.forked", { conversationKey: key, selector: selector ?? null });
		return `已分叉出新会话，下一条消息在分叉上继续；原会话可用 /sessions 找回。${note}`;
	};

	const exportConversation = async (msg: FeishuInboundMessage, format: "html" | "md" | "summary"): Promise<string> => {
		const dir = deps.exportsDir;
		if (!dir || !deps.sendLocalFile) return "当前部署未启用导出";
		const ready = await deps.openAgent(msg);
		if (typeof ready === "string") return ready;
		const { key, session, agent } = ready;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-");
		const name = (agent.sessionName?.() || "session").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "session";
		let path: string;
		try {
			if (format === "html") {
				if (!agent.exportHtml) return "当前 Pi 版本不支持导出 HTML";
				path = await agent.exportHtml(join(dir, `${name}-${stamp}.html`));
			} else if (format === "summary") {
				if (!agent.summarizeForBugReport) return "当前 Pi 版本不支持生成摘要";
				const summary = await agent.summarizeForBugReport();
				path = join(dir, `${name}-${stamp}-summary.md`);
				writeFileSync(path, summary, { mode: 0o600 });
			} else {
				path = join(dir, `${name}-${stamp}.md`);
				writeFileSync(path, transcriptMarkdown(session.sessionFile, agent.sessionName?.()), { mode: 0o600 });
			}
			try { chmodSync(path, 0o600); } catch { /* best effort */ }
		} catch (error) {
			log?.("warn", "feishu.conv.export_failed", { conversationKey: key, format, error: error instanceof Error ? error.message : String(error) });
			return `导出失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
		}
		const replyTo = msg.replyTarget === null ? undefined : (msg.replyTarget ?? msg.messageId);
		const sent = deps.sendLocalFile(msg.chatId, path, { replyTo, threadId: msg.threadId }, {
			dedupeKey: `${msg.messageId}${msg.dedupeNonce ?? ""}:export`, laneKey: key,
		});
		log?.("info", "feishu.conv.exported", { conversationKey: key, format, ok: sent.ok });
		return sent.ok ? `已导出（${format}），文件马上发到这里` : `导出文件已生成，但发送失败：${sent.error ?? "未知错误"}`;
	};

	return { undo, retry, forkCandidates, fork, export: exportConversation };
}

/** 把 Pi 会话文件整理成 markdown（只含用户与助手的文本，不含工具参数/输出）。 */
export function transcriptMarkdown(sessionFile: string, title?: string): string {
	const out: string[] = [`# ${title || "会话记录"}`, ""];
	let raw = "";
	try { raw = readFileSync(sessionFile, "utf8"); } catch { return `${out.join("\n")}\n（会话文件不存在）\n`; }
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(entry.message.content);
		if (!text) continue;
		out.push(`## ${role === "user" ? "用户" : "助手"}${entry.timestamp ? ` · ${entry.timestamp}` : ""}`, "", text, "");
	}
	return out.join("\n");
}
