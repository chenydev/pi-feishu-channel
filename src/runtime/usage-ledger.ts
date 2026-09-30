/**
 * 按天用量记录（`usage-daily.jsonl`）。
 *
 * 每轮 run 结束追加一行计数（不含任何正文）；预算判定与 `/feishu usage week` 都从这里读。
 * 文件只追加、按行解析，坏行跳过；超过保留期的行在启动时压缩掉（默认保留 35 天）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UsageRecord {
	/** 本地日期（config.timezone），YYYY-MM-DD。 */
	date: string;
	at: number;
	chatId: string;
	conversationKey: string;
	senderId?: string;
	model?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** USD；模型没有费率时为 0。 */
	cost: number;
}

export interface UsageSummaryRow {
	key: string;
	runs: number;
	tokens: number;
	cost: number;
}

/** 某时刻在给定时区的 YYYY-MM-DD。 */
export function localDate(timestamp: number, timeZone?: string): string {
	try {
		const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
		const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
		return `${get("year")}-${get("month")}-${get("day")}`;
	} catch {
		return new Date(timestamp).toISOString().slice(0, 10);
	}
}

export class UsageLedger {
	private records: UsageRecord[] = [];
	private loaded = false;

	constructor(private readonly opts: { file?: string; timeZone?: string; now?: () => number; retentionDays?: number }) {}

	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		const file = this.opts.file;
		if (!file || !existsSync(file)) return;
		const cutoff = localDate(this.now() - (this.opts.retentionDays ?? 35) * 86_400_000, this.opts.timeZone);
		let dropped = 0;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as UsageRecord;
				if (typeof record.date !== "string" || typeof record.chatId !== "string") { dropped += 1; continue; }
				if (record.date < cutoff) { dropped += 1; continue; }
				this.records.push(record);
			} catch {
				dropped += 1;
			}
		}
		if (dropped > 0) {
			try {
				const tmp = `${file}.tmp`;
				writeFileSync(tmp, this.records.map((record) => JSON.stringify(record)).join("\n") + (this.records.length ? "\n" : ""), { mode: 0o600 });
				renameSync(tmp, file);
			} catch { /* 压缩失败不影响记账 */ }
		}
	}

	record(input: Omit<UsageRecord, "date" | "at">): UsageRecord {
		this.load();
		const at = this.now();
		const record: UsageRecord = { ...input, at, date: localDate(at, this.opts.timeZone) };
		this.records.push(record);
		if (this.opts.file) {
			try {
				mkdirSync(dirname(this.opts.file), { recursive: true });
				appendFileSync(this.opts.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
			} catch { /* 记账失败不影响回复 */ }
		}
		return record;
	}

	/** 某群今天的累计费用（USD）。 */
	costToday(chatId: string): number {
		this.load();
		const today = localDate(this.now(), this.opts.timeZone);
		let total = 0;
		for (const record of this.records) if (record.chatId === chatId && record.date === today) total += record.cost;
		return total;
	}

	/** 最近 N 天（含今天）按维度汇总，费用降序。 */
	summary(days: number, by: "chat" | "sender" | "date", filter?: (record: UsageRecord) => boolean): UsageSummaryRow[] {
		this.load();
		const from = localDate(this.now() - (days - 1) * 86_400_000, this.opts.timeZone);
		const rows = new Map<string, UsageSummaryRow>();
		for (const record of this.records) {
			if (record.date < from || (filter && !filter(record))) continue;
			const key = by === "chat" ? record.chatId : by === "sender" ? record.senderId ?? "?" : record.date;
			const row = rows.get(key) ?? { key, runs: 0, tokens: 0, cost: 0 };
			row.runs += 1;
			row.tokens += record.input + record.output + record.cacheRead + record.cacheWrite;
			row.cost += record.cost;
			rows.set(key, row);
		}
		return [...rows.values()].sort((a, b) => by === "date" ? a.key.localeCompare(b.key) : b.cost - a.cost);
	}
}

/** 预算判定：`warn` 是首次越过 80% 的提醒点（调用方负责"只提醒一次"）。 */
export function budgetState(spent: number, limit: number | undefined): "ok" | "warn" | "exceeded" {
	if (!limit || limit <= 0) return "ok";
	if (spent >= limit) return "exceeded";
	if (spent >= limit * 0.8) return "warn";
	return "ok";
}

export function formatUsageWeek(rows: { byDate: UsageSummaryRow[]; bySender: UsageSummaryRow[] }, names: (id: string) => string = (id) => id): string {
	if (rows.byDate.length === 0) return "最近 7 天没有用量记录。";
	const money = (usd: number) => `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
	const tokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
	const total = rows.byDate.reduce((acc, row) => ({ runs: acc.runs + row.runs, tokens: acc.tokens + row.tokens, cost: acc.cost + row.cost }), { runs: 0, tokens: 0, cost: 0 });
	return [
		`最近 7 天用量：${total.runs} 轮 · ${tokens(total.tokens)} tokens · ${money(total.cost)}`,
		"",
		"按天：",
		...rows.byDate.map((row) => `· ${row.key}　${row.runs} 轮　${tokens(row.tokens)}　${money(row.cost)}`),
		"",
		"按发起人（前 10）：",
		...rows.bySender.slice(0, 10).map((row) => `· ${names(row.key)}　${row.runs} 轮　${money(row.cost)}`),
	].join("\n");
}
