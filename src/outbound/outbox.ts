/**
 * 最终消息 durable outbox：先原子落盘，再按 conversation lane FIFO 投递。
 * sending 状态在重启时恢复为 pending；稳定 API UUID 使发送中崩溃可安全重试。
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFile } from "../runtime/atomic-file.js";
import { randomUUID } from "node:crypto";
import type { SendOptions, SendResult } from "../types.js";
import { feishuMessageTypeForMedia, isPreparedMedia, type PreparedDelivery, type PreparedMediaSend, type PreparedSend } from "./sender.js";
import type { ValidatedArtifact } from "./artifact.js";

export type OutboxKind = "final" | "error" | "notify" | "media";
export type OutboxStatus = "pending" | "sending" | "sent" | "failed";
export type OutboxErrorClass = "retryable" | "fatal";

export interface OutboxEntry {
	id: string;
	dedupeKey: string;
	laneKey: string;
	kind: OutboxKind;
	route: { chatId: string; replyTo?: string; threadId?: string };
	payload: { msgType: "text" | "post" | "image" | "file" | "media" | "audio"; content: string };
	request: PreparedDelivery;
	status: OutboxStatus;
	attempts: number;
	nextRetryAt: number;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
	errorClass?: OutboxErrorClass;
}

export interface OutboxStats {
	pending: number;
	sending: number;
	sent: number;
	failed: number;
	lanes: number;
	oldestAgeMs: number;
}

export interface EnqueueOptions {
	dedupeKey: string;
	laneKey: string;
	kind: OutboxKind;
}

export interface OutboxDeps {
	file: string;
	prepare: (chatId: string, content: string, opts: SendOptions) => PreparedSend[];
	prepareMedia?: (chatId: string, artifact: ValidatedArtifact, opts: SendOptions) => PreparedMediaSend;
	send: (request: PreparedDelivery, checkpoint: (patch: Partial<PreparedMediaSend>) => void) => Promise<SendResult>;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	maxAttempts?: number;
	backoffMs?: number;
	maxActiveEntries?: number;
	maxTerminalEntries?: number;
	concurrency?: number;
	maxEnvelopeBytes?: number;
	maxFileBytes?: number;
	maxTerminalAgeMs?: number;
	now?: () => number;
	random?: () => number;
	onChange?: () => void;
	/**
	 * 条目进入 failed（永久失败）时回调；final/error 类由调用方给用户一条可见提示。
	 *
	 * `info.siblings` 是同一 dedupeKey 的其它条目数（长回答会拆成多条）—— 有兄弟说明
	 * 失败的是「回复的一部分」，提示文案要说「内容可能不完整」，不能说「回复发送失败」。
	 */
	onTerminalFailure?: (entry: OutboxEntry, info?: { siblings: number }) => void;
	/** 每次投递结果（喂给共享预算的熔断器：连续限频/网络错误时让流式更新通道让路）。 */
	onResult?: (result: SendResult) => void;
}

export class Outbox {
	private entries = new Map<string, OutboxEntry>();
	/** dedupeKey → 条目 id（enqueue 去重不再全表扫描）。 */
	private byDedupeKey = new Map<string, Set<string>>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** 当前定时器的到期时刻（`now()` 口径），用于判断新到期是否更早。 */
	private timerAt: number | undefined;
	private running: Promise<void> | undefined;
	private started = false;
	private readonly maxAttempts: number;
	private readonly backoffMs: number;
	private readonly maxActiveEntries: number;
	private readonly maxTerminalEntries: number;
	private readonly concurrency: number;
	private readonly maxEnvelopeBytes: number;
	private readonly maxFileBytes: number;
	private readonly maxTerminalAgeMs: number;
	private readonly now: () => number;
	private readonly random: () => number;

	constructor(private deps: OutboxDeps) {
		this.maxAttempts = deps.maxAttempts ?? 8;
		this.backoffMs = deps.backoffMs ?? 1_000;
		this.maxActiveEntries = deps.maxActiveEntries ?? 1_000;
		this.maxTerminalEntries = deps.maxTerminalEntries ?? 500;
		this.concurrency = Math.max(1, deps.concurrency ?? 4);
		this.maxEnvelopeBytes = deps.maxEnvelopeBytes ?? 256 * 1024;
		this.maxFileBytes = deps.maxFileBytes ?? 64 * 1024 * 1024;
		this.maxTerminalAgeMs = deps.maxTerminalAgeMs ?? 7 * 24 * 60 * 60_000;
		this.now = deps.now ?? Date.now;
		this.random = deps.random ?? Math.random;
		this.load();
	}

