/**
 * 可选能力·超长回答转文件（longReply.asFile）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../../src/config.js";
import { longReplyFeature } from "../../src/features/long-reply.js";
import { featureHostFor } from "./helpers.js";

const input = (text: string) => ({ text, messageId: "m1", chatId: "oc_g", conversationKey: "oc_g" });

test("超长回答转文件·关：不提供挂接点（会话原样发送全文）", async () => {
	const { host } = await featureHostFor([longReplyFeature], {});
	assert.equal(host.first("replyAsFile"), undefined);
});

test("超长回答转文件·开：超过阈值时正文只放开头，全文作为附件；未超过时原样返回", async () => {
	const files: Array<{ path: string; dedupeKey: string }> = [];
	const { host, rt } = await featureHostFor([longReplyFeature], { longReply: { asFile: true, thresholdChars: 100, previewChars: 10 } }, {
		sendLocalFile: (_chatId, path, _opts, meta) => { files.push({ path, dedupeKey: meta.dedupeKey }); return { ok: true }; },
	});
	try {
		const replyAsFile = host.first("replyAsFile");
		assert.ok(replyAsFile);
		assert.equal(replyAsFile(input("短回答")), "短回答");
		const long = "长".repeat(500);
		const shown = replyAsFile(input(long));
		assert.match(shown, /^长{10}\n\n…（全文 500 字，完整内容见附件 reply-.*\.md）$/);
		assert.equal(files.length, 1);
		assert.equal(files[0].dedupeKey, "m1:final-file");
		assert.equal(readFileSync(files[0].path, "utf8"), long);
	} finally { rmSync(rt.homeDir, { recursive: true, force: true }); }
});

test("超长回答转文件·开：附件发送失败时退回原文", async () => {
	const { host } = await featureHostFor([longReplyFeature], { longReply: { asFile: true, thresholdChars: 10 } }, { sendLocalFile: () => ({ ok: false, error: "x" }) });
	const long = "长".repeat(50);
	assert.equal(host.first("replyAsFile")!(input(long)), long);
});

function oldExports(homeDir: string, count: number): string {
	const dir = resolvePaths(homeDir).exportsDir;
	mkdirSync(dir, { recursive: true });
	const base = Date.now() - 3 * 86_400_000;
	for (let i = 0; i < count; i += 1) {
		const file = join(dir, `reply-${String(i).padStart(4, "0")}.md`);
		writeFileSync(file, "内容");
		utimesSync(file, new Date(base + i * 1_000), new Date(base + i * 1_000));
	}
	return dir;
}

test("超长回答转文件·开：启动时回收导出附件，只留最近 200 份（不依赖会话归档开关）", async () => {
	const { host, rt, logs } = await featureHostFor([longReplyFeature], { longReply: { asFile: true } });
	try {
		const dir = oldExports(rt.homeDir, 205);
		await host.start();
		assert.equal(readdirSync(dir).length, 200);
		assert.equal(existsSync(join(dir, "reply-0000.md")), false, "最旧的删掉");
		assert.equal(existsSync(join(dir, "reply-0204.md")), true, "最新的保留");
		assert.ok(logs.includes("feishu.retention"));
		await host.stop();
	} finally { rmSync(rt.homeDir, { recursive: true, force: true }); }
});

test("超长回答转文件·关：不碰导出目录", async () => {
	const { host, rt } = await featureHostFor([longReplyFeature], {});
	try {
		const dir = oldExports(rt.homeDir, 205);
		await host.start();
		assert.equal(readdirSync(dir).length, 205);
	} finally { rmSync(rt.homeDir, { recursive: true, force: true }); }
});
