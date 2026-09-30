/**
 * 入站流水线（pipeline）：dedup → batch → admit → reply-resolve → dispatch。
 * 唯一丢弃点在 admit 与 dedup。
 */
import type { BridgeConfig, FeishuInboundMessage } from "../types.js";
import { type LastSentCache, admit } from "./admit.js";
import { BATCHABLE_MEDIA_TYPES, DedupCache, TextBatcher, batchCompatible, type BatchWindow } from "./pipeline-utils.js";
import type { FeishuTransport } from "./transport.js";
import { buildConversationKey } from "../session/conversation-key.js";
import type { DedupeStore } from "./dedupe-store.js";

export interface PipelineStats {
	total: number;
	duplicate: number;
	batched: number;
	dropped: number;
	dispatched: number;
	/** 去重标记存在但从未进入持久账本（崩溃窗口）而重新准入的条数。 */
	recovered: number;
	lastMessageAt?: number;
}

/** 入站接管账本：准入后立即持久化，使合并窗口内崩溃也能恢复。 */
export interface IntakeLedger {
	/** 持久化一条已准入消息；实现需保证幂等。 */
	claim(msg: FeishuInboundMessage, conversationKey: string): void;
	/** 该消息（或已被合入的记录）是否仍在账本中未完成。 */
	has(id: string): boolean;
	/** batch 合并：成员记录并入主记录。 */
	merge(primaryId: string, memberIds: string[], merged: FeishuInboundMessage): void;
	/** 标记为永不重放（命令类消息；可选实现）。 */
	markNever?(id: string): void;
	/** 撤销 never 标记（`/` 开头但不是桥命令，仍按普通消息恢复；可选实现）。 */
	markAuto?(id: string): void;
	/** 已终结（命令已消费）：从账本移除（可选实现）。 */
	ack?(id: string): void;
}

export interface PipelineDeps {
	config: BridgeConfig;
	transport: FeishuTransport;
	lastSent: LastSentCache;
	onDispatch: (msg: FeishuInboundMessage) => Promise<void>;
	/** 返回 true 表示命令已消费，不再进入 batch/Agent。 */
	onCommand?: (msg: FeishuInboundMessage) => Promise<boolean>;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	dedupeStore?: DedupeStore;
	/** 持久接管账本（可选；不设时退化为纯内存批处理）。 */
	intake?: IntakeLedger;
	/** 准入拒绝回调（mentioned = 用户表达了意图，例如 @ 了本 bot）。 */
	onDrop?: (msg: FeishuInboundMessage, reason: string, mentioned: boolean) => void;
}

export class InboundPipeline {
	private dedup: DedupeStore;
	private batcher: TextBatcher;
	private stats: PipelineStats = { total: 0, duplicate: 0, batched: 0, dropped: 0, dispatched: 0, recovered: 0 };
	private quoteCache = new Map<string, { text: string; at: number }>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private inFlight = new Set<Promise<void>>();
	private stopping = false;

	constructor(private deps: PipelineDeps) {
		this.dedup = deps.dedupeStore ?? new DedupCache(deps.config.dedupCacheSize);
		this.batcher = new TextBatcher(deps.config.batch.textWindowMs);
	}

	getStats(): PipelineStats {
		return { ...this.stats };
	}

	/**
	 * 撤回的消息如果还在合批窗口里，直接从窗口移除（不会进入任何 turn）。
	 * 窗口因此变空时连同定时器一起丢弃，并在接管账本里落终态。
	 */
	cancelBatched(messageId: string): boolean {
		for (const [key, window] of this.batcher.entries()) {
			const index = window.messageIds.indexOf(messageId);
			if (index < 0) continue;
			window.messageIds.splice(index, 1);
			window.parts.splice(index, 1);
			window.resources = window.resources.filter((resource) => resource.messageId !== messageId);
			this.deps.intake?.ack?.(messageId);
			if (window.messageIds.length === 0) {
				this.batcher.flush(key);
				const timer = this.timers.get(key);
				if (timer) clearTimeout(timer);
				this.timers.delete(key);
			}
			this.deps.log?.("info", "feishu.pipeline.recall_unbatched", { messageId, remaining: window.messageIds.length });
			return true;
		}
		return false;
	}

