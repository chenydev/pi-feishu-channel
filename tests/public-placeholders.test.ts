/**
 * 公开仓库的护栏：**不得出现真实的飞书标识**。
 *
 * 仓库是公开的（GitHub `chenydev/pi-feishu-channel`），真实的 open_id / chat_id / app_id 一旦提交
 * 就等于公开了「某个租户的机器人身份」和「某个群的 id」—— 这两样都能被拿去试探接口。
 * 测试与文档里一律用占位符（`ou_…`、`oc_…`、`cli_…`）。
 *
 * 这条检查只拦「长度和字符集都像真 id」的串：占位符（短、带省略号）不会被误报，所以不需要维护
 * 白名单 —— 也不用把任何真实 id 写进代码（那样等于把要防的东西抄一遍）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

/** 真实 id 的形态：`ou_`/`oc_`/`cli_` 后跟 20 位以上小写十六进制。 */
const REAL_ID = /\b(?:ou_[0-9a-f]{20,}|oc_[0-9a-f]{20,}|cli_[0-9a-f]{14,})\b/g;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "exports"]);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) walk(full, out);
		else if (/\.(ts|js|mjs|json|md)$/.test(entry)) out.push(full);
	}
	return out;
}

test("公开仓库：源码/文档/测试里不能出现真实的飞书 id", () => {
	const hits: string[] = [];
	for (const file of walk(ROOT)) {
		const rel = relative(ROOT, file);
		if (rel === "tests/public-placeholders.test.ts") continue;
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(REAL_ID)) hits.push(`${rel}: ${match[0].slice(0, 12)}…`);
	}
	assert.deepEqual(hits, [], `这些地方像是真实 id，请换成占位符：\n${hits.join("\n")}`);
});
