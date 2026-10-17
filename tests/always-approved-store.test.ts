/**
 * 「始终批准」规则表（approval/always-approved-store.ts）：落盘往返、撤销、通配规则名拒绝。
 *
 * 通配规则名（PS 配置里的 `"*"`）曾能被写进这张表：它匹配任何值，落盘后任何会话、任何工具
 * 命中该规则都直接放行 —— 管理员点一次「始终批准」等于关掉整个审批。这里把这条边界钉住。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlwaysApprovedStore, isWildcardPattern } from "../src/approval/always-approved-store.js";

function tempFile(): { file: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "always-approved-"));
	return { file: join(dir, "always.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("始终批准：普通规则名落盘后重新加载仍然生效", () => {
	const { file, cleanup } = tempFile();
	try {
		const store = new AlwaysApprovedStore({ file });
		store.add({ pattern: "npm *", approvedBy: "ou_admin", conversationKey: "oc_1" });
		assert.equal(store.has("npm *"), true);
		assert.equal(store.has("git *"), false, "没批准过的规则不算");

		const reloaded = new AlwaysApprovedStore({ file });
		assert.equal(reloaded.has("npm *"), true);
		assert.deepEqual(reloaded.list().map((rule) => rule.pattern), ["npm *"]);
	} finally { cleanup(); }
});

test("始终批准：通配规则名不能写入（会放行全部同类请求）", () => {
	const { file, cleanup } = tempFile();
	try {
		const store = new AlwaysApprovedStore({ file });
		assert.throws(() => store.add({ pattern: "*" }), /通配/);
		assert.throws(() => store.add({ pattern: "**" }), /通配/);
		assert.equal(store.size, 0, "拒绝后不得留下痕迹");
		assert.equal(store.has("*"), false);
	} finally { cleanup(); }
});

test("始终批准：旧版本落盘的通配规则不再生效，并会在下次落盘时清掉", () => {
	const { file, cleanup } = tempFile();
	try {
		// 模拟旧版本写下的文件（那时不拦通配）
		writeFileSync(file, JSON.stringify({ version: 1, rules: [{ pattern: "*", approvedAt: 1 }, { pattern: "npm *", approvedAt: 2 }] }), "utf8");
		const store = new AlwaysApprovedStore({ file });
		assert.equal(store.has("*"), false, "通配规则不得再放行");
		assert.deepEqual(store.list().map((rule) => rule.pattern), ["npm *"], "列表里也不该出现一条实际无效的规则");

		store.add({ pattern: "git *" });
		const persisted = JSON.parse(readFileSync(file, "utf8")) as { rules: Array<{ pattern: string }> };
		assert.deepEqual(persisted.rules.map((rule) => rule.pattern).sort(), ["git *", "npm *"]);
	} finally { cleanup(); }
});

test("始终批准：撤销", () => {
	const { file, cleanup } = tempFile();
	try {
		const store = new AlwaysApprovedStore({ file });
		store.add({ pattern: "npm *" });
		assert.equal(store.remove("npm *"), true);
		assert.equal(store.remove("npm *"), false, "重复撤销返回 false");
		assert.equal(new AlwaysApprovedStore({ file }).has("npm *"), false);
	} finally { cleanup(); }
});

test("始终批准：通配规则名的识别", () => {
	for (const pattern of ["*", "**", " * "]) assert.equal(isWildcardPattern(pattern), true, pattern);
	for (const pattern of ["npm *", "*npm", "echo *", ""]) assert.equal(isWildcardPattern(pattern), false, pattern);
});