	/** 处理单条入站消息（transport 回调）。 */
	handle(msg: FeishuInboundMessage): Promise<void> {
		if (this.stopping) {
			this.stats.dropped += 1;
			this.deps.log?.("warn", "feishu.pipeline.drop_after_stop", { messageId: msg.messageId });
			return Promise.resolve();
		}
		const task = this.handleOne(msg);
		this.inFlight.add(task);
		return task.finally(() => this.inFlight.delete(task));
	}

	private async handleOne(msg: FeishuInboundMessage): Promise<void> {
		this.stats.total += 1;
		this.stats.lastMessageAt = Date.now();

		// 1. 去重（区分“已持久接管”与“仅写过标记”两种命中）
		if (!this.dedup.check(msg.messageId)) {
			if (!this.deps.intake || this.deps.intake.has(msg.messageId)) {
				// 已进入持久账本（或未启用账本，退化旧行为）：启动恢复负责重放，重投按重复丢弃。
				this.stats.duplicate += 1;
				this.deps.log?.("debug", "feishu.pipeline.drop_duplicate", {
					messageId: msg.messageId,
					ledgered: Boolean(this.deps.intake),
				});
				return;
			}
			// orphan：账本已启用但从未接管（崩溃窗口）→ 重新准入，避免静默丢失。
			this.stats.recovered += 1;
			this.deps.log?.("warn", "feishu.pipeline.recover_orphan", { messageId: msg.messageId });
		}

		// 2. 每条消息先独立通过准入与引用解析，再考虑合并，避免未授权消息
		// 借已 @ 消息进入同一个 turn。
		let prepared: FeishuInboundMessage | undefined;
		try {
			prepared = await this.prepareMsg(msg);
			if (!prepared) return;
		} catch (error) {
			this.dedup.forget(msg.messageId);
			throw error;
		}

		const key = buildConversationKey(prepared, this.deps.config);
		// 准入通过即持久接管，消除 dedupe→ledger 之间的丢失窗口。
		if (this.deps.intake) {
			try {
				this.deps.intake.claim(prepared, key);
			} catch (error) {
				this.dedup.forget(prepared.messageId);
				throw error;
			}
		}
		if (this.deps.onCommand) {
			if (this.batcher.peek(key)) await this.flushBatch(key);
			// 命令类消息（/new、/stop…）在账本里标为 never：重启后不重放。
			// 依赖方不再重放一个 /new（会再清一次上下文）或 /stop（会打断新任务）。
			// 在调用 onCommand 之前标记 —— 标记本身针对跨进程重放，与本进程内的
			// 重试（dedup.forget 后重投）互不冲突。
			const slash = prepared.text.trimStart().startsWith("/");
			if (slash) this.deps.intake?.markNever?.(prepared.messageId);
			let consumed: boolean;
			try {
				consumed = await this.deps.onCommand(prepared);
			} catch (error) {
				// 命令不重放：记录留着只会永久占账本；dedupe 退回后平台重投会重新接管。
				if (slash) this.deps.intake?.ack?.(prepared.messageId);
				this.dedup.forget(prepared.messageId);
				throw error;
			}
			// 命令已消费即终结：必须 ack，否则 never 记录永远留在账本里（recoverable 也不会返回它）。
			if (consumed) {
				this.deps.intake?.ack?.(prepared.messageId);
				return;
			}
			// `/` 开头但不是桥命令（如 pi 的 /skill:xxx）：交给 Agent 的普通消息，恢复可重放。
			if (slash) this.deps.intake?.markAuto?.(prepared.messageId);
		}
		const isMedia = BATCHABLE_MEDIA_TYPES.has(prepared.msgType) && (prepared.resources?.length ?? 0) > 0;
		const batchable = this.deps.config.batch.enabled
			&& prepared.chatType !== "p2p"
			&& ((prepared.msgType === "text" && Boolean(prepared.text)) || (this.deps.config.batch.media === true && isMedia));
		if (!batchable) {
			// 同一会话已有文本窗口时先发送旧文本，保持到达顺序。
			if (this.batcher.peek(key)) await this.flushBatch(key);
			await this.dispatchPrepared(prepared);
			return;
		}

		const maxMessages = Math.max(1, this.deps.config.batch.maxMessages ?? 8);
		const maxChars = Math.max(1, this.deps.config.batch.maxChars ?? 12_000);
		let existing = this.batcher.peek(key);
		// 窗口已超过上限（连续发送把防抖一直往后推）→ 先派发旧窗口，新消息开新窗口
		if (existing && Date.now() - existing.firstTs >= this.deps.config.batch.textWindowMs) {
			await this.flushBatch(key);
			existing = undefined;
		}
		if (existing && !batchCompatible(existing.carrier, prepared)) {
			await this.flushBatch(key);
			existing = undefined;
		}
		if (existing) {
			const nextChars = existing.parts.reduce((n, part) => n + part.length, 0) + prepared.text.length + 1;
			if (existing.parts.length >= maxMessages || nextChars > maxChars) {
				await this.flushBatch(key);
				existing = undefined;
			}
		}
		if (prepared.text.length > maxChars) {
			await this.dispatchPrepared(prepared);
			return;
		}

		const joined = this.batcher.offer(key, prepared);
		if (joined) {
			this.stats.batched += 1;
			this.deps.log?.("debug", "feishu.pipeline.batched", { messageId: prepared.messageId, conversationKey: key });
		}
		const window = this.batcher.peek(key);
		if (window && (window.parts.length >= maxMessages || this.windowChars(window) >= maxChars)) {
			await this.flushBatch(key);
			return;
		}
		this.scheduleFlush(key);
	}

