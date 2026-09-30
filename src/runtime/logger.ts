/**
 * 桥的日志：输出到 console（pi 会把扩展的 console 输出转进自己的日志），每行带固定前缀，
 * 事件名形如 `feishu.<模块>.<事件>`，便于 grep。
 */
export interface BridgeLogger {
	debug(msg: string, meta?: unknown): void;
	info(msg: string, meta?: unknown): void;
	warn(msg: string, meta?: unknown): void;
	error(msg: string, meta?: unknown): void;
}

export const LOG_PREFIX = "[feishu-bridge]";

export function createConsoleLogger(prefix = LOG_PREFIX): BridgeLogger {
	return {
		debug: (m, meta) => console.debug(`${prefix} ${m}`, meta ?? ""),
		info: (m, meta) => console.log(`${prefix} ${m}`, meta ?? ""),
		warn: (m, meta) => console.warn(`${prefix} ${m}`, meta ?? ""),
		error: (m, meta) => console.error(`${prefix} ${m}`, meta ?? ""),
	};
}
