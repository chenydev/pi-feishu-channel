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
	/** 去重标记存在但从未进入持久待处理记录（崩溃窗口）而重新准入的条数。 */
	recovered: number;
	lastMessageAt?: number;
}

/** 入站待处理记录：准入后立即持久化，使合并窗口内崩溃也能恢复。 */
export interface IntakeLedger {
	/** 持久化一条已准入消息；实现需保证幂等。 */
	claim(msg: FeishuInboundMessage, conversationKey: string): void;
	/** 该消息（或已被合入的记录）是否仍在待处理记录中未完成。 */
	has(id: string): boolean;
	/** batch 合并：成员记录并入主记录。 */
	merge(primaryId: string, memberIds: string[], merged: FeishuInboundMessage): void;
	/** 标记为永不重放（命令类消息；可选实现）。 */
	markNever?(id: string): void;
	/** 撤销 never 标记（`/` 开头但不是桥命令，仍按普通消息恢复；可选实现）。 */
	markAuto?(id: string): void;
	/** 已终结（命令已消费）：从待处理记录移除（可选实现）。 */
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
	/** 持久待处理记录（可选；不设时退化为纯内存批处理）。 */
	intake?: IntakeLedger;
	/** 准入拒绝回调（mentioned = 用户表达了意图，例如 @ 了本 bot）。 */
	onDrop?: (msg: FeishuInboundMessage, reason: string, mentioned: boolean) => void;
}

export class InboundPipeline {
	private dedup: DedupeStore;
	private batcher: TextBatcher;
	private stats: PipelineStats = { total: 0, duplicate: 0, batched: 0, dropped: 0, dispatched: 0, recovered: 0 };
	/** 被回复消息原文缓存：按 `quotedFetchTtlMs` 判命，容量按 `lastSentCacheSize` 封顶（与机器人消息缓存同量级）。 */
	private quoteCache = new Map<string, { text: string; at: number }>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private inFlight = new Set<Promise<void>>();
	private stopping = false;

	constructor(private deps: PipelineDeps) {
		this.dedup = deps.dedupeStore ?? new DedupCache(deps.config.dedupCacheSize);
		this.batcher = new TextBatcher(() => deps.config.batch.textWindowMs);
	}

	getStats(): PipelineStats {
		return { ...this.stats };
	}

	/**
	 * 常驻内存的条目数（写进 status.json / `/feishu doctor`）。
	 *
	 * 这些结构原来完全没有出口：`quoteCache` 无上限那次事故就是「长驻进程慢慢涨、没人看得见」。
	 */
	cacheSizes(): { quotes: number; dedupe: number } {
		return { quotes: this.quoteCache.size, dedupe: this.dedup.size() };
	}

