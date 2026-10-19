/**
 * 进程级兜底：未处理的 promise rejection 记日志，不让进程退出。
 *
 * 桥是长驻服务：一条遗漏 `await` 的路径（平台请求、落盘、定时器回调）在 Node 默认策略下会
 * 直接把进程带走 —— 所有会话的进行中任务一起丢，而且日志里只有一行堆栈。装上兜底之后：
 * - 记一条 error（带堆栈）继续跑；
 * - 计数写进 `status.json`（`unhandledRejections`），`/feishu doctor` 会报警 ——
 *   兜底是为了「不因为一个疏漏全线中断」，不是为了把 bug 藏起来。
 *
 * 注意只兜 `unhandledRejection`：`uncaughtException` 之后进程状态未知，继续跑比重启更危险。
 *
 * 监听挂在整个 pi 宿主进程上，同进程里其它扩展的未处理 rejection 也会被拦下、不再让进程退出。
 * 这是有意的：桥所在的 `pi --mode rpc` 进程就是为飞书通道跑的，一个扩展的疏漏不该带走所有会话；
 * 日志里的堆栈能看出是谁的。桥停止时 `dispose()` 摘掉监听，恢复 Node 默认行为。
 */
import type { BridgeLogger } from "./logger.js";

export interface ProcessGuardHandle {
	/** 已拦下的 rejection 数（写进 status.json）。 */
	count(): number;
	/** 摘掉监听（桥停止时调用；重复调用安全）。 */
	dispose(): void;
}

/**
 * 处理函数本身（不挂监听）：单独暴露是为了能直接测，
 * 不必在测试进程里真的制造一个未处理 rejection（node:test 会把它判成失败）。
 */
export function createProcessGuard(log: BridgeLogger, onError?: (error: Error) => void): { handler: (reason: unknown) => void; count(): number } {
	let rejected = 0;
	const handler = (reason: unknown) => {
		rejected += 1;
		const error = reason instanceof Error ? reason : new Error(String(reason));
		// 只记前 800 字：堆栈太长会把同一条日志的其它字段挤掉
		log.error("feishu.process.unhandled_rejection", { error: error.message.slice(0, 800), stack: error.stack?.split("\n").slice(0, 6).join("\n") });
		try { onError?.(error); } catch { /* 回调失败不影响兜底 */ }
	};
	return { handler, count: () => rejected };
}

export function installProcessGuards(log: BridgeLogger, onError?: (error: Error) => void): ProcessGuardHandle {
	const guard = createProcessGuard(log, onError);
	process.on("unhandledRejection", guard.handler);
	return {
		count: guard.count,
		dispose: () => { process.off("unhandledRejection", guard.handler); },
	};
}
