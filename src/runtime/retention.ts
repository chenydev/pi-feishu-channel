/**
 * 数据卫生 —— 会话文件权限收紧、超期历史会话归档。
 *
 * 会话记录含对话全文，但 Pi 以 0644 创建；桥启动时把存量收紧到 0600（目录 0700），
 * 每轮结束再补一次（新会话文件）。归档默认关闭（retention.sessionDays = 0）：
 * 超期且不被任何会话指针引用的 .jsonl 压缩进 `sessions/archive/`，不删除。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export function tightenSessionPermissions(dir: string): number {
	if (!existsSync(dir)) return 0;
	let changed = 0;
	try { chmodSync(dir, 0o700); } catch { /* 只读挂载等 */ }
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(dir, name);
		try {
			const mode = statSync(file).mode & 0o777;
			if (mode !== 0o600) { chmodSync(file, 0o600); changed += 1; }
		} catch { /* 并发删除 */ }
	}
	return changed;
}

export function archiveOldSessions(input: { dir: string; keep: ReadonlySet<string>; days: number; now?: number }): string[] {
	if (!input.days || input.days <= 0 || !existsSync(input.dir)) return [];
	const cutoff = (input.now ?? Date.now()) - input.days * 86_400_000;
	const archiveDir = join(input.dir, "archive");
	const archived: string[] = [];
	for (const name of readdirSync(input.dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(input.dir, name);
		if (input.keep.has(file)) continue;
		try {
			if (statSync(file).mtimeMs >= cutoff) continue;
			mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
			writeFileSync(join(archiveDir, `${name}.gz`), gzipSync(readFileSync(file)), { mode: 0o600 });
			unlinkSync(file);
			archived.push(name);
		} catch { /* 单个文件失败不影响其余 */ }
	}
	return archived;
}
