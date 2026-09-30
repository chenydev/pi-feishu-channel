/**
 * 共享请求预算与熔断。
 *
 * 目标：多会话/流式高负载时减少 API 风暴，把预算优先留给**最终交付**与**审批**，
 * 在平台限频或网络故障时进入冷却（而不是持续重试放大）。
 *
 * 语义边界（刻意保守）：
 * - 只有**流式更新**通道（live）会因预算不足被跳过 —— 它本来就是 best-effort；
 * - `final` / `approval` 不受熔断影响（它们不能丢，宁可慢也不能静默消失）；
 * - 熔断期间 durable 队列（outbox/pending）保持原样：不标记成功、不删除、不改 UUID；
 * - 平台限频返回的 `retryAfterMs` 会写入冷却时间，避免自造数字。
 */
export type BudgetCategory = "live" | "final" | "approval" | "other";

export interface RateBudgetOptions {
	/** 各类别每秒补充令牌数。 */
	rates?: Partial<Record<BudgetCategory, number>>;
	/** 各类别突发上限。 */
	bursts?: Partial<Record<BudgetCategory, number>>;
	/**
	 * 按作用域（会话）分桶时的**全局**上限（每秒补充数/突发）。
	 * 单会话令牌用 rates/bursts；多个会话同时流式时总量再受这里约束，避免互相饿死又不打爆 API。
	 */
	globalRates?: Partial<Record<BudgetCategory, number>>;
	globalBursts?: Partial<Record<BudgetCategory, number>>;
	/** 连续失败多少次后熔断（默认 3）。 */
	failureThreshold?: number;
	/** 熔断冷却时长（默认 30s；平台给出 retry-after 时取较大值）。 */
	cooldownMs?: number;
	now?: () => number;
}

interface BucketState {
	tokens: number;
	lastRefillAt: number;
	/** 因预算不足被跳过的次数（诊断用）。 */
	rejected: number;
}

export interface BudgetSnapshot {
	/** 熔断是否打开（打开时流式更新通道停发）。 */
	open: boolean;
	/** 熔断自动恢复时间（毫秒时间戳）。 */
	resumeAt?: number;
	/** 连续失败计数。 */
	failures: number;
	/** 各类别剩余令牌与被拒次数。 */
	categories: Record<string, { tokens: number; rejected: number }>;
}

const DEFAULT_RATES: Record<BudgetCategory, number> = { live: 2, final: 2, approval: 2, other: 1 };
/** 全局（跨会话）上限：飞书单应用编辑接口大约 5 QPS 量级，留出余量给 final/审批。 */
const DEFAULT_GLOBAL_RATES: Record<BudgetCategory, number> = { live: 5, final: 10, approval: 10, other: 3 };

/** final/approval 是硬需求：熔断不影响它们。 */
const PROTECTED: ReadonlySet<BudgetCategory> = new Set<BudgetCategory>(["final", "approval"]);

export class RateBudget {
	private buckets = new Map<BudgetCategory, BucketState>();
	/** 按作用域（会话）分的桶：键为 `${category}\u0000${scope}`。 */
	private scoped = new Map<string, BucketState>();
	private readonly rates: Record<BudgetCategory, number>;
	private readonly globalRates: Record<BudgetCategory, number>;
	private readonly globalBursts: Partial<Record<BudgetCategory, number>>;
	private readonly bursts: Partial<Record<BudgetCategory, number>>;
	private readonly failureThreshold: number;
	private readonly cooldownMs: number;
	private readonly now: () => number;
	private failures = 0;
	private resumeAt?: number;
	/** 半开探测：熔断期间只放行一次尝试。 */
	private probeUsed = false;

