/**
 * 可选能力·云文档评论（docComments.enabled）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_OPEN_ID } from "../integration/extension-harness.js";
import { T, enabledIn, hasLogPrefix, withHarness } from "./helpers.js";

const commentFrom = (sender: string) => ({
	event_id: `ev_${sender}`, comment_id: "c1", is_mentioned: true,
	notice_meta: { file_token: "doc_1", file_type: "docx", notice_type: "add_comment", from_user_id: { open_id: sender }, to_user_id: { open_id: BOT_OPEN_ID } },
});

test("云文档评论·关：评论事件被忽略，没有任何评论日志", T, async () => {
	await withHarness({}, async (h) => {
		await h.event("drive.notice.comment_add_v1", commentFrom("ou_stranger"));
		assert.ok(!hasLogPrefix(h, "feishu.doc_comment"));
		assert.ok(!enabledIn(h).status.includes("docComments"));
	});
});

test("云文档评论·开：评论人不在白名单时拒绝并说明原因", T, async () => {
	await withHarness({ docComments: { enabled: true } }, async (h) => {
		assert.ok(enabledIn(h).status.includes("docComments"));
		await h.event("drive.notice.comment_add_v1", commentFrom("ou_stranger"));
		const denied = h.logs.find((l) => l.event === "feishu.doc_comment.denied");
		assert.ok(denied, "应记录 feishu.doc_comment.denied");
		assert.match(String((denied.meta as { hint?: string }).hint), /docComments\.allowUsers/);
	});
});
