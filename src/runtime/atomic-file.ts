/**
 * 原子写入：先写同目录临时文件，再 `rename` 覆盖目标。
 *
 * 为什么需要它：这些文件（待处理记录、出站队列、审批规则、提问卡、cron、用量账本…）都是
 * 「进程随时可能被杀」的长驻状态。直接 `writeFileSync` 覆盖，中途崩掉会留下半截文件；
 * 重启时读到半截 JSON 只能当空表处理 —— 用户看到的就是「消息丢了 / 审批规则没了」。
 *
 * 同分区 `rename` 是原子的：读到的永远是**旧的完整内容**或**新的完整内容**。
 * 这段逻辑原来在六个模块里各写了一遍（差异只在缩进、权限、内容形态），收敛到这里，
 * 新增状态文件时直接用，别再手写一遍。
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

let counter = 0;

export interface AtomicWriteOptions {
	/** 文件权限，默认 0600（里面有会话、审批规则、凭据引用，不该给同机其他用户看）。 */
	mode?: number;
	/** 写完是否 `fsync`（默认 true；关机/断电也要保住的内容需要它）。 */
	durable?: boolean;
}

/** 写文件（内容自己拼好，例如 JSONL）。失败时清掉临时文件并抛出。 */
export function atomicWriteFile(file: string, data: string, options: AtomicWriteOptions = {}): void {
	mkdirSync(dirname(file), { recursive: true });
	// 临时文件名带 pid 和序号：两个进程/两次写入撞到同一个临时文件会把内容写串
	counter += 1;
	const tmp = `${file}.${process.pid}.${counter}.tmp`;
	try {
		const fd = openSync(tmp, "w", options.mode ?? 0o600);
		try {
			writeSync(fd, data);
			if (options.durable !== false) fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, file);
	} catch (error) {
		try { unlinkSync(tmp); } catch { /* 临时文件可能没建起来 */ }
		throw error;
	}
}

/** 写 JSON（默认 1 空格缩进 + 结尾换行，与仓库里现有状态文件的格式一致）。 */
export function atomicWriteJson(file: string, value: unknown, options: AtomicWriteOptions & { indent?: number; trailingNewline?: boolean } = {}): void {
	const text = JSON.stringify(value, null, options.indent ?? 1);
	atomicWriteFile(file, options.trailingNewline === false ? text : `${text}\n`, options);
}
