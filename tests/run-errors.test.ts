import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRunError, newErrorId } from "../src/session/run-errors.js";

test("失败提示：错误按类别给出下一步建议，原文不外泄", () => {
	const cases: Array<[string, string, RegExp]> = [
		["This operation was aborted", "aborted", /已被中止/],
		["429 Too Many Requests", "rate_limit", /限流.*\/model/],
		["This model's maximum context length is 65536 tokens", "context_overflow", /\/compact.*\/new/],
		["401 invalid api key", "auth", /鉴权失败/],
		["fetch failed: ECONNRESET", "network", /网络/],
		["502 Bad Gateway", "provider", /暂时不可用/],
		["weird internal thing sk-secret", "unknown", /错误编号 E1/],
	];
	for (const [message, category, pattern] of cases) {
		const result = classifyRunError(message, "E1");
		assert.equal(result.category, category, message);
		assert.match(result.text, pattern);
		assert.ok(result.text.startsWith("处理出错："));
		assert.equal(result.text.includes("sk-secret"), false);
	}
});

test("失败提示：错误编号形如 E 开头的短串", () => {
	assert.match(newErrorId(123456789), /^E[0-9A-Z]{3,}$/);
});
