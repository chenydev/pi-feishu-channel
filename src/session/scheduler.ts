/**
 * 会话调度器 —— 从 ConversationManager 拆出的 pump/公平性逻辑。
 *
 * 不变式：
 * - 同一会话同一时刻最多一个 pump（`activeRun` 由调用方置位，pump 结束时复位）；
 * - 全局并发 pump 不超过 `maxActive()`，超出的会话按 FIFO 进入等待队列；
 * - 公平性：单次 pump 连续跑满 `turnBatch` 个 turn 且有人在等时让出执行槽，
 *   让出点只在两个完整 run 之间，绝不打断工具执行或审批等待。
 */

export interface SchedulableSession<I> {
	conversationKey: string;
	queue: I[];
	activeRun: boolean;
}

export interface SchedulerDeps<S, I> {
	maxActive(): number;
	isShuttingDown(): boolean;
	runTurn(session: S, item: I): Promise<void>;
	log?: (level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
}

export class SessionScheduler<S extends SchedulableSession<I>, I> {
	/** conversationKey → 正在执行的 turn。 */
	readonly activeItems = new Map<string, I>();
	/** 等待执行槽的会话（FIFO）。 */
	readonly waiting: S[] = [];
	/** 单次 pump 连续执行的 turn 上限。 */
	turnBatch = 4;
	private readonly running = new Set<Promise<void>>();
	private activeCount = 0;

	constructor(private readonly deps: SchedulerDeps<S, I>) {}

	get active(): number { return this.activeCount; }

	/** 正在运行的 pump（关闭时等它们收尾）。 */
	runningPumps(): Promise<void>[] { return [...this.running]; }

	/** 关闭时丢弃等待中的会话（它们的消息仍在待处理记录里，重启后恢复）。 */
	clearWaiting(): void { this.waiting.length = 0; }

	schedule(session: S): void {
		if (this.deps.isShuttingDown()) return;
		if (this.activeCount >= Math.max(1, this.deps.maxActive())) {
			if (!this.waiting.includes(session)) this.waiting.push(session);
			return;
		}
		this.activeCount += 1;
		const running = this.pump(session).finally(() => {
			this.activeCount -= 1;
			this.running.delete(running);
			const next = this.deps.isShuttingDown() ? undefined : this.waiting.shift();
			if (next) this.schedule(next);
		});
		this.running.add(running);
	}

	private async pump(session: S): Promise<void> {
		let processed = 0;
		try {
			while (!this.deps.isShuttingDown() && session.queue.length > 0) {
				if (processed > 0 && processed >= this.turnBatch && this.waiting.length > 0) {
					this.deps.log?.("info", "feishu.conv.pump_yield", {
						conversationKey: session.conversationKey,
						processed,
						waiting: this.waiting.length,
						queued: session.queue.length,
					});
					if (!this.waiting.includes(session)) this.waiting.push(session);
					break;
				}
				const item = session.queue.shift();
				if (!item) break;
				this.activeItems.set(session.conversationKey, item);
				try {
					await this.deps.runTurn(session, item);
					processed += 1;
				} catch (error) {
					// runTurn 自己已经兜住执行异常，能漏到这里的是收尾清理（待处理记录落盘、回调）抛错。
					// 不捕获的后果：循环直接跳出，队列里剩下的任务再也没有 pump 启动，
					// 而 schedule() 存下的 running 变成未处理的 rejection（Node 默认策略会退出进程）。
					this.deps.log?.("error", "feishu.conv.pump_failed", {
						conversationKey: session.conversationKey,
						queued: session.queue.length,
						error: error instanceof Error ? error.message : String(error),
					});
				} finally {
					this.activeItems.delete(session.conversationKey);
				}
			}
		} finally {
			session.activeRun = false;
		}
	}
}
