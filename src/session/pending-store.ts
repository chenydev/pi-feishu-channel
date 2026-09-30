import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
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

export class PendingStore {
	private records = new Map<string, PendingRecord>();
	private memberIndex = new Map<string, string>();
	private readonly owner = `${process.pid}:${randomUUID()}`;
	private readonly now: () => number;
	private readonly leaseMs: number;

	constructor(private file: string, options: { now?: () => number; leaseMs?: number } = {}) {
		this.now = options.now ?? Date.now;
		this.leaseMs = options.leaseMs ?? 5 * 60_000;
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
		try {
			this.persist();
		} catch (error) {
			this.records.delete(record.id);
			throw error;
		}
		return record.id;
	}

	/** 新进程可立即接管旧 owner；同进程仅接管 lease 已过期项。 */
	recoverable(): PendingRecord[] {
		const now = this.now();
		// never 档（命令类消息）在账本层就排除：调用方不需要再判断一次，
		// 也就不会出现"某个调用方忘了过滤 → 命令被重放"的隐患。
		// 旧进程遗留的 never 记录（命令处理中崩溃，或旧版本从不 ack）直接清掉，
		// 否则它们永远留在账本里，每次全量重写都要带上。
		let purged = 0;
		for (const record of [...this.records.values()]) {
			if (record.replayPolicy === "never" && record.owner !== this.owner) {
				this.records.delete(record.id);
				purged += 1;
			}
		}
		const result = [...this.records.values()].filter((record) =>
			record.replayPolicy !== "never" && (record.owner !== this.owner || record.leaseUntil <= now));
		if (purged > 0 && result.length === 0) this.persist();
		for (const record of result) {
			record.owner = this.owner;
			record.claimedAt = now;
			record.leaseUntil = now + this.leaseMs;
			record.attempts += 1;
		}
		if (result.length > 0) this.persist();
		return result.map((record) => structuredClone(record));
	}

	ack(id: string): void {
		const record = this.records.get(id);
		if (!record || !this.records.delete(id)) return;
		for (const member of record.sourceMessageIds ?? []) if (this.memberIndex.get(member) === id) this.memberIndex.delete(member);
		this.persist();
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
			if (id !== primaryId) this.records.delete(id);
		}
		primary.message = { ...merged, raw: undefined } as Omit<FeishuInboundMessage, "raw">;
		primary.sourceMessageIds = [...sourceMessageIds];
		for (const member of sourceMessageIds) this.memberIndex.set(member, primaryId);
		primary.updatedAt = this.now();
		this.persist();
	}

	/** 标记为永不重放（命令类消息）。 */
	markNever(id: string): void {
		const record = this.records.get(id);
		if (!record || record.replayPolicy === "never") return;
		record.replayPolicy = "never";
		this.persist();
	}

	/** 撤销 never（仅 never → auto；manual 不回退，那是越过工具边界的保守判定）。 */
	markAuto(id: string): void {
		const record = this.records.get(id);
		if (record?.replayPolicy !== "never") return;
		record.replayPolicy = "auto";
		this.persist();
	}

	markManual(id: string): void {
		const record = this.records.get(id);
		if (!record || record.replayPolicy === "manual") return;
		record.replayPolicy = "manual";
		this.persist();
	}

	depth(): number {
		return this.records.size;
	}

	private load(): void {
		if (!this.file || !existsSync(this.file)) return;
		for (const line of readFileSync(this.file, "utf8").split("\n").filter(Boolean)) {
			try {
				const record = JSON.parse(line) as PendingRecord;
				if (record?.id && record.message?.messageId && record.conversationKey) {
					this.records.set(record.id, record);
					for (const member of record.sourceMessageIds ?? []) this.memberIndex.set(member, record.id);
				}
			} catch { /* skip corrupt line */ }
		}
	}

	private persist(): void {
		if (!this.file) return;
		mkdirSync(dirname(this.file), { recursive: true });
		const output = [...this.records.values()].map((record) => JSON.stringify(record)).join("\n");
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, output ? `${output}\n` : "", { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, this.file);
	}
}
