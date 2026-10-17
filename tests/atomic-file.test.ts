/**
 * 原子写入：这些文件是「进程随时可能被杀」的长驻状态，写坏一次就等于状态丢了。
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWriteFile, atomicWriteJson } from "../src/runtime/atomic-file.js";

function dir(): string {
	return mkdtempSync(join(tmpdir(), "atomic-"));
}

test("原子写入：内容整体替换，权限默认 0600，且不留临时文件", () => {
	const root = dir();
	try {
		const file = join(root, "state.json");
		atomicWriteJson(file, { a: 1 });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1 });
		assert.equal(readFileSync(file, "utf8").endsWith("\n"), true, "默认带结尾换行（和仓库里的状态文件一致）");
		assert.equal(statSync(file).mode & 0o777, 0o600, "默认 0600：里面有会话/审批规则");
		atomicWriteJson(file, { a: 2 });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 2 });
		assert.deepEqual(readdirSync(root), ["state.json"], "不能留下临时文件");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("原子写入：目录不存在会自动建（多级）", () => {
	const root = dir();
	try {
		const file = join(root, "a", "b", "state.json");
		atomicWriteJson(file, { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ok: true });
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("原子写入：失败时不破坏旧内容，也不留临时文件", () => {
	const root = dir();
	const file = join(root, "state.json");
	try {
		writeFileSync(file, '{"old":true}\n');
		// 目标换成一个目录：rename 必然失败
		const blocked = join(root, "blocked");
		mkdirSync(join(blocked, "inner"), { recursive: true });
		assert.throws(() => atomicWriteJson(blocked, { a: 1 }));
		assert.deepEqual(readdirSync(root).sort(), ["blocked", "state.json"], "临时文件要清掉");
		assert.equal(readFileSync(file, "utf8"), '{"old":true}\n', "旧内容不能被碰到");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("原子写入：非 JSON 内容（JSONL）走 atomicWriteFile，可指定缩进与结尾换行", () => {
	const root = dir();
	try {
		const jsonl = join(root, "queue.jsonl");
		atomicWriteFile(jsonl, '{"id":1}\n{"id":2}\n');
		assert.equal(readFileSync(jsonl, "utf8"), '{"id":1}\n{"id":2}\n');

		const compact = join(root, "compact.json");
		atomicWriteJson(compact, { a: 1 }, { indent: 0, trailingNewline: false });
		assert.equal(readFileSync(compact, "utf8").includes("\n"), false, "紧凑 JSON 不带换行");

		const indented = join(root, "indented.json");
		atomicWriteJson(indented, { a: 1 }, { indent: 2 });
		assert.match(readFileSync(indented, "utf8"), /^\{\n {2}"a": 1\n\}\n$/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("原子写入：并发写同一个文件不会串内容", () => {
	const root = dir();
	try {
		const file = join(root, "state.json");
		// 同步实现：同一进程里串行跑，但临时文件名按 pid+序号区分，两次写不会互相覆盖
		for (let index = 0; index < 5; index += 1) atomicWriteJson(file, { index });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { index: 4 });
		assert.deepEqual(readdirSync(root), ["state.json"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
