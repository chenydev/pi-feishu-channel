/**
 * 模型切换历史（持久化）—— `/model` 卡片的「最近使用」与「快速切换」排序依据。
 *
 * 排序用**带衰减的频率**而不是累计次数：累计次数会让两个月前用得多的模型永远排第一；
 * 每次切换记 1 分，分数按半衰期（默认 14 天）指数衰减，最近常用的排前面，旧习惯自然淡出。
 * 同分按最近使用时间。只记模型标签、次数和时间，不含会话内容。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ModelUsageEntry {
	/** 累计切换次数（展示用，不参与排序）。 */
	count: number;
	lastUsedAt: number;
	/** 衰减后的频率分（截至 scoredAt）。 */
	score: number;
	scoredAt: number;
}

export interface ModelUsageOptions {
	file?: string;
	now?: () => number;
	halfLifeMs?: number;
	/** 最多保留多少个模型（按分数淘汰）。 */
	maxEntries?: number;
}

const DEFAULT_HALF_LIFE_MS = 14 * 24 * 60 * 60_000;

export class ModelUsageStore {
	private readonly entries = new Map<string, ModelUsageEntry>();
	private readonly now: () => number;
	private readonly halfLifeMs: number;
	private readonly maxEntries: number;

	constructor(private readonly options: ModelUsageOptions = {}) {
		this.now = options.now ?? Date.now;
		this.halfLifeMs = options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
		this.maxEntries = options.maxEntries ?? 50;
		this.load();
	}

	/** 记一次切换。 */
	record(label: string): void {
		const now = this.now();
		const entry = this.entries.get(label);
		this.entries.set(label, {
			count: (entry?.count ?? 0) + 1,
			lastUsedAt: now,
			score: (entry ? this.decayed(entry, now) : 0) + 1,
			scoredAt: now,
		});
		if (this.entries.size > this.maxEntries) {
			const weakest = [...this.entries].sort(([, a], [, b]) => this.decayed(a, now) - this.decayed(b, now))[0];
			if (weakest) this.entries.delete(weakest[0]);
		}
		this.persist();
	}

	/** 最近使用（最近在前）。 */
	recent(limit = 3): string[] {
		return [...this.entries].sort(([, a], [, b]) => b.lastUsedAt - a.lastUsedAt).slice(0, limit).map(([label]) => label);
	}

	/** 按衰减频率排序（高在前；同分按最近使用）。 */
	frequent(limit = 12): string[] {
		const now = this.now();
		return [...this.entries]
			.map(([label, entry]) => ({ label, score: this.decayed(entry, now), lastUsedAt: entry.lastUsedAt }))
			.sort((a, b) => (b.score - a.score) || (b.lastUsedAt - a.lastUsedAt))
			.slice(0, limit)
			.map((item) => item.label);
	}

	get(label: string): ModelUsageEntry | undefined {
		const entry = this.entries.get(label);
		return entry ? { ...entry } : undefined;
	}

	private decayed(entry: ModelUsageEntry, now: number): number {
		const elapsed = Math.max(0, now - entry.scoredAt);
		return entry.score * 0.5 ** (elapsed / this.halfLifeMs);
	}

	private load(): void {
		const file = this.options.file;
		if (!file || !existsSync(file)) return;
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Partial<ModelUsageEntry>>;
			for (const [label, entry] of Object.entries(raw)) {
				if (typeof entry?.lastUsedAt !== "number") continue;
				this.entries.set(label, {
					count: typeof entry.count === "number" ? entry.count : 1,
					lastUsedAt: entry.lastUsedAt,
					score: typeof entry.score === "number" ? entry.score : 1,
					scoredAt: typeof entry.scoredAt === "number" ? entry.scoredAt : entry.lastUsedAt,
				});
			}
		} catch {
			/* 文件损坏：从空历史开始（只影响按钮排序） */
		}
	}

	private persist(): void {
		const file = this.options.file;
		if (!file) return;
		try {
			mkdirSync(dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries), null, 2), { mode: 0o600 });
			renameSync(tmp, file);
		} catch {
			/* 写失败只影响重启后的排序 */
		}
	}
}
