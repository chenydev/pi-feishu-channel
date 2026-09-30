/** 云文档评论、会议邀请、文档读取。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDocCommentPrompt, chunkCommentText, commentReplyText, deliverDocCommentReply, docCommentChatId,
	docCommentSkipReason, fetchDocCommentContext, parseDocCommentEvent, parseDocRef, readDocText, type RawRequest,
} from "../src/inbound/doc-comments.js";
import { buildMeetingInvitePrompt, meetingInviteKey, parseMeetingInvite } from "../src/inbound/meeting-invite.js";
import { parseLifecycleEvent } from "../src/inbound/transport.js";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { DEFAULT_CONFIG, type DeliveryTarget, type SessionBackend } from "../src/types.js";

const BOT = "ou_bot";

const commentEvent = {
	event_id: "ev1",
	comment_id: "c1",
	reply_id: "r2",
	is_mentioned: true,
	notice_meta: {
		file_token: "doxcnABC123", file_type: "docx", notice_type: "add_reply",
		from_user_id: { open_id: "ou_alice" }, to_user_id: { open_id: BOT },
	},
};

test("评论事件：平铺与 event 包裹两种形态都能解析；经 transport 映射为 doc_comment", () => {
	const flat = parseDocCommentEvent(commentEvent);
	assert.equal(flat?.fileToken, "doxcnABC123");
	assert.equal(flat?.fromOpenId, "ou_alice");
	assert.equal(flat?.eventId, "ev1");
	const wrapped = parseDocCommentEvent({ header: { event_id: "ev9" }, event: { ...commentEvent, event_id: undefined } });
	assert.equal(wrapped?.eventId, "ev9");
	assert.equal(parseDocCommentEvent({ comment_id: "c" }), undefined, "缺文件信息的事件丢弃");
	const lifecycle = parseLifecycleEvent("doc_comment", commentEvent);
	assert.equal(lifecycle?.type, "doc_comment");
});

test("评论过滤：自己发的、不是发给本 bot 的、其他通知类型都跳过", () => {
	const event = parseDocCommentEvent(commentEvent)!;
	assert.equal(docCommentSkipReason(event, BOT), undefined);
	assert.equal(docCommentSkipReason({ ...event, fromOpenId: BOT }, BOT), "self_authored");
	assert.equal(docCommentSkipReason({ ...event, toOpenId: "ou_other" }, BOT), "not_addressed_to_bot");
	assert.equal(docCommentSkipReason({ ...event, noticeType: "resolve_comment" }, BOT), "notice_type:resolve_comment");
});

test("评论正文：去掉 @本bot，保留 @他人、文本与文档链接", () => {
	const text = commentReplyText({
		content: { elements: [
			{ type: "person", person: { user_id: BOT } },
			{ type: "text_run", text_run: { text: " 帮我  总结一下 " } },
			{ type: "person", person: { user_id: "ou_bob" } },
			{ type: "docs_link", docs_link: { url: "https://x.feishu.cn/docx/abc" } },
		] },
	}, BOT);
	assert.equal(text, "帮我 总结一下 @ou_bobhttps://x.feishu.cn/docx/abc");
	assert.equal(commentReplyText({ content: "not-json" }), "not-json");
});

function fakeRequest(routes: Record<string, (opts: Parameters<RawRequest>[0]) => unknown>): { request: RawRequest; calls: Array<Parameters<RawRequest>[0]> } {
	const calls: Array<Parameters<RawRequest>[0]> = [];
	return {
		calls,
		request: async (opts) => {
			calls.push(opts);
			for (const [prefix, handler] of Object.entries(routes)) if (opts.url.includes(prefix)) return handler(opts);
			return { code: 404, msg: "no route" };
		},
	};
}

test("评论上下文：batch_query 首次查不到会重试；提示词含标题、划词、评论串与当前评论", async () => {
	let attempts = 0;
	const { request } = fakeRequest({
		"comments/batch_query": () => {
			attempts += 1;
			if (attempts === 1) return { code: 0, data: { items: [] } };
			return { code: 0, data: { items: [{ is_whole: false, quote: "第三节的结论", reply_list: { replies: [
				{ user_id: "ou_bob", content: { elements: [{ type: "text_run", text_run: { text: "这里数据对吗" } }] } },
				{ user_id: BOT, content: { elements: [{ type: "text_run", text_run: { text: "我看一下" } }] } },
				{ user_id: "ou_alice", content: { elements: [{ type: "person", person: { user_id: BOT } }, { type: "text_run", text_run: { text: "请核对并给出修改建议" } }] } },
			] } }] } };
		},
		"metas/batch_query": () => ({ code: 0, data: { metas: [{ title: "周报", url: "https://x.feishu.cn/docx/doxcnABC123" }] } }),
	});
	const event = parseDocCommentEvent(commentEvent)!;
	const ctx = await fetchDocCommentContext(request, event, { botOpenId: BOT, retryDelayMs: 1 });
	assert.ok(ctx);
	assert.equal(attempts, 2);
	assert.equal(ctx.title, "周报");
	assert.equal(ctx.thread[1].isBot, true);
	const prompt = buildDocCommentPrompt(event, ctx);
	assert.match(prompt, /《周报》/);
	assert.match(prompt, /\[划词引用\] 第三节的结论/);
	assert.match(prompt, /ou_bob: 这里数据对吗/);
	assert.match(prompt, /（你）: 我看一下/);
	assert.ok(prompt.trimEnd().endsWith("请核对并给出修改建议"), "当前评论放最后");
	assert.equal(docCommentChatId("doxcnABC123"), "doc:doxcnABC123");
});

test("评论上下文：一直查不到返回 undefined（不开任务）", async () => {
	const { request } = fakeRequest({ "comments/batch_query": () => ({ code: 1069301, msg: "not found" }) });
	assert.equal(await fetchDocCommentContext(request, parseDocCommentEvent(commentEvent)!, { retries: 1, retryDelayMs: 1 }), undefined);
});

test("评论回复：转义 & < >；长文按行切片；评论不可回复（1069302）时退化为全文评论", async () => {
	assert.deepEqual(chunkCommentText("a\nb\nc", 3), ["a\nb", "c"]);
	const target: DeliveryTarget = { kind: "doc_comment", fileToken: "doxcnABC123", fileType: "docx", commentId: "c1", isWhole: false };
	const ok = fakeRequest({ "/replies": () => ({ code: 0 }) });
	assert.equal(await deliverDocCommentReply(ok.request, target, "a < b & c"), true);
	const sentText = ((ok.calls[0].data as { content: { elements: Array<{ text_run: { text: string } }> } }).content.elements[0].text_run.text);
	assert.equal(sentText, "a &lt; b &amp; c");

	const resolved = fakeRequest({ "/replies": () => ({ code: 1069302, msg: "reply not allowed" }), "/new_comments": () => ({ code: 0 }) });
	assert.equal(await deliverDocCommentReply(resolved.request, target, "x".repeat(4_500)), true);
	assert.deepEqual(resolved.calls.map((call) => call.url.split("/").pop()), ["replies", "new_comments", "new_comments"], "退化后后续分片都走全文评论");

	const broken = fakeRequest({ "/replies": () => ({ code: 99991672, msg: "no permission" }) });
	assert.equal(await deliverDocCommentReply(broken.request, target, "hi"), false);
});

test("feishu_doc_read：docx 链接、wiki 链接（换成 obj_token）、非 docx 与失败都有明确结果", async () => {
	assert.deepEqual(parseDocRef("https://x.feishu.cn/docx/AbC123xyz0?from=a"), { token: "AbC123xyz0", wiki: false });
	assert.deepEqual(parseDocRef("https://x.feishu.cn/wiki/Wk123456789"), { token: "Wk123456789", wiki: true });
	assert.equal(parseDocRef("随便一句话"), undefined);
	const { request, calls } = fakeRequest({
		"wiki/v2/spaces/get_node": () => ({ code: 0, data: { node: { obj_token: "DocReal12345", obj_type: "docx" } } }),
		"/raw_content": (opts) => opts.url.includes("DocReal12345") ? { code: 0, data: { content: "正文".repeat(10) } } : { code: 1770002, msg: "not found" },
	});
	const wiki = await readDocText(request, "https://x.feishu.cn/wiki/Wk123456789", 5);
	assert.deepEqual(wiki, { ok: true, text: "正文正文正", truncated: true });
	assert.ok(calls.some((call) => call.url.includes("/documents/DocReal12345/raw_content")));
	const missing = await readDocText(request, "https://x.feishu.cn/docx/Missing12345");
	assert.equal(missing.ok, false);
	const sheet = fakeRequest({ "get_node": () => ({ code: 0, data: { node: { obj_token: "S1234567890", obj_type: "sheet" } } }) });
	const notDocx = await readDocText(sheet.request, "https://x.feishu.cn/wiki/Wk123456789");
	assert.equal(notDocx.ok, false);
});

test("会议邀请：平铺与 body.content 包裹都能解析；提示词含会议信息；去重键稳定", () => {
	const flat = parseMeetingInvite({
		event_id: "ev-m",
		meeting: { id: "m1", topic: "周会", meeting_no: "123456789", start_time: "1790000000", host_user: { user_name: "Host" } },
		inviter: { id: { open_id: "ou_alice" }, user_name: "Alice" },
	});
	assert.equal(flat?.meetingNo, "123456789");
	assert.equal(flat?.startTime, 1_790_000_000_000, "秒级时间戳换成毫秒");
	assert.equal(meetingInviteKey(flat!), "vc_invite:ev-m");
	const wrapped = parseMeetingInvite({
		event: { body: { content: [{ contentType: "application/json", data: JSON.stringify({ meeting: { id: "m2", meeting_no: "987" }, inviter: { id: { open_id: "ou_bob" } } }) }] } },
	});
	assert.equal(wrapped?.inviterOpenId, "ou_bob");
	assert.equal(meetingInviteKey(wrapped!), "vc_invite:m2:ou_bob");
	assert.equal(parseMeetingInvite({ meeting: { meeting_no: "1" } }), undefined, "没有邀请人不处理（回复无处可去）");
	const prompt = buildMeetingInvitePrompt(flat!, () => "10:00");
	assert.match(prompt, /周会/);
	assert.match(prompt, /邀请人：Alice/);
	assert.match(prompt, /开始时间：10:00/);
	assert.equal(parseLifecycleEvent("meeting_invite", { meeting: { meeting_no: "1" }, inviter: { id: { open_id: "ou_x" } } })?.type, "meeting_invite");
});

function externalHarness(reply: string | Error) {
	const dir = mkdtempSync(join(tmpdir(), "doc-comment-run-"));
	const sent: string[] = [];
	const durable: string[] = [];
	const delivered: Array<{ target: DeliveryTarget; text: string }> = [];
	let listener: ((event: unknown) => void) | undefined;
	let activeTools: string[] | undefined;
	const handle: Awaited<ReturnType<SessionBackend["createSession"]>> = {
		sessionId: "sid",
		async prompt() {
			if (reply instanceof Error) throw reply;
			listener?.({ type: "message_end", message: { role: "assistant", id: "a1", content: reply, stopReason: "stop" } });
			return undefined;
		},
		subscribe(fn: (event: unknown) => void) { listener = fn; return () => { listener = undefined; }; },
		async abort() {},
		async dispose() {},
		allToolNames: () => ["read", "grep", "bash", "edit"],
		setActiveTools: (names: string[]) => { activeTools = names; },
	} as never;
	const manager = new ConversationManager({
		config: { ...DEFAULT_CONFIG, streamingCard: { enabled: true, throttleMs: 1_000 }, footer: { enabled: true, showCost: true }, allowChats: [] },
		sessionDir: dir,
		sessionBackend: { async createSession() { return handle; } },
		sender: { async send(_chatId: string, text: string) { sent.push(text); return { success: true, messageId: "om_x" }; } } as never,
		durableOutbox: { enqueue(_chatId, text) { durable.push(text); return ["e1"]; } },
		rawRequest: async () => { throw new Error("卡片不应被创建"); },
		deliverExternal: async (target, text) => { delivered.push({ target, text }); return true; },
	});
	return { manager, sent, durable, delivered, tools: () => activeTools, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const target: DeliveryTarget = { kind: "doc_comment", fileToken: "doxcnABC123", fileType: "docx", commentId: "c1", isWhole: false };

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timeout");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

test("评论任务：不发进度/卡片/页脚，回答经 deliverExternal 回到评论区；工具缺省只读", async () => {
	const h = externalHarness("建议把第三节的数字改成 42。");
	try {
		await h.manager.route({
			messageId: "doccomment:c1:r2", chatId: "doc:doxcnABC123", chatType: "group", senderId: "ou_alice",
			isBot: false, msgType: "text", text: "请核对", mentions: [], resources: [], raw: undefined, ts: Date.now(),
			synthetic: true, replyTarget: null, deliverTo: target,
		}, { behavior: "queue" });
		await waitFor(() => h.delivered.length > 0);
		assert.deepEqual(h.delivered, [{ target, text: "建议把第三节的数字改成 42。" }]);
		assert.deepEqual(h.sent, [], "不向虚拟会话发进度消息");
		assert.deepEqual(h.durable, [], "不走 outbox（虚拟会话 id 不是飞书会话）");
		assert.deepEqual(h.tools(), ["read", "grep"], "评论区没有审批卡可点：缺省只读");
	} finally { h.cleanup(); }
});

test("评论任务失败：错误提示也回到评论区，而不是发往虚拟会话", async () => {
	const h = externalHarness(new Error("429 Too Many Requests"));
	try {
		await h.manager.route({
			messageId: "doccomment:c1:r3", chatId: "doc:doxcnABC123", chatType: "group", senderId: "ou_alice",
			isBot: false, msgType: "text", text: "请核对", mentions: [], resources: [], raw: undefined, ts: Date.now(),
			synthetic: true, replyTarget: null, deliverTo: target,
		}, { behavior: "queue" });
		await waitFor(() => h.delivered.length > 0);
		assert.match(h.delivered[0].text, /^处理出错：模型服务限流/);
		assert.deepEqual(h.durable, []);
	} finally { h.cleanup(); }
});
