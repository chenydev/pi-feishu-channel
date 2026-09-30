/**
 * 云文档评论 —— 在文档评论里 @ 机器人，机器人在评论区回复（对齐 hermes feishu_comment.py 的主干）。
 *
 * 流程：事件（drive.notice.comment_add_v1）→ 过滤（只响应 @ 本 bot、非自己发的、准入允许的人）
 * → 拉评论详情（划词引用 + 该评论串的回复）与文档标题 → 组装提示词 → 作为虚拟会话
 * （chatId = `doc:<fileToken>`）的一轮任务执行 → 最终回答回复到评论串（全文评论则新增全文评论）。
 *
 * 与 hermes 的取舍：不做 wiki 反查、不做跨评论时间线（只看当前评论串），够用且权限面小。
 */
import type { DeliveryTarget } from "../types.js";
import { EXTERNAL_CHAT_PREFIX } from "../types.js";

export type RawRequest = (opts: { url: string; method: string; params?: unknown; data?: unknown }) => Promise<unknown>;

export interface DocCommentEvent {
	eventId?: string;
	fileToken: string;
	fileType: string;
	commentId: string;
	replyId?: string;
	noticeType?: string;
	fromOpenId?: string;
	toOpenId?: string;
	isMentioned: boolean;
}

/** 只处理"新增评论 / 新增回复"两类通知（hermes `_ALLOWED_NOTICE_TYPES`）。 */
const ALLOWED_NOTICE_TYPES = new Set(["add_comment", "add_reply"]);
/** 评论区单条回复的长度上限（超出按行切片，hermes `_REPLY_CHUNK_SIZE`）。 */
export const COMMENT_CHUNK_CHARS = 4_000;
/** 评论不允许回复（例如已解决）时的业务码 → 退化为新增全文评论。 */
const REPLY_NOT_ALLOWED = 1069302;

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function parseDocCommentEvent(data: unknown): DocCommentEvent | undefined {
	const root = (data ?? {}) as Record<string, unknown>;
	// SDK（WS）把 event 字段平铺在顶层；webhook 形态在 event 下 —— 两种都认
	const evt = (root.event && typeof root.event === "object" ? root.event : root) as Record<string, unknown>;
	const meta = (evt.notice_meta ?? {}) as Record<string, unknown>;
	const fileToken = str(meta.file_token);
	const fileType = str(meta.file_type);
	const commentId = str(evt.comment_id);
	if (!fileToken || !fileType || !commentId) return undefined;
	const openId = (value: unknown) => str((value as { open_id?: unknown } | undefined)?.open_id);
	const eventId = str(evt.event_id) ?? str((root.header as { event_id?: unknown } | undefined)?.event_id);
	return {
		...(eventId ? { eventId } : {}),
		fileToken, fileType, commentId,
		...(str(evt.reply_id) ? { replyId: str(evt.reply_id) } : {}),
		...(str(meta.notice_type) ? { noticeType: str(meta.notice_type) } : {}),
		...(openId(meta.from_user_id) ? { fromOpenId: openId(meta.from_user_id) } : {}),
		...(openId(meta.to_user_id) ? { toOpenId: openId(meta.to_user_id) } : {}),
		isMentioned: evt.is_mentioned === true,
	};
}

/** 过滤：返回 undefined = 应处理；否则返回跳过原因（记日志用）。 */
export function docCommentSkipReason(event: DocCommentEvent, botOpenId: string | undefined): string | undefined {
	if (botOpenId && event.fromOpenId === botOpenId) return "self_authored";
	if (!event.toOpenId || (botOpenId && event.toOpenId !== botOpenId)) return "not_addressed_to_bot";
	if (event.noticeType && !ALLOWED_NOTICE_TYPES.has(event.noticeType)) return `notice_type:${event.noticeType}`;
	return undefined;
}

interface CommentReply {
	reply_id?: string;
	user_id?: string | { open_id?: string };
	content?: { elements?: Array<Record<string, unknown>> } | string;
}

