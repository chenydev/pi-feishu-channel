import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "../runtime/atomic-file.js";
import { randomUUID } from "node:crypto";
import type { FeishuInboundMessage } from "../types.js";

export interface PendingRecord {
	id: string;
	conversationKey: string;
	message: Omit<FeishuInboundMessage, "raw">;
	state: "claimed";
	owner: string;
	claimedAt: number;
	leaseUntil: number;
	attempts: number;
	/**
	 * auto   重放（纯推理 turn，重放安全）
	 * manual 越过工具边界，重放可能重复副作用 → 不重放，仅通知用户
	 * never  命令类消息（/new、/stop 等）→ 不重放也不通知：重放会重复副作用
	 *        （例如 /new 会再清一次上下文），而通知也没有意义（用户早知道结果）
	 */
	replayPolicy?: "auto" | "manual" | "never";
	/** 最近一次状态变更时间（合并/刷新时更新）。 */
	updatedAt?: number;
	/** 本条记录覆盖的原始 sourceMessageId（batch 合并后为整个窗口）。 */
	sourceMessageIds?: string[];
}

/**
 * 待处理记录（崩溃恢复用）。
 *
 * 文件是**追加式日志**：每行一条快照，`{"id":…,"removed":true}` 是删除标记，读取时按行重放、
 * 后写覆盖先写。原来每次变动（claim/merge/mark/ack）都要把全部记录重写一遍 —— 一条消息的成本
 * 是 O(待处理条数)，忙的时候每条都在写整表。改成追加后每次只写一行；行数膨胀到记录数的三倍
 * 以上时压实成一份完整快照（同样是原子写）。
 *
 * 旧格式（每行一条完整记录）天然兼容：它本来就是「快照 + 后写覆盖先写」。
 */
export class PendingStore {
	private records = new Map<string, PendingRecord>();
	private memberIndex = new Map<string, string>();
	/** 待写入的快照 / 删除标记（flush 时一次性追加）。 */
	private dirty = new Set<string>();
	private deleted = new Set<string>();
	/** 文件里当前有多少行（决定什么时候压实）。 */
	private lineCount = 0;
	private readonly owner = `${process.pid}:${randomUUID()}`;
	private readonly now: () => number;
	private readonly leaseMs: number;
	/** 待处理记录终结（ack）时回调，参数是消息 id（批合并的成员逐个回调）。 */
	private readonly onDone?: (messageId: string) => void;

	constructor(private file: string, options: { now?: () => number; leaseMs?: number; onDone?: (messageId: string) => void } = {}) {
		this.now = options.now ?? Date.now;
		this.leaseMs = options.leaseMs ?? 5 * 60_000;
		this.onDone = options.onDone;
		this.load();
	}

	claim(message: FeishuInboundMessage, conversationKey: string): string {
		const existing = this.records.get(message.messageId);
		if (existing) return existing.id;
		const now = this.now();
		const record: PendingRecord = {
			id: message.messageId,
			conversationKey,
			message: { ...message, raw: undefined } as Omit<FeishuInboundMessage, "raw">,
			state: "claimed",
			owner: this.owner,
			claimedAt: now,
			leaseUntil: now + this.leaseMs,
			attempts: 1,
			replayPolicy: "auto",
			updatedAt: now,
			sourceMessageIds: [message.messageId],
		};
		this.records.set(record.id, record);
		this.dirty.add(record.id);
		try {
			this.flush();
		} catch (error) {
			this.records.delete(record.id);
			this.dirty.delete(record.id);
			throw error;
		}
		return record.id;
	}

	/** 新进程可立即接管旧 owner；同进程仅接管 lease 已过期项。 */
	recoverable(): PendingRecord[] {
		const now = this.now();
		// never 档（命令类消息）在待处理记录层就排除：调用方不需要再判断一次，
		// 也就不会出现"某个调用方忘了过滤 → 命令被重放"的隐患。
		// 旧进程遗留的 never 记录（命令处理中崩溃，或旧版本从不 ack）直接清掉，
		// 否则它们永远留在待处理记录里，每次全量重写都要带上。
		let purged = 0;
		for (const record of [...this.records.values()]) {
			if (record.replayPolicy === "never" && record.owner !== this.owner) {
				this.records.delete(record.id);
				this.deleted.add(record.id);
				purged += 1;
			}
		}
		const result = [...this.records.values()].filter((record) =>
			record.replayPolicy !== "never" && (record.owner !== this.owner || record.leaseUntil <= now));
		for (const record of result) {
			record.owner = this.owner;
			record.claimedAt = now;
			record.leaseUntil = now + this.leaseMs;
			record.attempts += 1;
			this.dirty.add(record.id);
		}
		if (purged > 0 || result.length > 0) this.flush();
		return result.map((record) => structuredClone(record));
	}

	ack(id: string): void {
		const record = this.records.get(id);
		if (!record || !this.records.delete(id)) return;
		for (const member of record.sourceMessageIds ?? []) if (this.memberIndex.get(member) === id) this.memberIndex.delete(member);
		this.deleted.add(id);
		this.flush();
		// 终结时通知上游（入站去重层用它区分「已处理完」与「准入前崩溃」）：
		// 待处理记录移除并落盘之后才通知，此时平台再重投同一条才能安全地按重复丢弃。
		// 批合并的消息，每个成员 id 都要通知，否则重投成员会被当成 orphan 重新执行。
		for (const messageId of new Set([id, ...(record.sourceMessageIds ?? [])])) {
			try { this.onDone?.(messageId); } catch { /* 通知失败只影响重投去重，不影响本轮投递 */ }
		}
	}

