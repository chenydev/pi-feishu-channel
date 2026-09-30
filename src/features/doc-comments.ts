/**
 * 云文档评论（`docComments.enabled`，默认关）：在云文档评论里 @ 机器人，
 * 在以文档为单位的虚拟会话里跑一轮，回答回复到评论区。
 *
 * 评论人必须是管理员或在 `docComments.allowUsers`（缺省用 `allowUsers`）里。
 * 事件解析在 inbound/doc-comments.ts；回复评论区走会话的外部投递（deliverExternal）。
 */
import { effectiveAdmins } from "../inbound/admit.js";
import { buildDocCommentPrompt, docCommentChatId, docCommentSkipReason, fetchDocCommentContext, type DocCommentEvent } from "../inbound/doc-comments.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import type { BridgeFeature } from "./feature.js";
import { createFirstSeen } from "./first-seen.js";

export const docCommentsFeature: BridgeFeature = {
	name: "docComments",
	enabled: (config) => config.docComments?.enabled === true,
	setup({ rt, log }) {
		const firstSeen = createFirstSeen();
		return {
			onLifecycleEvent: async (event) => {
				if (event.type === "doc_comment") await handleDocComment(rt, log, firstSeen, event.event);
			},
		};
	},
};

/** 云文档评论 @ 机器人 → 虚拟会话里跑一轮，回答回复到评论区。 */
async function handleDocComment(rt: BridgeRuntime, log: BridgeLogger, firstSeen: (key: string) => boolean, event: DocCommentEvent): Promise<void> {
	if (!rt.transport || !rt.convManager) return;
	const docComments = rt.config.docComments ?? {};
	const botOpenId = rt.transport.getBotIdentity().openId;
	const skip = docCommentSkipReason(event, botOpenId);
	if (skip) {
		log.debug("feishu.doc_comment.skipped", { reason: skip, commentId: event.commentId });
		return;
	}
	const sender = event.fromOpenId;
	const allowUsers = docComments.allowUsers ?? rt.config.allowUsers;
	if (!sender || !(effectiveAdmins(rt.config).includes(sender) || allowUsers.includes(sender))) {
		log.info("feishu.doc_comment.denied", { commentId: event.commentId, sender: sender ?? null, hint: "评论人不是管理员，也不在 docComments.allowUsers（缺省用 allowUsers）里" });
		return;
	}
	if (!firstSeen(`doc_comment:${event.eventId ?? `${event.commentId}:${event.replyId ?? ""}`}`)) return;
	const request = (opts: { url: string; method: string; params?: unknown; data?: unknown }) => rt.transport!.rawRequest(opts);
	const ctx = await fetchDocCommentContext(request, event, { botOpenId });
	if (!ctx) {
		log.warn("feishu.doc_comment.context_unavailable", { commentId: event.commentId, fileType: event.fileType, hint: "拉不到评论详情：检查应用的云文档评论读取权限，以及机器人是否有该文档的访问权限" });
		return;
	}
	log.info("feishu.doc_comment.accepted", { commentId: event.commentId, fileType: event.fileType, isWhole: ctx.isWhole, thread: ctx.thread.length });
	await rt.convManager.route({
		messageId: `doccomment:${event.commentId}:${event.replyId ?? event.eventId ?? Date.now()}`,
		chatId: docCommentChatId(event.fileToken), chatType: "group",
		senderId: sender, isBot: false, msgType: "text",
		text: buildDocCommentPrompt(event, ctx),
		mentions: [], resources: [], raw: undefined, ts: Date.now(),
		synthetic: true, replyTarget: null,
		deliverTo: { kind: "doc_comment", fileToken: event.fileToken, fileType: event.fileType, commentId: event.commentId, isWhole: ctx.isWhole },
	}, { behavior: "queue" });
}
