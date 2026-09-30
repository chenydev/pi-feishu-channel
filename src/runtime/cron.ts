/**
 * 定时任务。
 *
 * - 表达式：标准 5 段（分 时 日 月 周），支持 `*`、`*\/n`、`a-b`、`a-b/n`、列表 `,`，以及
 *   `@hourly` / `@daily` / `@weekly` / `@monthly` 简写；按 `config.timezone` 的本地时间解释。
 *   不引入 croner：只需要 5 段语义，自己实现 ~100 行，少一个依赖面。
 * - 幂等：触发前先把"计划触发时刻"写进 `cron-jobs.json`（lastPlannedAt），再投递 ——
 *   进程在投递途中崩溃，重启后看到已记录的计划时刻就不会重复触发（宁可漏一次，不重复执行）。
 * - 错过的触发（停机期间）：默认跳过，并在下一次执行时注明"错过了 N 次"；`catchUp: "once"` 时补跑一次。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	domAny: boolean;
	dowAny: boolean;
}

const ALIASES: Record<string, string> = {
	"@hourly": "0 * * * *",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@weekly": "0 0 * * 0",
	"@monthly": "0 0 1 * *",
};

function parseField(raw: string, min: number, max: number, name: string): Set<number> {
	const out = new Set<number>();
	for (const part of raw.split(",")) {
		const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
		if (!match) throw new Error(`${name} 字段非法：${part}`);
		const step = match[4] ? Number.parseInt(match[4], 10) : 1;
		if (step < 1) throw new Error(`${name} 步长非法：${part}`);
		let from = min;
		let to = max;
		if (match[1] !== "*") {
			from = Number.parseInt(match[2], 10);
			to = match[3] !== undefined ? Number.parseInt(match[3], 10) : (match[4] ? max : from);
		}
		if (from < min || to > max || from > to) throw new Error(`${name} 超出范围 ${min}-${max}：${part}`);
		for (let value = from; value <= to; value += step) out.add(value);
	}
	return out;
}

export function parseCron(expression: string): CronFields {
	const expr = ALIASES[expression.trim().toLowerCase()] ?? expression.trim();
	const parts = expr.split(/\s+/);
	if (parts.length !== 5) throw new Error("需要 5 段：分 时 日 月 周（例如 \"0 9 * * 1-5\"）");
	const dow = parseField(parts[4], 0, 7, "周");
	if (dow.has(7)) { dow.delete(7); dow.add(0); }
	return {
		minute: parseField(parts[0], 0, 59, "分"),
		hour: parseField(parts[1], 0, 23, "时"),
		dom: parseField(parts[2], 1, 31, "日"),
		month: parseField(parts[3], 1, 12, "月"),
		dow,
		domAny: parts[2] === "*",
		dowAny: parts[4] === "*",
	};
}

interface LocalTime { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function localTime(timestamp: number, timeZone?: string): LocalTime {
	const key = timeZone ?? "";
	let fmt = formatters.get(key);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat("en-US", {
			timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
		});
		formatters.set(key, fmt);
	}
	const parts = fmt.formatToParts(new Date(timestamp));
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
	return {
		year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
		hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: WEEKDAYS[get("weekday")] ?? 0,
	};
}

function dayMatches(fields: CronFields, t: LocalTime): boolean {
	if (!fields.month.has(t.month)) return false;
	const dom = fields.dom.has(t.day);
	const dow = fields.dow.has(t.weekday);
	// 标准 cron：日与周都受限时取"或"，只限一个时取那一个
	if (!fields.domAny && !fields.dowAny) return dom || dow;
	if (!fields.domAny) return dom;
	if (!fields.dowAny) return dow;
	return true;
}

/** 严格晚于 `after` 的下一个触发时刻（整分钟，epoch ms）；一年内找不到返回 undefined。 */
export function nextFire(fields: CronFields, after: number, timeZone?: string): number | undefined {
	let t = Math.floor(after / 60_000) * 60_000 + 60_000;
	const limit = after + 366 * 86_400_000;
	while (t <= limit) {
		const local = localTime(t, timeZone);
		if (!dayMatches(fields, local)) {
			// 跳到本地次日 0 点附近（按分钟数估算；夏令时偏差由后续逐分钟校正吸收）
			t += ((23 - local.hour) * 60 + (60 - local.minute)) * 60_000;
			continue;
		}
		if (!fields.hour.has(local.hour)) {
			t += (60 - local.minute) * 60_000;
			continue;
		}
		if (!fields.minute.has(local.minute)) {
			t += 60_000;
			continue;
		}
		return t;
	}
	return undefined;
}

export interface CronJob {
	id: string;
	expression: string;
	text: string;
	chatId: string;
	chatType: "p2p" | "group" | "topic";
	threadId?: string;
	/** 创建人（合成消息的发送者；审批、发言人都按他算）。 */
	creatorId: string;
	createdAt: number;
	enabled: boolean;
	/** 最近一次已处理（触发或按错过跳过）的计划时刻。 */
	lastPlannedAt?: number;
	/** 待在下一次执行时说明的错过次数。 */
	missed?: number;
	runs?: number;
}

export interface CronFire {
	job: CronJob;
	plannedAt: number;
	missed: number;
}

export class CronScheduler {
	private jobs: CronJob[] = [];
	private timer?: ReturnType<typeof setInterval>;