	/**
	 * 撤回的消息如果还在合批窗口里，直接从窗口移除（不会进入任何 turn）。
	 * 窗口因此变空时连同定时器一起丢弃，并在待处理记录里落终态。
	 */
	cancelBatched(messageId: string): boolean {
		for (const [key, window] of this.batcher.entries()) {
			const index = window.messageIds.indexOf(messageId);
			if (index < 0) continue;
			window.messageIds.splice(index, 1);
			window.parts.splice(index, 1);
			window.messages.splice(index, 1);
			window.resources = window.resources.filter((resource) => resource.messageId !== messageId);
			// carrier 是合并后消息的模板（messageId / replyTo / threadId / 发送者都取自它）：
			// 撤掉的如果正是窗口里最后一条，必须回退到剩下那条，否则回复会挂到已撤回的消息上，
			// 待处理记录合并也会因为主记录已被 ack 而丢掉成员记录（重启后重复重放）。
			const survivor = window.messages[window.messages.length - 1];
			if (survivor) window.carrier = survivor;
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

	/**
	 * 标记一条消息已处理完（待处理记录 ack 时由会话层回调）。
	 * 平台之后重投同一条时按重复丢弃：去重标记在、待处理记录也没了，但这次不能当 orphan 再跑一遍。
	 */
	markCompleted(messageId: string): void {
		if (!messageId) return;
		this.dedup.markDone(messageId);
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

		// 1. 去重（区分三种命中：还在待处理记录里 / 已处理完 / 准入前崩了）
		if (!this.dedup.check(msg.messageId)) {
			if (!this.deps.intake || this.deps.intake.has(msg.messageId)) {
				// 已进入持久待处理记录（或未启用待处理记录，退化旧行为）：启动恢复负责重放，重投按重复丢弃。
				this.stats.duplicate += 1;
				this.deps.log?.("debug", "feishu.pipeline.drop_duplicate", {
					messageId: msg.messageId,
					ledgered: Boolean(this.deps.intake),
				});
				return;
			}
			// 去重标记在、待处理记录没了 —— 两种可能：
			//   已处理完（ack 过，平台又重投）→ 按重复丢弃，不得再执行一次；
			//   准入后到登记前崩溃（从未处理）→ 重新准入，避免静默丢失。
			if (this.dedup.isDone(msg.messageId)) {
				this.stats.duplicate += 1;
				this.deps.log?.("debug", "feishu.pipeline.drop_duplicate", { messageId: msg.messageId, ledgered: true, completed: true });
				return;
			}
			// orphan：待处理记录已启用但从未登记（崩溃窗口）→ 重新准入，避免静默丢失。
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
		// 准入通过即写入待处理记录，消除 dedupe→ledger 之间的丢失窗口。
		if (this.deps.intake) {
			try {
				this.deps.intake.claim(prepared, key);
			} catch (error) {
				this.dedup.forget(prepared.messageId);
				throw error;
			}
		}
		if (this.deps.onCommand) {
			// 命令类消息（/new、/stop…）在待处理记录里标为 never：重启后不重放。
			// 依赖方不再重放一个 /new（会再清一次上下文）或 /stop（会打断新任务）。
			// 在调用 onCommand 之前标记 —— 标记本身针对跨进程重放，与本进程内的
			// 重试（dedup.forget 后重投）互不冲突。
			const slash = prepared.text.trimStart().startsWith("/");
			// 命令要先于合并窗口执行（/new、/stop 不能被并进普通消息那一轮），所以**只在命令到来时**
			// 冲刷已有窗口。普通消息不能冲：`onCommand` 生产环境总是注入，无条件冲刷会让每条消息
			// 都把上一条的窗口冲掉，`batch.*` 全部失效（实测连发两条各触发一轮）。
			if (slash && this.batcher.peek(key)) await this.flushBatch(key);
			if (slash) this.deps.intake?.markNever?.(prepared.messageId);
			let consumed: boolean;
			try {
				consumed = await this.deps.onCommand(prepared);
			} catch (error) {
				// 命令不重放：记录留着只会永久占待处理记录；去重标记撤回后，平台重投会重新登记。
				if (slash) this.deps.intake?.ack?.(prepared.messageId);
				this.dedup.forget(prepared.messageId);
				throw error;
			}
			// 命令已消费即终结：必须 ack，否则 never 记录永远留在待处理记录里（recoverable 也不会返回它）。
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

	/** batcher 窗口到期：合并 parts → 待处理记录合并 → dispatch。 */
	async flushBatch(key: string): Promise<void> {
		this.clearFlushTimer(key);
		const win = this.batcher.flush(key);
		if (!win) return;
		await this.dispatchWindow(win);
	}

	/** 把一个批处理窗口落待处理记录（合并成员记录）后派发。 */
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
			// （加哪个文件的哪个字段、加什么值）。准入是默认拒绝的，被挡很常见，
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
				if (text) this.cacheQuote(msg.replyToMessageId, text);
			}
		}

		return { ...msg, replyToText };
	}

	/**
	 * 缓存被回复消息原文。
	 * 过期项在命中时删除（而不是留着），并按容量淘汰最旧的 —— 长驻进程里「被回复过的消息」
	 * 是持续增长的，没有上限时内存随使用时长线性上涨（一条长文可能有几十 KB）。
	 */
	private cacheQuote(messageId: string, text: string): void {
		const now = Date.now();
		const ttl = this.deps.config.quotedFetchTtlMs;
		for (const [key, entry] of this.quoteCache) {
			if (now - entry.at >= ttl) this.quoteCache.delete(key);
		}
		this.quoteCache.delete(messageId);
		this.quoteCache.set(messageId, { text, at: now });
		const capacity = Math.max(1, this.deps.config.lastSentCacheSize);
		while (this.quoteCache.size > capacity) {
			const oldest = this.quoteCache.keys().next().value;
			if (oldest === undefined) break;
			this.quoteCache.delete(oldest);
		}
	}

	private async dispatchPrepared(msg: FeishuInboundMessage): Promise<void> {
		// 5. dispatch
		this.stats.dispatched += 1;
		try {
			await this.deps.onDispatch(msg);
		} catch (error) {
			// 已持久登记的消息交给启动恢复处理（避免“重投 + 恢复”双重执行）；
			// 未登记的消息退回去重标记，允许平台重投。
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
