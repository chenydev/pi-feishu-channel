import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface DedupeRecord {
	messageId: string;
	seenAt: number;
	/** 追加日志里的撤销记录（forget）。 */
	forget?: boolean;
}

export interface DedupeStoreOptions {
	capacity: number;
	ttlMs: number;
	file?: string;
	now?: () => number;
}

/**
 * 带 TTL、容量上限的入站 message_id 去重。
 *
 * 落盘是**追加日志**（每次 check/forget 追加一行，O(1)），日志行数超过容量的 2 倍时
 * 才原子重写一次快照。不要改回每条消息重写整份快照：容量 4096 时每条消息都同步写整个文件，会阻塞事件循环。
 * 启动时按顺序回放：后写的覆盖先写的，forget 行删除记录。
 */
export class DedupeStore {
	/** Map 的插入顺序 = 首见时间顺序（只在首次/过期后插入），prune 可以从头部提前结束。 */
	private seen = new Map<string, number>();
	private readonly now: () => number;
	private logLines = 0;

	constructor(private options: DedupeStoreOptions) {
		this.now = options.now ?? Date.now;
		this.load();
	}

	/** 返回 true 表示首次见到；成功返回前已持久化。 */
	check(messageId: string): boolean {
		const now = this.now();
		this.prune(now);
		const seenAt = this.seen.get(messageId);
		if (seenAt !== undefined && now - seenAt <= this.options.ttlMs) return false;
		this.seen.delete(messageId);
		this.seen.set(messageId, now);
		this.prune(now);
		this.append({ messageId, seenAt: now });
		return true;
	}

	/** 下游登记失败时撤销 reservation，使平台重投可再次处理。 */
	forget(messageId: string): void {
		if (!this.seen.delete(messageId)) return;
		this.append({ messageId, seenAt: this.now(), forget: true });
	}

	size(): number {
		return this.seen.size;
	}

	private prune(now: number): void {
		for (const [messageId, seenAt] of this.seen) {
			if (now - seenAt <= this.options.ttlMs) break;
			this.seen.delete(messageId);
		}
		let overflow = this.seen.size - Math.max(1, this.options.capacity);
		if (overflow <= 0) return;
		for (const messageId of this.seen.keys()) {
			if (overflow-- <= 0) break;
			this.seen.delete(messageId);
		}
	}

	private load(): void {
		if (!this.options.file || !existsSync(this.options.file)) return;
		try {
			const records: DedupeRecord[] = [];
			for (const line of readFileSync(this.options.file, "utf8").split("\n").filter(Boolean)) {
				try {
					const record = JSON.parse(line) as DedupeRecord;
					if (record.messageId && Number.isFinite(record.seenAt)) records.push(record);
				} catch { /* skip corrupt line */ }
			}
			// 旧快照格式不保证按时间排序：先排序再回放，保证 Map 插入顺序即时间顺序
			records.sort((a, b) => a.seenAt - b.seenAt);
			for (const record of records) {
				this.seen.delete(record.messageId);
				if (!record.forget) this.seen.set(record.messageId, record.seenAt);
			}
			this.logLines = records.length;
			this.prune(this.now());
		} catch { /* unreadable snapshot starts empty */ }
	}

	private append(record: DedupeRecord): void {
		if (!this.options.file) return;
		if (this.logLines >= Math.max(64, this.options.capacity * 2)) {
			this.compact();
			return;
		}
		mkdirSync(dirname(this.options.file), { recursive: true });
		appendFileSync(this.options.file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
		this.logLines += 1;
	}

	/** 原子重写快照（当前内存状态已包含本次变更）。 */
	private compact(): void {
		if (!this.options.file) return;
		mkdirSync(dirname(this.options.file), { recursive: true });
		const output = [...this.seen].map(([messageId, seenAt]) => JSON.stringify({ messageId, seenAt })).join("\n");
		const tmp = `${this.options.file}.tmp`;
		writeFileSync(tmp, output ? `${output}\n` : "", { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, this.options.file);
		this.logLines = this.seen.size;
	}
}
