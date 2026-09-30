#!/usr/bin/env node
/**
 * 结构指标：让重构进度可以用数字观测（docs/development/progress.md 里每一项的「改前 → 改后」）。
 *
 *   node scripts/metrics.mjs          # 表格
 *   node scripts/metrics.mjs --json   # JSON（便于对比）
 *
 * 只做静态统计，不执行任何源码。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...walk(path));
		else if (path.endsWith(".ts")) out.push(path);
	}
	return out;
}

const lines = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const count = (text, re) => (text.match(re) ?? []).length;
const read = (path) => readFileSync(join(root, path), "utf8");

const srcFiles = walk(join(root, "src"));
const testFiles = walk(join(root, "tests"));
const src = srcFiles.map((file) => ({ file: relative(root, file), text: readFileSync(file, "utf8") }));
const tests = testFiles.map((file) => readFileSync(file, "utf8"));

const index = read("src/index.ts");
const manager = read("src/session/conversation-manager.ts");
const INTERNAL_ID = /\b(?:[A-HP][0-9]?-[0-9]{2})\b/g;

const metrics = {
	src_files: src.length,
	src_lines: src.reduce((sum, { text }) => sum + lines(text), 0),
	index_lines: lines(index),
	/** 扩展入口函数里的闭包状态（一级缩进的 let）。 */
	index_closure_state: count(index, /^\tlet /gm),
	/** 扩展入口函数里的内部函数。 */
	index_inner_functions: count(index, /^\t(?:async )?function /gm),
	manager_lines: lines(manager),
	/** ConversationManager 上纯转发给 ConversationCommands 的方法。 */
	manager_forwarders: count(manager, /\(\.\.\.args: Parameters</g),
	tests: tests.reduce((sum, text) => sum + count(text, /^\s*test\(/gm), 0),
	/** 源码与测试中残留的内部编号（应为 0）。 */
	internal_id_refs: [...src.map(({ text }) => text), ...tests].reduce((sum, text) => sum + count(text, INTERNAL_ID), 0),
	largest_files: src
		.map(({ file, text }) => ({ file, lines: lines(text) }))
		.sort((a, b) => b.lines - a.lines)
		.slice(0, 5),
};

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(metrics, null, 2));
} else {
	for (const [key, value] of Object.entries(metrics)) {
		if (key === "largest_files") continue;
		console.log(`${key.padEnd(24)}${value}`);
	}
	console.log("largest_files");
	for (const { file, lines: n } of metrics.largest_files) console.log(`  ${String(n).padStart(5)}  ${file}`);
}
