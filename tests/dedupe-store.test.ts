import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DedupeStore } from "../src/inbound/dedupe-store.js";

test("DedupeStore：TTL、容量、forget", () => {
	let now = 1_000;
	const store = new DedupeStore({ capacity: 2, ttlMs: 100, now: () => now });
	assert.equal(store.check("m1"), true);
	assert.equal(store.check("m1"), false);
	now += 101;
	assert.equal(store.check("m1"), true);
	assert.equal(store.check("m2"), true);
	assert.equal(store.check("m3"), true);
	assert.equal(store.check("m1"), true, "最旧记录被容量淘汰");
	store.forget("m1");
	assert.equal(store.check("m1"), true);
});

test("DedupeStore：跨重启保留，损坏行不影响有效记录", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-dedupe-"));
	const file = join(dir, "dedupe.jsonl");
	try {
		const first = new DedupeStore({ file, capacity: 10, ttlMs: 1_000, now: () => 5_000 });
		assert.equal(first.check("m1"), true);
		writeFileSync(file, `{"messageId":"m1","seenAt":5000}\n{broken\n`, "utf8");
		const restarted = new DedupeStore({ file, capacity: 10, ttlMs: 1_000, now: () => 5_100 });
		assert.equal(restarted.check("m1"), false);
		assert.equal(restarted.check("m2"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("入站去重：追加日志 —— check/forget 各追加一行，重启回放；超过阈值才压缩", async () => {
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "dedupe-log-"));
	try {
		const file = join(dir, "dedupe.jsonl");
		let now = 1_000;
		const store = new DedupeStore({ file, capacity: 40, ttlMs: 60_000, now: () => now });
		assert.equal(store.check("m1"), true);
		assert.equal(store.check("m2"), true);
		store.forget("m2");
		assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3, "每次变更只追加一行");
		const reloaded = new DedupeStore({ file, capacity: 40, ttlMs: 60_000, now: () => now });
		assert.equal(reloaded.check("m1"), false, "重启后仍认得 m1");
		assert.equal(reloaded.check("m2"), true, "forget 过的 m2 重启后可再处理");
		for (let i = 0; i < 200; i++) { now += 1; store.check(`x${i}`); }
		const lines = readFileSync(file, "utf8").trim().split("\n").length;
		assert.ok(lines <= 80 + 1, `日志被压缩（实际 ${lines} 行）`);
		assert.equal(store.size(), 40, "容量上限生效");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