/** 评论回复的纯文本（@ 本 bot 是路由信号不是内容，去掉）。 */
export function commentReplyText(reply: CommentReply, botOpenId?: string): string {
	let content: { elements?: Array<Record<string, unknown>> } | undefined;
	if (typeof reply.content === "string") {
		try { content = JSON.parse(reply.content) as { elements?: Array<Record<string, unknown>> }; } catch { return reply.content; }
	} else {
		content = reply.content;
	}
	const parts: string[] = [];
	for (const element of content?.elements ?? []) {
		const type = element.type;
		if (type === "text_run") parts.push(String((element.text_run as { text?: unknown } | undefined)?.text ?? ""));
		else if (type === "docs_link") parts.push(String((element.docs_link as { url?: unknown } | undefined)?.url ?? ""));
		else if (type === "person") {
			const uid = String((element.person as { user_id?: unknown } | undefined)?.user_id ?? "");
			if (!botOpenId || uid !== botOpenId) parts.push(`@${uid}`);
		}
	}
	return parts.join("").replace(/\s+/g, " ").trim();
}

function replyUserId(reply: CommentReply): string {
	return typeof reply.user_id === "string" ? reply.user_id : reply.user_id?.open_id ?? "";
}

export interface DocCommentContext {
	title?: string;
	url?: string;
	isWhole: boolean;
	quote?: string;
	/** 当前评论串（时间顺序）。 */
	thread: Array<{ userId: string; text: string; isBot: boolean }>;
}

async function okData(request: RawRequest, opts: Parameters<RawRequest>[0]): Promise<Record<string, unknown> | undefined> {
	const response = await request(opts) as { code?: number; data?: Record<string, unknown> } | undefined;
	if (!response || (response.code !== undefined && response.code !== 0)) return undefined;
	return response.data ?? {};
}

/**
 * 拉评论上下文。评论刚创建时 batch_query 可能还查不到（最终一致），重试几次（hermes 同样做法）。
 */
export async function fetchDocCommentContext(
	request: RawRequest,
	event: DocCommentEvent,
	options: { botOpenId?: string; retries?: number; retryDelayMs?: number } = {},
): Promise<DocCommentContext | undefined> {
	const retries = options.retries ?? 3;
	let comment: Record<string, unknown> | undefined;
	for (let attempt = 0; attempt <= retries && !comment; attempt++) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 1_000));
		const data = await okData(request, {
			url: `/open-apis/drive/v1/files/${event.fileToken}/comments/batch_query`, method: "POST",
			params: { file_type: event.fileType, user_id_type: "open_id" },
			data: { comment_ids: [event.commentId] },
		}).catch(() => undefined);
		comment = (data?.items as Array<Record<string, unknown>> | undefined)?.[0];
	}
	if (!comment) return undefined;
	const meta = await okData(request, {
		url: "/open-apis/drive/v1/metas/batch_query", method: "POST",
		data: { request_docs: [{ doc_token: event.fileToken, doc_type: event.fileType }], with_url: true },
	}).catch(() => undefined);
	const doc = (meta?.metas as Array<{ title?: string; url?: string }> | undefined)?.[0];
	let replyList = comment.reply_list as { replies?: CommentReply[] } | string | undefined;
	if (typeof replyList === "string") {
		try { replyList = JSON.parse(replyList) as { replies?: CommentReply[] }; } catch { replyList = undefined; }
	}
	const replies = (replyList as { replies?: CommentReply[] } | undefined)?.replies ?? [];
	return {
		...(doc?.title ? { title: doc.title } : {}),
		...(doc?.url ? { url: doc.url } : {}),
		isWhole: comment.is_whole === true,
		...(str(comment.quote) ? { quote: str(comment.quote) } : {}),
		thread: replies.map((reply) => {
			const userId = replyUserId(reply);
			return { userId, text: commentReplyText(reply, options.botOpenId), isBot: Boolean(options.botOpenId) && userId === options.botOpenId };
		}),
	};
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 提示词：方括号元信息 + 评论串 + 当前要回应的那条。 */
export function buildDocCommentPrompt(event: DocCommentEvent, ctx: DocCommentContext): string {
	const current = [...ctx.thread].reverse().find((entry) => entry.userId === event.fromOpenId && !entry.isBot)
		?? [...ctx.thread].reverse().find((entry) => !entry.isBot);
	const lines = [
		`[云文档评论：有人在《${ctx.title ?? "未命名文档"}》的${ctx.isWhole ? "全文评论" : "评论"}里 @ 了你。你的最终回答会原样回复到评论区（纯文本，不支持 Markdown 渲染）。]`,
		`[文档：file_type=${event.fileType} file_token=${event.fileToken}${ctx.url ? ` 链接 ${ctx.url}` : ""}；需要全文时可用 feishu_doc_read 工具读取]`,
	];
	if (ctx.quote) lines.push(`[划词引用] ${clip(ctx.quote, 500)}`);
	const history = ctx.thread.filter((entry) => entry !== current).slice(-10);
	if (history.length > 0) {
		lines.push("[评论串]");
		for (const entry of history) lines.push(`${entry.isBot ? "（你）" : entry.userId}: ${clip(entry.text, 500)}`);
	}
	lines.push("", clip(current?.text || "（评论内容为空）", 2_000));
	return lines.join("\n");
}