	/**
	 * 是否仍有未完成的该消息记录。
	 * 除了直接命中记录，还要覆盖“已被 batch 合入主记录”的成员 id —— 否则重投
	 * 该成员会被误判为 orphan 而重新准入，造成重复执行。
	 */
	has(id: string): boolean {
		if (this.records.has(id)) return true;
		// 成员 id → 主记录的反查（记录数通常很小，但 has 在每条入站消息上调用）
		const primary = this.memberIndex.get(id);
		return primary !== undefined && this.records.has(primary);
	}

	/**
	 * batch 合并：把同一窗口内的成员记录并入主记录，并写入合并后的消息。
	 * 主记录不存在时不做任何事（可能已被 ack）；成员记录一律删除，避免恢复时重复重放。
	 */
	mergeInto(
		primaryId: string,
		memberIds: string[],
		merged: Omit<FeishuInboundMessage, "raw">,
		sourceMessageIds: string[],
	): void {
		const primary = this.records.get(primaryId);
		if (!primary) return;
		for (const id of memberIds) {
			if (id === primaryId) continue;
			if (this.records.delete(id)) this.deleted.add(id);
		}
		primary.message = { ...merged, raw: undefined } as Omit<FeishuInboundMessage, "raw">;
		primary.sourceMessageIds = [...sourceMessageIds];
		for (const member of sourceMessageIds) this.memberIndex.set(member, primaryId);
		primary.updatedAt = this.now();
		this.dirty.add(primaryId);
		this.flush();
	}

	/** 标记为永不重放（命令类消息）。 */
	markNever(id: string): void {
		const record = this.records.get(id);
		if (!record || record.replayPolicy === "never") return;
		record.replayPolicy = "never";
		this.dirty.add(id);
		this.flush();
	}

	/** 撤销 never（仅 never → auto；manual 不回退，那是越过工具边界的保守判定）。 */
	markAuto(id: string): void {
		const record = this.records.get(id);
		if (record?.replayPolicy !== "never") return;
		record.replayPolicy = "auto";
		this.dirty.add(id);
		this.flush();
	}

	markManual(id: string): void {
		const record = this.records.get(id);
		if (!record || record.replayPolicy === "manual") return;
		record.replayPolicy = "manual";
		this.dirty.add(id);
		this.flush();
	}

	depth(): number {
		return this.records.size;
	}

	private load(): void {
		if (!this.file || !existsSync(this.file)) return;
		for (const line of readFileSync(this.file, "utf8").split("\n").filter(Boolean)) {
			this.lineCount += 1;
			try {
				// 删除标记：后写覆盖先写，读到就说明这条记录已经终结
				const tombstone = JSON.parse(line) as { id?: string; removed?: boolean };
				if (tombstone?.removed === true && typeof tombstone.id === "string") {
					this.records.delete(tombstone.id);
					continue;
				}
				const record = tombstone as PendingRecord;
				if (record?.id && record.message?.messageId && record.conversationKey) {
					this.records.set(record.id, record);
					for (const member of record.sourceMessageIds ?? []) this.memberIndex.set(member, record.id);
				}
			} catch { /* skip corrupt line */ }
		}
	}

	/**
	 * 把本轮变动追加到文件；行数远多于记录数时压实成完整快照。
	 *
	 * 追加失败（磁盘满、只读挂载）向上抛：调用方（claim）会回滚内存状态，
	 * 不能让「内存里记着、盘上没有」的记录在重启后变成幽灵消息。
	 */
	private flush(): void {
		if (!this.file) {
			this.dirty.clear();
			this.deleted.clear();
			return;
		}
		if (this.dirty.size === 0 && this.deleted.size === 0) return;
		// 行数膨胀（大量 ack 之后残留的旧快照/墓碑）就压实；阈值给足余量，避免频繁全量重写
		if (this.lineCount > this.records.size * 3 + 50) {
			this.compact();
			return;
		}
		const lines: string[] = [];
		for (const id of this.deleted) lines.push(JSON.stringify({ id, removed: true }));
		for (const id of this.dirty) {
			const record = this.records.get(id);
			// 同一轮里既改又删的记录只写墓碑
			if (record && !this.deleted.has(id)) lines.push(JSON.stringify(record));
		}
		if (lines.length > 0) {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, `${lines.join("\n")}\n`, { mode: 0o600 });
			this.lineCount += lines.length;
		}
		this.dirty.clear();
		this.deleted.clear();
	}

	/** 全量重写（读取/压实共用）：原子写，失败抛出交给调用方决定。 */
	private compact(): void {
		const output = [...this.records.values()].map((record) => JSON.stringify(record)).join("\n");
		atomicWriteFile(this.file, output ? `${output}\n` : "");
		this.lineCount = this.records.size;
		this.dirty.clear();
		this.deleted.clear();
	}
}
