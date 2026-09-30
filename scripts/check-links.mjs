#!/usr/bin/env node
/**
 * 检查仓库内 markdown 文档的相对链接：目标文件必须存在。外部链接（http/https）与纯锚点不检查。
 *
 *   node scripts/check-links.mjs      # 有断链时退出码为 1
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", ".git"]);

function markdownFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
		else if (path.endsWith(".md")) out.push(path);
	}
	return out;
}

const broken = [];
for (const file of markdownFiles(root)) {
	const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
	for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
		if (/^(https?:|mailto:|#)/.test(target)) continue;
		const path = resolve(dirname(file), target.split("#")[0]);
		if (!existsSync(path)) broken.push(`${relative(root, file)} → ${target}`);
	}
}

if (broken.length > 0) {
	console.error(`断链 ${broken.length} 处：\n${broken.map((line) => `  ${line}`).join("\n")}`);
	process.exit(1);
}
console.log("链接检查通过");