/** 虚拟会话 id（每个文档一个；再按人隔离由 conversationKey 负责）。 */
export function docCommentChatId(fileToken: string): string {
	return `${EXTERNAL_CHAT_PREFIX}${fileToken}`;
}

/** 按行优先切片（评论区单条长度有限）。 */
export function chunkCommentText(text: string, limit = COMMENT_CHUNK_CHARS): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut <= 0) cut = limit;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n+/, "");
	}
	if (rest) chunks.push(rest);
	return chunks;
}

/** 评论正文不接受裸 `& < >`（hermes `_sanitize_comment_text`）。 */
function escapeCommentText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 回复到评论串；不允许回复（如评论已解决）或全文评论时新增全文评论。返回是否全部送达。 */
export async function deliverDocCommentReply(request: RawRequest, target: DeliveryTarget, text: string): Promise<boolean> {
	let whole = target.isWhole;
	for (const raw of chunkCommentText(text)) {
		const chunk = escapeCommentText(raw);
		if (!whole) {
			const response = await request({
				url: `/open-apis/drive/v1/files/${target.fileToken}/comments/${target.commentId}/replies`, method: "POST",
				params: { file_type: target.fileType },
				data: { content: { elements: [{ type: "text_run", text_run: { text: chunk } }] } },
			}) as { code?: number } | undefined;
			if (!response || response.code === undefined || response.code === 0) continue;
			if (response.code !== REPLY_NOT_ALLOWED) return false;
			whole = true;
		}
		const response = await request({
			url: `/open-apis/drive/v1/files/${target.fileToken}/new_comments`, method: "POST",
			data: { file_type: target.fileType, reply_elements: [{ type: "text", text: chunk }] },
		}) as { code?: number } | undefined;
		if (response?.code !== undefined && response.code !== 0) return false;
	}
	return true;
}

/** 从文档链接或裸 token 里取出 token（wiki 链接要再换成实际文档 token）。 */
export function parseDocRef(input: string): { token: string; wiki: boolean } | undefined {
	const trimmed = input.trim();
	const match = /\/(docx|docs|wiki)\/([A-Za-z0-9]+)/.exec(trimmed);
	if (match) return { token: match[2], wiki: match[1] === "wiki" };
	return /^[A-Za-z0-9]{10,}$/.test(trimmed) ? { token: trimmed, wiki: false } : undefined;
}

/**
 * `feishu_doc_read` —— 读取云文档（docx）纯文本（hermes feishu_doc_tool 等价）。
 * 结果按 maxChars 截断，避免一篇长文档把上下文吃满。
 */
export async function readDocText(request: RawRequest, ref: string, maxChars = 30_000): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string }> {
	const parsed = parseDocRef(ref);
	if (!parsed) return { ok: false, error: "无法识别的文档链接或 token" };
	let token = parsed.token;
	if (parsed.wiki) {
		const node = await okData(request, { url: "/open-apis/wiki/v2/spaces/get_node", method: "GET", params: { token } }).catch(() => undefined);
		const objToken = str((node?.node as { obj_token?: unknown } | undefined)?.obj_token);
		const objType = str((node?.node as { obj_type?: unknown } | undefined)?.obj_type);
		if (!objToken) return { ok: false, error: "知识库节点解析失败（无权限或链接无效）" };
		if (objType && objType !== "docx") return { ok: false, error: `暂只支持 docx 文档（该节点是 ${objType}）` };
		token = objToken;
	}
	const response = await request({ url: `/open-apis/docx/v1/documents/${token}/raw_content`, method: "GET" })
		.catch((error: unknown) => ({ code: -1, msg: error instanceof Error ? error.message : String(error) })) as { code?: number; msg?: string; data?: { content?: string } };
	if (response.code !== undefined && response.code !== 0) return { ok: false, error: `读取失败（code=${response.code}${response.msg ? ` ${response.msg}` : ""}）` };
	const text = response.data?.content ?? "";
	return { ok: true, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