	/** batcher 窗口到期：合并 parts → 账本合并 → dispatch。 */
	async flushBatch(key: string): Promise<void> {
		this.clearFlushTimer(key);
		const win = this.batcher.flush(key);
		if (!win) return;
		await this.dispatchWindow(win);
	}

	/** 把一个批处理窗口落账本（合并成员记录）后派发。 */
	private async dispatchWindow(win: BatchWindow): Promise<void> {
		const merged: FeishuInboundMessage = {
			...win.carrier,
			text: win.parts.filter(Boolean).join("\n"),
			resources: win.resources,
			sourceMessageIds: win.messageIds,
			ts: Date.now(),
		};
		try {
			this.deps.intake?.merge(merged.messageId, win.messageIds, merged);
		} catch (error) {
			// 合并失败不阻断投递：恢复时会重放多条而不是合并态（语义降级，但不丢消息）。
			this.deps.log?.("error", "feishu.pipeline.intake_merge_failed", {
				messageId: merged.messageId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		await this.dispatchPrepared(merged);
	}

	private async prepareMsg(msg: FeishuInboundMessage): Promise<FeishuInboundMessage | undefined> {
		// 3. 准入
		// @所有人 默认不唤醒（ignoreAtAll 默认 true）；显式关闭后与 @本 bot 等效。
		// 注意：即使忽略 @所有人，消息里同时 @ 了本 bot 仍会命中 m.isSelf 分支。
		const atAll = !(this.deps.config.ignoreAtAll ?? true)
			&& (msg.text.includes("@_all") || msg.text.includes("@all"));
		const mentioned = msg.mentions.some((m) => m.isSelf) || atAll;
		const replyToBot = Boolean(msg.replyToMessageId && this.deps.lastSent.has(msg.replyToMessageId));
		const verdict = admit(this.deps.config, msg, mentioned, replyToBot, this.deps.lastSent);
		if (!verdict.ok) {
			this.stats.dropped += 1;
			// 日志带 hint：admit 已经针对每种拒绝给出「照做就能通过」的具体动作
			// （加哪个文件的哪个字段、加什么值）。准入是 fail-closed 的，被挡很常见，
			// 而「为什么被挡、怎么放行」不该靠人翻代码或写文档才能回答。
			this.deps.log?.("debug", "feishu.pipeline.drop", {
				messageId: msg.messageId,
				chatId: msg.chatId,
				chatType: msg.chatType,
				reason: verdict.reason,
				...(msg.isBot ? { senderId: msg.senderId, senderAppId: msg.senderAppId ?? null } : {}),
				...(verdict.hint ? { hint: verdict.hint } : {}),
			});
			try { this.deps.onDrop?.(msg, verdict.reason ?? "unknown", mentioned); } catch { /* 回调失败不影响准入 */ }
			return undefined;
		}

		// 4. 回复解析（拉取被回复原文）
		let replyToText = msg.replyToText;
		if (msg.replyToMessageId && !replyToText) {
			const cached = this.quoteCache.get(msg.replyToMessageId);
			if (cached && Date.now() - cached.at < this.deps.config.quotedFetchTtlMs) {
				replyToText = cached.text;
			} else {
				const text = await this.deps.transport.getMessageText(msg.replyToMessageId);
				replyToText = text ?? "[无法获取被回复消息原文]";
				if (text) this.quoteCache.set(msg.replyToMessageId, { text, at: Date.now() });
			}
		}

		return { ...msg, replyToText };
	}

	private async dispatchPrepared(msg: FeishuInboundMessage): Promise<void> {
		// 5. dispatch
		this.stats.dispatched += 1;
		try {
			await this.deps.onDispatch(msg);
		} catch (error) {
			// 已持久接管的消息交给启动恢复处理（避免“重投 + 恢复”双重执行）；
			// 未接管的消息退回去重标记，允许平台重投。
			const ledgered = this.deps.intake?.has(msg.messageId) ?? false;
			if (!ledgered) {
				for (const messageId of msg.sourceMessageIds ?? [msg.messageId]) this.dedup.forget(messageId);
			}
			throw error;
		}
	}

	private windowChars(win: BatchWindow): number {
		return win.parts.reduce((n, part) => n + part.length, 0) + Math.max(0, win.parts.length - 1);
	}

	/**
	 * 防抖 + 上限。每来一条重新计时 debounceMs，但从窗口首条算起不超过 textWindowMs ——
	 * 单条消息只等 debounceMs（默认 800ms），连续发送时最多等 textWindowMs。
	 */
	private flushDelay(key: string): number {
		const { textWindowMs, debounceMs } = this.deps.config.batch;
		const debounce = debounceMs ?? 800;
		if (debounce <= 0) return textWindowMs + 50;
		const window = this.batcher.peek(key);
		const remaining = window ? window.firstTs + textWindowMs - Date.now() : textWindowMs;
		return Math.max(0, Math.min(debounce, remaining)) + 50;
	}

	private scheduleFlush(key: string): void {
		this.clearFlushTimer(key);
		const timer = setTimeout(() => {
			this.timers.delete(key);
			void this.flushBatch(key).catch((err) => {
				this.deps.log?.("error", "feishu.pipeline.flush_failed", {
					conversationKey: key,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, this.flushDelay(key));
		timer.unref?.();
		this.timers.set(key, timer);
	}

	private clearFlushTimer(key: string): void {
		const timer = this.timers.get(key);
		if (timer) clearTimeout(timer);
		this.timers.delete(key);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		const inFlight = await Promise.allSettled([...this.inFlight]);
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		const pending = this.batcher.flushAll();
		const results = await Promise.allSettled(pending.map((win) => this.dispatchWindow(win)));
		const errors = [...inFlight, ...results]
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason);
		if (errors.length > 0) throw new AggregateError(errors, "failed to flush inbound batches");
	}
}