	constructor(private readonly opts: {
		file?: string;
		timeZone?: () => string | undefined;
		now?: () => number;
		catchUp?: () => "skip" | "once";
		onFire: (fire: CronFire) => Promise<void>;
		log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
		tickMs?: number;
		/** 晚于计划时刻多久算"错过"（默认 2 分钟：tick 间隔 + 容错）。 */
		graceMs?: number;
	}) {
		this.load();
	}

	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}

	private load(): void {
		const file = this.opts.file;
		if (!file || !existsSync(file)) return;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { jobs?: CronJob[] };
			this.jobs = (parsed.jobs ?? []).filter((job) => {
				try { parseCron(job.expression); return typeof job.id === "string" && typeof job.chatId === "string"; } catch { return false; }
			});
		} catch (error) {
			this.opts.log?.("error", "feishu.cron.load_failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private persist(): void {
		const file = this.opts.file;
		if (!file) return;
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify({ jobs: this.jobs }, null, 2), { mode: 0o600 });
		renameSync(tmp, file);
	}

	list(chatId?: string): CronJob[] {
		return this.jobs.filter((job) => !chatId || job.chatId === chatId).map((job) => ({ ...job }));
	}

	add(input: Omit<CronJob, "id" | "createdAt" | "enabled">): CronJob {
		parseCron(input.expression);
		const job: CronJob = { ...input, id: randomUUID().slice(0, 8), createdAt: this.now(), enabled: true, lastPlannedAt: this.now() };
		this.jobs.push(job);
		try { this.persist(); } catch (error) { this.jobs.pop(); throw error; }
		return { ...job };
	}

	remove(id: string): boolean {
		const before = this.jobs.length;
		const previous = this.jobs;
		this.jobs = this.jobs.filter((job) => job.id !== id);
		if (this.jobs.length === before) return false;
		try { this.persist(); } catch (error) { this.jobs = previous; throw error; }
		return true;
	}

	setEnabled(id: string, enabled: boolean): boolean {
		const job = this.jobs.find((item) => item.id === id);
		if (!job) return false;
		const previous = { enabled: job.enabled, lastPlannedAt: job.lastPlannedAt };
		job.enabled = enabled;
		// 恢复时从"现在"起算，暂停期间的触发不算错过
		if (enabled) job.lastPlannedAt = this.now();
		try { this.persist(); } catch (error) { Object.assign(job, previous); throw error; }
		return true;
	}

	/** 下一次触发时刻（展示用）。 */
	nextFor(job: CronJob): number | undefined {
		try { return nextFire(parseCron(job.expression), Math.max(job.lastPlannedAt ?? job.createdAt, this.now() - 60_000), this.opts.timeZone?.()); } catch { return undefined; }
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => { void this.tick(); }, this.opts.tickMs ?? 20_000);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** 巡检一次（测试可直接调用）。返回本次触发的任务数。 */
	async tick(): Promise<number> {
		const now = this.now();
		const grace = this.opts.graceMs ?? 120_000;
		const zone = this.opts.timeZone?.();
		const fires: CronFire[] = [];
		for (const job of this.jobs) {
			if (!job.enabled) continue;
			const fields = parseCron(job.expression);
			let cursor = job.lastPlannedAt ?? job.createdAt;
			let due: number | undefined;
			let skipped = 0;
			for (let i = 0; i < 10_000; i++) {
				const next = nextFire(fields, cursor, zone);
				if (next === undefined || next > now) break;
				if (due !== undefined) skipped += 1;
				due = next;
				cursor = next;
			}
			if (due === undefined) continue;
			const late = now - due > grace;
			const catchUp = this.opts.catchUp?.() ?? "skip";
			// 最后一个到期点也已经"过时"（停机期间错过）：默认跳过，只记次数
			if (late && catchUp === "skip") {
				job.lastPlannedAt = due;
				job.missed = (job.missed ?? 0) + skipped + 1;
				this.opts.log?.("info", "feishu.cron.missed", { jobId: job.id, missed: skipped + 1 });
				continue;
			}
			job.lastPlannedAt = due;
			const missed = (job.missed ?? 0) + skipped;
			job.missed = 0;
			job.runs = (job.runs ?? 0) + 1;
			fires.push({ job: { ...job }, plannedAt: due, missed });
		}
		if (fires.length === 0) {
			// 只有"跳过"也要落盘（否则重启后会再算一遍错过次数）
			try { this.persist(); } catch { /* 下次再写 */ }
			return 0;
		}
		// 先落盘计划时刻，再投递：崩溃在投递途中也不会重复触发
		try {
			this.persist();
		} catch (error) {
			this.opts.log?.("error", "feishu.cron.persist_failed", { error: error instanceof Error ? error.message : String(error) });
			return 0;
		}
		for (const fire of fires) {
			try {
				await this.opts.onFire(fire);
				this.opts.log?.("info", "feishu.cron.fired", { jobId: fire.job.id, plannedAt: fire.plannedAt, missed: fire.missed });
			} catch (error) {
				this.opts.log?.("warn", "feishu.cron.fire_failed", { jobId: fire.job.id, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return fires.length;
	}
}

/** `/cron add "<表达式>" <任务>` 的参数解析（表达式可以用引号包住，也可以是 @daily 这类简写）。 */
export function parseCronAdd(rest: string): { expression: string; text: string } | undefined {
	const trimmed = rest.trim();
	const quoted = /^["“](.+?)["”]\s+([\s\S]+)$/.exec(trimmed);
	if (quoted) return { expression: quoted[1].trim(), text: quoted[2].trim() };
	const alias = /^(@\w+)\s+([\s\S]+)$/.exec(trimmed);
	if (alias) return { expression: alias[1], text: alias[2].trim() };
	const bare = /^((?:\S+\s+){4}\S+)\s+([\s\S]+)$/.exec(trimmed);
	if (bare) return { expression: bare[1], text: bare[2].trim() };
	return undefined;
}
