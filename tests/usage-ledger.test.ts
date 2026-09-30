import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UsageLedger, budgetState, formatUsageWeek, localDate } from "../src/runtime/usage-ledger.js";

const base = { conversationKey: "k", input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

test("用量记录：按天记账，今天的费用按群累计", () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-"));
	try {
		let now = Date.UTC(2026, 8, 28, 4);
		const file = join(dir, "u.jsonl");
		const ledger = new UsageLedger({ file, timeZone: "Asia/Shanghai", now: () => now });
		ledger.record({ ...base, chatId: "oc_a", cost: 0.5 });
		ledger.record({ ...base, chatId: "oc_a", cost: 0.25 });
		ledger.record({ ...base, chatId: "oc_b", cost: 1 });
		assert.equal(ledger.costToday("oc_a"), 0.75);
		now += 86_400_000;
		assert.equal(ledger.costToday("oc_a"), 0, "跨天清零");
		// 重新加载：从文件恢复
		const reloaded = new UsageLedger({ file, timeZone: "Asia/Shanghai", now: () => now });
		const rows = reloaded.summary(7, "chat");
		assert.equal(rows[0]?.key, "oc_b");
		assert.equal(rows.find((row) => row.key === "oc_a")?.runs, 2);
		assert.equal(readFileSync(file, "utf8").includes("text"), false, "不含正文");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("用量记录：超出保留期与坏行在加载时被压缩掉", () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-"));
	try {
		const file = join(dir, "u.jsonl");
		const now = Date.UTC(2026, 8, 28);
		writeFileSync(file, [
			JSON.stringify({ ...base, chatId: "oc", cost: 1, date: "2026-01-01", at: 0 }),
			"not-json",
			JSON.stringify({ ...base, chatId: "oc", cost: 2, date: localDate(now, "UTC"), at: now }),
		].join("\n"));
		const ledger = new UsageLedger({ file, timeZone: "UTC", now: () => now });
		assert.equal(ledger.costToday("oc"), 2);
		assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("用量记录：预算状态与周报格式", () => {
	assert.equal(budgetState(1, undefined), "ok");
	assert.equal(budgetState(0.79, 1), "ok");
	assert.equal(budgetState(0.8, 1), "warn");
	assert.equal(budgetState(1, 1), "exceeded");
	const text = formatUsageWeek({ byDate: [{ key: "2026-09-28", runs: 2, tokens: 1500, cost: 0.5 }], bySender: [{ key: "ou_x", runs: 2, tokens: 1500, cost: 0.5 }] }, () => "张三");
	assert.match(text, /最近 7 天用量：2 轮 · 1.5k tokens/);
	assert.match(text, /张三/);
	assert.equal(formatUsageWeek({ byDate: [], bySender: [] }), "最近 7 天没有用量记录。");
});
