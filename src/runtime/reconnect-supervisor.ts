/**
 * WS 重连监管：watchdog 轮询 + 指数退避（1s → 60s）+ 抖动。
 *
 * 必须避免 1Hz 重连风暴。它由三个行为叠加形成，一次真实断线之后就会自我维持、永不停止：
 * `reconnect()` 返回后立刻再调度（此时握手未完成、`isConnected()` 为 false，于是又排一次）；
 * 定时器触发时不复查连接、直接 `reconnect()`，把已经 ready 的连接强制关掉；
 * `onReady` 就把退避计数清零，延迟永远停在 1s。
 *
 * 约定：
 *   1. 定时器触发时先复查连接，已连上就放弃本次重连；
 *   2. 重连成功发起后不再同步补调度，由 watchdog 在握手宽限期之后判断；
 *      只有 `reconnect()` 抛错（transport 已不在运行、watchdog 接不住）才立即排下一次；
 *   3. 退避计数只在连接**稳定保持** `stableResetMs` 后清零，而不是一 ready 就清。
 *   4. SDK 自带重连开启时，SDK 正在自愈（`isSelfHealing()`）就不插手 —— 插手等于打断 SDK 的
 *      重连阶梯重来；只有 SDK 进入终态（failed/idle），或自愈超过 `selfHealMaxMs`，才整体重建。
 */

export interface ReconnectTarget {
	isRunning(): boolean;
	isConnected(): boolean;
	/** 最近一次 start() 的时间戳；0 表示已 ready 或已停止。 */
	getConnectStartedAt(): number;
	reconnect(): Promise<void>;
	/** SDK 正在自己重连（可选；未实现视为 false）。 */
	isSelfHealing?(): boolean;
}

export interface ReconnectSupervisorDeps {
	/** 桥处于运行态（started && !stopping）。 */
	isActive(): boolean;
	target(): ReconnectTarget | undefined;
	onScheduled?(attempt: number, delayMs: number): void;
	onError?(error: unknown): void;
	handshakeGraceMs?: number;
	maxDelayMs?: number;
	stableResetMs?: number;
	/** SDK 自愈的最长容忍时间，超过后强制整体重建（默认 5 分钟）。 */
	selfHealMaxMs?: number;
	/** 重连频率统计窗口（status 展示 `reconnectsInWindow`）。 */
	windowMs?: number;
	now?: () => number;
	random?: () => number;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ReconnectSupervisor {
	private attempts = 0;
	private total = 0;
	private recent: number[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private connectedSince: number | undefined;
	private disconnectedSince: number | undefined;
	private readonly graceMs: number;
	private readonly maxDelayMs: number;
	private readonly stableResetMs: number;
	private readonly windowMs: number;
	private readonly now: () => number;

	constructor(private deps: ReconnectSupervisorDeps) {
		this.graceMs = deps.handshakeGraceMs ?? 15_000;
		this.maxDelayMs = deps.maxDelayMs ?? 60_000;
		this.stableResetMs = deps.stableResetMs ?? 30_000;
		this.windowMs = deps.windowMs ?? 5 * 60_000;
		this.now = deps.now ?? Date.now;
	}

	/** 当前退避档位（连续未稳定的重连次数）。 */
	get backoffAttempts(): number {
		return this.attempts;
	}

	/** 进程内累计重连次数。 */
	get totalReconnects(): number {
		return this.total;
	}

	/** 最近窗口内的重连次数（>阈值即 flapping）。 */
	reconnectsInWindow(): number {
		this.pruneRecent();
		return this.recent.length;
	}

	get pending(): boolean {
		return this.timer !== undefined;
	}

	/** watchdog 周期调用（默认 1s）。 */
	tick(): void {
		const target = this.deps.target();
		if (!this.deps.isActive() || !target) return;
		const now = this.now();
		if (target.isConnected()) {
			this.connectedSince ??= now;
			this.disconnectedSince = undefined;
			if (this.attempts > 0 && now - this.connectedSince >= this.stableResetMs) this.attempts = 0;
			return;
		}
		this.connectedSince = undefined;
		this.disconnectedSince ??= now;
		if (!target.isRunning() || this.timer) return;
		if (target.isSelfHealing?.() && now - this.disconnectedSince < (this.deps.selfHealMaxMs ?? 5 * 60_000)) return;
		const connectingSince = target.getConnectStartedAt();
		// 握手宽限期内不判掉线：SDK 握手完成前 isConnected() 本来就是 false。
		if (connectingSince !== 0 && now - connectingSince <= this.graceMs) return;
		this.schedule();
	}

	cancel(): void {
		if (this.timer) (this.deps.clearTimer ?? clearTimeout)(this.timer);
		this.timer = undefined;
	}

	private schedule(): void {
		if (this.timer) return;
		const random = this.deps.random ?? Math.random;
		const delay = Math.min(1_000 * 2 ** this.attempts, this.maxDelayMs) + random() * 500;
		this.attempts += 1;
		this.deps.onScheduled?.(this.attempts, delay);
		const setTimer = this.deps.setTimer ?? setTimeout;
		this.timer = setTimer(() => { void this.fire(); }, delay);
		this.timer.unref?.();
	}

	private async fire(): Promise<void> {
		this.timer = undefined;
		const target = this.deps.target();
		if (!this.deps.isActive() || !target) return;
		// 排队期间已经恢复：绝不能再 reconnect —— 那会强制关掉一条健康连接。
		if (target.isConnected()) return;
		this.disconnectedSince = undefined;
		this.total += 1;
		this.recent.push(this.now());
		this.pruneRecent();
		try {
			await target.reconnect();
		} catch (error) {
			this.deps.onError?.(error);
			// start 抛错后 transport 不再 running，watchdog 不会接手，只能在这里继续退避。
			if (this.deps.isActive()) this.schedule();
		}
	}

	private pruneRecent(): void {
		const cutoff = this.now() - this.windowMs;
		while (this.recent.length > 0 && this.recent[0] < cutoff) this.recent.shift();
	}
}
