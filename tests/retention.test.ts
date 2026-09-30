import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { archiveOldSessions, tightenSessionPermissions } from "../src/runtime/retention.js";
import { KnownChatStore } from "../src/runtime/known-chat-store.js";

test("数据保留：会话文件收紧到 0600，目录 0700", () => {
	const dir = mkdtempSync(join(tmpdir(), "ret-"));
	try {
		writeFileSync(join(dir, "a.jsonl"), "{}", { mode: 0o644 });
		writeFileSync(join(dir, "note.txt"), "x", { mode: 0o644 });
		assert.equal(tightenSessionPermissions(dir), 1);
		assert.equal(statSync(join(dir, "a.jsonl")).mode & 0o777, 0o600);
		assert.equal(statSync(join(dir, "note.txt")).mode & 0o777, 0o644, "只动会话文件");
		assert.equal(statSync(dir).mode & 0o777, 0o700);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("数据保留：超期且未被指针引用的会话归档压缩；当前会话与未超期的不动", () => {
	const dir = mkdtempSync(join(tmpdir(), "ret-"));
	try {
		const now = Date.now();
		const old = (now - 100 * 86_400_000) / 1000;
		for (const name of ["old.jsonl", "current.jsonl", "fresh.jsonl"]) writeFileSync(join(dir, name), "{}");
		utimesSync(join(dir, "old.jsonl"), old, old);
		utimesSync(join(dir, "current.jsonl"), old, old);
		assert.deepEqual(archiveOldSessions({ dir, keep: new Set([join(dir, "current.jsonl")]), days: 90, now }), ["old.jsonl"]);
		assert.equal(existsSync(join(dir, "archive", "old.jsonl.gz")), true);
		assert.equal(existsSync(join(dir, "current.jsonl")), true);
		assert.equal(existsSync(join(dir, "fresh.jsonl")), true);
		assert.deepEqual(archiveOldSessions({ dir, keep: new Set(), days: 0, now }), [], "默认关闭");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("已知群：退群后从已知群里移除（不再补收）", () => {
	const dir = mkdtempSync(join(tmpdir(), "known-"));
	try {
		const store = new KnownChatStore(join(dir, "k.json"));
		store.add("oc_a");
		store.add("oc_a");
		store.add("oc_b");
		assert.equal(store.remove("oc_a"), true);
		assert.deepEqual(new KnownChatStore(join(dir, "k.json")).values(), ["oc_b"]);
		assert.equal(store.has("oc_b"), true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
