/**
 * 按人限流（默认关闭）：同一个人在滑动窗口里发太多条消息时，后面的直接丢。
 *
 * 为什么放在准入之后：被准入挡掉的消息本来就不花钱；这里要拦的是「已放行的人在刷屏」——
 * 每条都要建会话、调模型，一个卡住的客户端重连狂发就能把整个桥拖慢。
 *
 * 丢的时候**不回话**：对方正在刷屏，回一句只是放大流量。为什么被丢看
 * `/feishu dropstats`（`rate_limited`）与日志 `feishu.pipeline.drop`。
 */
export interface UserLimiterOptions {
	/** 每个用户每 60 秒最多几条；0 = 不限（默认）。也可以传函数，每次判定现读（配置热更立即生效）。 */
	perMinute?: number | (() => number);
	now?: () => number;
}

export interface UserLimiter {
	/** 是否放行；被拦时给「还要等多久」。 */
	allow(senderId: string): { ok: true } | { ok: false; retryAfterMs: number };
	/** 当前在窗口内的计数（诊断用）。 */
	size(): number;
	/** 丢掉过期窗口（长驻进程里 sender 数会慢慢变多）。 */
	prune(): void;
}

const WINDOW_MS = 60_000;

export function createUserLimiter(options: UserLimiterOptions = {}): UserLimiter {
	const perMinute = options.perMinute ?? 0;
	const limit = (): number => Math.max(0, typeof perMinute === "function" ? perMinute() : perMinute);
	const now = options.now ?? Date.now;
	const hits = new Map<string, number[]>();
	const allow = (senderId: string): { ok: true } | { ok: false; retryAfterMs: number } => {
		const cap = limit();
		if (cap === 0 || !senderId) return { ok: true };
		const at = now();
		const recent = (hits.get(senderId) ?? []).filter((time) => at - time < WINDOW_MS);
		if (recent.length >= cap) {
			hits.set(senderId, recent);
			// 最早那条离开窗口时才有名额
			const retryAfterMs = Math.max(0, WINDOW_MS - (at - (recent[0] ?? at)));
			return { ok: false, retryAfterMs };
		}
		recent.push(at);
		hits.set(senderId, recent);
		return { ok: true };
	};
	const prune = (): void => {
		const at = now();
		for (const [senderId, times] of hits) {
			const recent = times.filter((time) => at - time < WINDOW_MS);
			if (recent.length === 0) hits.delete(senderId);
			else hits.set(senderId, recent);
		}
	};
	return { allow, prune, size: () => hits.size };
}
