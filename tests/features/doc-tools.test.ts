/**
 * 可选能力·云文档读取工具（docTools.enabled）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { docToolsFeature } from "../../src/features/doc-tools.js";
import type { FeishuTransport } from "../../src/inbound/transport.js";
import { featureHostFor } from "./helpers.js";

test("云文档读取·关：不提供工具", async () => {
	const { host } = await featureHostFor([docToolsFeature], {});
	assert.equal(host.first("readDoc"), undefined);
});

test("云文档读取·开：读取正文并按 maxChars 截断；无效链接返回错误", async () => {
	const { host, rt } = await featureHostFor([docToolsFeature], { docTools: { enabled: true, maxChars: 5 } });
	const urls: string[] = [];
	rt.transport = {
		rawRequest: async (opts: { url: string }) => { urls.push(opts.url); return { code: 0, data: { content: "0123456789" } }; },
	} as unknown as FeishuTransport;
	const readDoc = host.first("readDoc");
	assert.ok(readDoc);
	const result = await readDoc("https://x.feishu.cn/docx/AbCdEfGh123");
	assert.equal(result.isError, undefined);
	assert.match((result.content[0] as { text: string }).text, /^01234\n\n…（文档较长，已截断）$/);
	assert.deepEqual(urls, ["/open-apis/docx/v1/documents/AbCdEfGh123/raw_content"]);
	assert.equal((await readDoc("不是链接")).isError, true);
});