	constructor(options: RateBudgetOptions = {}) {
		this.rates = { ...DEFAULT_RATES, ...options.rates };
		this.bursts = options.bursts ?? {};
		this.globalRates = { ...DEFAULT_GLOBAL_RATES, ...options.globalRates };
		this.globalBursts = options.globalBursts ?? {};
		this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
		this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 30_000);
		this.now = options.now ?? Date.now;
	}

	/**
	 * 尝试获取一个令牌。
	 * - final/approval：始终放行（熔断也不阻断）；
	 * - live/other：熔断打开时拒绝；令牌不足时拒绝并给出建议等待时间。
	 */
	tryAcquire(category: BudgetCategory, scope?: string): { ok: boolean; retryAfterMs?: number; reason?: "cooldown" | "budget" } {
		if (PROTECTED.has(category)) return { ok: true };
		const now = this.now();
		if (this.isOpen(now)) {
			// 半开：放行一次探测请求
			if (!this.probeUsed) {
				this.probeUsed = true;
				return { ok: true };
			}
			return { ok: false, retryAfterMs: Math.max(0, (this.resumeAt ?? now) - now), reason: "cooldown" };
		}
		if (scope !== undefined) return this.acquireScoped(category, scope, now);
		const bucket = this.bucket(category, now);
		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			return { ok: true };
		}
		bucket.rejected += 1;
		const rate = Math.max(0.1, this.rates[category]);
		return { ok: false, retryAfterMs: Math.ceil(1_000 / rate), reason: "budget" };
	}

	/** 会话桶 + 全局桶都有令牌才放行（两个都扣）；拒绝时只记在拒绝方。 */
	private acquireScoped(category: BudgetCategory, scope: string, now: number): { ok: boolean; retryAfterMs?: number; reason?: "budget" } {
		const scopedKey = `${category}\u0000${scope}`;
		let own = this.scoped.get(scopedKey);
		if (!own) {
			own = { tokens: this.burst(category), lastRefillAt: now, rejected: 0 };
			this.scoped.set(scopedKey, own);
			if (this.scoped.size > 512) this.scoped.delete(this.scoped.keys().next().value!);
		} else {
			this.refillWith(own, this.rates[category], this.burst(category), now);
		}
		const global = this.bucket(category, now, true);
		if (own.tokens < 1) {
			own.rejected += 1;
			return { ok: false, retryAfterMs: Math.ceil(1_000 / Math.max(0.1, this.rates[category])), reason: "budget" };
		}
		if (global.tokens < 1) {
			global.rejected += 1;
			return { ok: false, retryAfterMs: Math.ceil(1_000 / Math.max(0.1, this.globalRates[category])), reason: "budget" };
		}
		own.tokens -= 1;
		global.tokens -= 1;
		return { ok: true };
	}

	/** 记录一次 API 结果（成功清零失败计数并关闭熔断）。 */
	record(outcome: { errorClass?: string; retryAfterMs?: number; ok?: boolean }): void {
		const now = this.now();
		if (outcome.ok) {
			this.failures = 0;
			this.resumeAt = undefined;
			this.probeUsed = false;
			return;
		}
		const transient = outcome.errorClass === "rate_limited" || outcome.errorClass === "network" || outcome.errorClass === "server";
		if (!transient) return;
		this.failures += 1;
		if (this.failures < this.failureThreshold) return;
		const cooldown = Math.max(this.cooldownMs, outcome.retryAfterMs ?? 0);
		this.resumeAt = now + cooldown;
		this.probeUsed = false;
	}

	/**
	 * 熔断是否处于冷却期。
	 * 冷却结束即视为半开成功：清除熔断状态、恢复正常预算（后续再失败会重新累计）。
	 */
	isOpen(now: number = this.now()): boolean {
		if (this.resumeAt === undefined) return false;
		if (now >= this.resumeAt) {
			this.resumeAt = undefined;
			this.failures = 0;
			this.probeUsed = false;
			return false;
		}
		return true;
	}

	/** 面向诊断的快照（doctor/status 用）。 */
	snapshot(): BudgetSnapshot {
		const now = this.now();
		const categories: BudgetSnapshot["categories"] = {};
		for (const [name, bucket] of this.buckets) {
			categories[name] = { tokens: Math.floor(this.refill(bucket, name as BudgetCategory, now).tokens), rejected: bucket.rejected };
		}
		for (const name of Object.keys(this.rates) as BudgetCategory[]) {
			if (!categories[name]) categories[name] = { tokens: Math.floor(this.burst(name)), rejected: 0 };
		}
		const open = this.resumeAt !== undefined;
		return {
			open,
			resumeAt: open ? this.resumeAt : undefined,
			failures: this.failures,
			categories,
		};
	}

	/** 恢复提示文案（用户可见；无熔断时返回 undefined）。 */
	cooldownNotice(): string | undefined {
		if (this.resumeAt === undefined) return undefined;
		const remaining = Math.max(0, this.resumeAt - this.now());
		return `限流冷却中，约 ${Math.ceil(remaining / 1_000)} 秒后恢复（最终交付不受影响）`;
	}

	private burst(category: BudgetCategory): number {
		return this.bursts[category] ?? 4;
	}

	/**
	 * 类别桶。`global=true` 时这个桶是跨会话的总量桶（按 globalRates 补充）；
	 * 不带作用域的旧调用方式也用同一个桶（按 rates 补充）—— 两种用法不会同时出现在同一类别上。
	 */
	private bucket(category: BudgetCategory, now: number, global = false): BucketState {
		const rate = global ? this.globalRates[category] : this.rates[category];
		const burst = global ? this.globalBursts[category] ?? Math.max(this.burst(category), rate * 2) : this.burst(category);
		const existing = this.buckets.get(category);
		if (existing) return this.refillWith(existing, rate, burst, now);
		const created: BucketState = { tokens: burst, lastRefillAt: now, rejected: 0 };
		this.buckets.set(category, created);
		return created;
	}

	private refill(bucket: BucketState, category: BudgetCategory, now: number): BucketState {
		return this.refillWith(bucket, this.rates[category], this.burst(category), now);
	}

	private refillWith(bucket: BucketState, rate: number, burst: number, now: number): BucketState {
		const elapsed = Math.max(0, now - bucket.lastRefillAt);
		if (elapsed > 0 && rate > 0) {
			bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / 1_000) * rate);
			bucket.lastRefillAt = now;
		}
		return bucket;
	}
}