	/** transport ready 后显式启动；构造阶段绝不发网络请求。 */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.schedule(0);
	}

	/** 先将所有 chunk 原子写入，再允许调用方确认本轮已可靠保存。 */
	enqueue(chatId: string, content: string, opts: SendOptions, meta: EnqueueOptions): string[] {
		const prepared = this.deps.prepare(chatId, content, opts);
		if (prepared.length === 0) return [];
		const existing = this.entriesFor(meta.dedupeKey).sort((a, b) => a.createdAt - b.createdAt);
		if (existing.some((entry) => entry.status === "failed")) throw new Error("outbox dedupe key is terminally failed");
		if (existing.length > 0) return existing.map((entry) => entry.id);

		const active = [...this.entries.values()].filter((entry) => entry.status === "pending" || entry.status === "sending").length;
		if (active + prepared.length > this.maxActiveEntries) throw new Error("outbox capacity exceeded");
		const now = this.now();
		for (const request of prepared) {
			if (Buffer.byteLength(JSON.stringify(request), "utf8") > this.maxEnvelopeBytes) throw new Error("outbox envelope too large");
		}
		const added = prepared.map((request, index): OutboxEntry => ({
			id: randomUUID(),
			dedupeKey: meta.dedupeKey,
			laneKey: meta.laneKey,
			kind: meta.kind,
			route: { chatId: request.chatId, replyTo: request.opts.replyTo, threadId: request.opts.threadId },
			payload: { msgType: request.msgType, content: request.payload },
			request,
			status: "pending",
			attempts: 0,
			nextRetryAt: now,
			createdAt: now + index / 1_000,
			updatedAt: now,
		}));
		for (const entry of added) this.addEntry(entry);
		try {
			this.compactTerminalEntries();
			this.persist();
		} catch (error) {
			for (const entry of added) this.deleteEntry(entry);
			throw error;
		}
		if (this.started) this.schedule(0);
		this.deps.onChange?.();
		return added.map((entry) => entry.id);
	}

	enqueueMedia(chatId: string, artifact: ValidatedArtifact, opts: SendOptions, meta: EnqueueOptions): string {
		if (!this.deps.prepareMedia) throw new Error("media outbox unavailable");
		const existing = this.entriesFor(meta.dedupeKey)[0];
		if (existing?.status === "failed") throw new Error("outbox dedupe key is terminally failed");
		if (existing) return existing.id;
		const active = [...this.entries.values()].filter((entry) => entry.status === "pending" || entry.status === "sending").length;
		if (active >= this.maxActiveEntries) throw new Error("outbox capacity exceeded");
		const request = this.deps.prepareMedia(chatId, artifact, opts);
		if (Buffer.byteLength(JSON.stringify(request), "utf8") > this.maxEnvelopeBytes) throw new Error("outbox envelope too large");
		const now = this.now();
		const entry: OutboxEntry = {
			id: randomUUID(), dedupeKey: meta.dedupeKey, laneKey: meta.laneKey, kind: "media",
			route: { chatId, replyTo: opts.replyTo, threadId: opts.threadId },
			payload: { msgType: feishuMessageTypeForMedia(artifact.mediaType), content: artifact.localPath }, request,
			status: "pending", attempts: 0, nextRetryAt: now, createdAt: now, updatedAt: now,
		};
		this.addEntry(entry);
		try { this.compactTerminalEntries(); this.persist(); } catch (error) { this.deleteEntry(entry); throw error; }
		if (this.started) this.schedule(0);
		this.deps.onChange?.();
		return entry.id;
	}

	depth(): number {
		const current = this.stats();
		return current.pending + current.sending;
	}

	hasDedupeKey(dedupeKey: string): boolean {
		return this.entriesFor(dedupeKey).some((entry) => entry.status !== "failed");
	}

	/** 最近的永久失败条目（`/feishu status` 展示；只含元数据）。 */
	recentFailures(limit = 3): Array<{ kind: OutboxKind; laneKey: string; updatedAt: number; lastError?: string }> {
		return [...this.entries.values()]
			.filter((entry) => entry.status === "failed")
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, limit)
			.map((entry) => ({ kind: entry.kind, laneKey: entry.laneKey, updatedAt: entry.updatedAt, lastError: entry.lastError }));
	}

	private entriesFor(dedupeKey: string): OutboxEntry[] {
		const ids = this.byDedupeKey.get(dedupeKey);
		if (!ids) return [];
		return [...ids].map((id) => this.entries.get(id)).filter((entry): entry is OutboxEntry => Boolean(entry));
	}

	private addEntry(entry: OutboxEntry): void {
		this.entries.set(entry.id, entry);
		let ids = this.byDedupeKey.get(entry.dedupeKey);
		if (!ids) {
			ids = new Set();
			this.byDedupeKey.set(entry.dedupeKey, ids);
		}
		ids.add(entry.id);
	}

	/**
	 * 已送达的条目只保留去重所需的元数据，裁掉正文与请求体 ——
	 * 否则最终回答的明文在磁盘上留 7 天，且每次落盘都要重写它们。
	 */
	private slimDelivered(entry: OutboxEntry): void {
		const request = entry.request as { uuid: string; chatId: string; opts?: SendOptions };
		entry.request = { uuid: request.uuid, chatId: request.chatId, opts: {} } as unknown as PreparedDelivery;
		entry.payload = { msgType: entry.payload.msgType, content: "" };
	}

	stats(): OutboxStats {
		const values = [...this.entries.values()];
		const active = values.filter((entry) => entry.status === "pending" || entry.status === "sending");
		const oldest = active.reduce((min, entry) => Math.min(min, entry.createdAt), Number.POSITIVE_INFINITY);
		return {
			pending: values.filter((entry) => entry.status === "pending").length,
			sending: values.filter((entry) => entry.status === "sending").length,
			sent: values.filter((entry) => entry.status === "sent").length,
			failed: values.filter((entry) => entry.status === "failed").length,
			lanes: new Set(active.map((entry) => entry.laneKey)).size,
			oldestAgeMs: Number.isFinite(oldest) ? Math.max(0, this.now() - oldest) : 0,
		};
	}

	/** 测试和调度器共用的单次到期处理。 */
	async drainDue(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.doDrainDue().catch((error) => {
			// 落盘失败（磁盘满/只读）而不已经投递失败的条目：异常不能往上冒。
			// 定时器里是 `void this.drainDue()`，未处理的 rejection 在 Node 默认策略下会让进程退出，
			// 而已经送达的条目状态可能还没落盘。记一条错误，队列与定时器在下面的 finally 里照旧恢复。
			this.deps.log?.("error", "feishu.outbox.drain_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		try {
			await this.running;
		} finally {
			this.running = undefined;
			if (this.started) this.schedule();
		}
	}

	private async doDrainDue(): Promise<void> {
		const now = this.now();
		const active = [...this.entries.values()]
			.filter((entry) => entry.status === "pending" || entry.status === "sending")
			.sort((a, b) => a.createdAt - b.createdAt);
		const laneHeads = new Map<string, OutboxEntry>();
		for (const entry of active) {
			if (!laneHeads.has(entry.laneKey)) laneHeads.set(entry.laneKey, entry);
		}
		const due = [...laneHeads.values()]
			.filter((entry) => entry.nextRetryAt <= now)
			.slice(0, this.concurrency);
		if (due.length === 0) return;

		for (const entry of due) {
			entry.status = "sending";
			entry.attempts += 1;
			entry.updatedAt = now;
		}
		this.persist();

		await Promise.all(due.map(async (entry) => {
			let result: SendResult;
			try {
				result = await this.deps.send(entry.request, (patch) => {
					Object.assign(entry.request, patch);
					entry.updatedAt = this.now();
					this.persist();
					this.deps.onChange?.();
				});
			} catch (error) {
				result = { success: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
			}
			try { this.deps.onResult?.(result); } catch { /* 诊断回调不影响投递 */ }
			entry.updatedAt = this.now();
			if (result.success) {
				entry.status = "sent";
				entry.lastError = undefined;
				entry.errorClass = undefined;
				this.deps.log?.("info", "feishu.outbox.delivered", { envelopeId: entry.id, conversationKey: entry.laneKey, attempts: entry.attempts });
				if (isPreparedMedia(entry.request) && entry.request.deleteAfterSend) {
					try { unlinkSync(entry.request.localPath); } catch { /* 已删除或只读，不影响投递结果 */ }
				}
				this.slimDelivered(entry);
				return;
			}
			entry.lastError = result.error ?? "unknown delivery error";
			entry.errorClass = result.retryable === false ? "fatal" : "retryable";
			if (entry.errorClass === "fatal" || entry.attempts >= this.maxAttempts) {
				entry.status = "failed";
				this.deps.log?.("error", "feishu.outbox.failed", { envelopeId: entry.id, conversationKey: entry.laneKey, kind: entry.kind, attempts: entry.attempts, errorClass: entry.errorClass, lastError: entry.lastError });
				try {
					const siblings = [...this.entries.values()].filter((other) => other.id !== entry.id && other.dedupeKey === entry.dedupeKey).length;
					this.deps.onTerminalFailure?.(entry, { siblings });
				} catch { /* 通知失败不影响待处理记录 */ }
				return;
			}
			entry.status = "pending";
			const exponential = this.backoffMs * 2 ** (entry.attempts - 1);
			const jittered = Math.round(exponential * (0.8 + this.random() * 0.4));
			entry.nextRetryAt = this.now() + Math.max(jittered, result.retryAfterMs ?? 0);
		}));
		this.compactTerminalEntries();
		this.persist();
		this.deps.onChange?.();
	}

	private schedule(delay?: number): void {
		if (!this.started || this.running) return;
		const pending = [...this.entries.values()].filter((entry) => entry.status === "pending");
		const now = this.now();
		if (pending.length === 0) {
			// 没有等投递的条目就不占着定时器（否则一个空壳定时器会把下次入队拖到它到期）
			if (this.timer) { clearTimeout(this.timer); this.timer = undefined; this.timerAt = undefined; }
			return;
		}
		const nextAt = Math.min(...pending.map((entry) => entry.nextRetryAt));
		// 到期时刻：显式 delay（入队/启动要尽快投递）优先，其次最近的退避到期，最长 60s。
		const wakeAt = delay === undefined ? Math.min(now + 60_000, nextAt) : now + Math.max(0, delay);
		// 已有定时器：它已经会在不晚于目标时刻醒来就不动（避免每次入队都重建定时器）；
		// 否则必须提前重排 —— 否则新入队的回复要等另一个 lane 的退避（最长 60s）才被投递。
		if (this.timer && this.timerAt !== undefined && this.timerAt <= wakeAt) return;
		if (this.timer) clearTimeout(this.timer);
		this.timerAt = wakeAt;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.timerAt = undefined;
			void this.drainDue();
		}, Math.max(0, wakeAt - now));
		this.timer.unref?.();
	}

	private load(): void {
		if (!existsSync(this.deps.file)) return;
		const lines = readFileSync(this.deps.file, "utf8").split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as OutboxEntry;
				if (!entry?.id || !entry.request?.uuid || !entry.laneKey) continue;
				if (entry.status === "sending") entry.status = "pending";
				// 旧版本留下的已发送条目也裁掉正文（一次性迁移，下次落盘生效）
				if (entry.status === "sent" && entry.payload?.content) this.slimDelivered(entry);
				this.addEntry(entry);
			} catch {
				this.deps.log?.("warn", "feishu.outbox.corrupt_line_skipped");
			}
		}
	}

	private compactTerminalEntries(): void {
		const cutoff = this.now() - this.maxTerminalAgeMs;
		for (const entry of [...this.entries.values()]) {
			if ((entry.status === "sent" || entry.status === "failed") && entry.updatedAt < cutoff) this.deleteEntry(entry);
		}
		const terminal = [...this.entries.values()]
			.filter((entry) => entry.status === "sent" || entry.status === "failed")
			.sort((a, b) => b.updatedAt - a.updatedAt);
		for (const entry of terminal.slice(this.maxTerminalEntries)) this.deleteEntry(entry);
	}

	private deleteEntry(entry: OutboxEntry): void {
		this.entries.delete(entry.id);
		const ids = this.byDedupeKey.get(entry.dedupeKey);
		ids?.delete(entry.id);
		if (ids && ids.size === 0) this.byDedupeKey.delete(entry.dedupeKey);
		if (isPreparedMedia(entry.request) && entry.request.deleteAfterSend) {
			try { unlinkSync(entry.request.localPath); } catch { /* best effort */ }
		}
	}

	private persist(): void {
		const output = [...this.entries.values()].map((entry) => JSON.stringify(entry)).join("\n");
		if (Buffer.byteLength(output, "utf8") > this.maxFileBytes) throw new Error("outbox file capacity exceeded");
		atomicWriteFile(this.deps.file, output ? `${output}\n` : "");
	}

	async stop(): Promise<void> {
		this.started = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.timerAt = undefined;
		await this.running;
	}
}
