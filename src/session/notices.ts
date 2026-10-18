/**
 * 会话里的用户可见提示（排队、忙碌、出错、中断）怎么发出去。
 *
 * 规则集中在一处，因为这里踩过坑：
 * - 虚拟会话（云文档评论）不是飞书会话，发过去只会变成 outbox 的永久失败 → 直接跳过；
 * - 有持久 outbox 时进队列（重启后还能发），没有就直接发；
 * - 这条通道送的是「出错/中断」类提示，它自己失败时**必须留日志**，
 *   否则用户看到的是「什么也没说」，排障的人查不到任何线索。
 */
import type { Outbox } from "../outbound/outbox.js";
import type { Sender } from "../outbound/sender.js";
import { EXTERNAL_CHAT_PREFIX } from "../types.js";

export type NoticeKind = "error" | "notify";

export interface NoticeSenderDeps {
	sender: Pick<Sender, "send">;
	durableOutbox?: Pick<Outbox, "enqueue">;
	log?: (level: "debug" | "info" | "warn" | "error", event: string, meta?: unknown) => void;
}

export interface NoticeRequest {
	chatId: string;
	text: string;
	opts?: { replyTo?: string; threadId?: string };
	/** 同一份提示的幂等键（outbox 据此去重）。 */
	dedupeKey?: string;
	/** 串行车道（同一会话的提示不并发）。 */
	laneKey?: string;
	kind?: NoticeKind;
}

export interface NoticeSender {
	send(request: NoticeRequest): Promise<boolean>;
}

export function createNoticeSender(deps: NoticeSenderDeps): NoticeSender {
	const log = deps.log;
	return {
		async send(request) {
			const { chatId, text, opts, kind = "notify" } = request;
			const dedupeKey = request.dedupeKey ?? `${chatId}:${text}`;
			const laneKey = request.laneKey ?? chatId;
			if (chatId.startsWith(EXTERNAL_CHAT_PREFIX)) {
				log?.("info", "feishu.conv.notify_skipped_external", { chatId, kind });
				return false;
			}
			try {
				if (deps.durableOutbox) {
					const queued = deps.durableOutbox.enqueue(chatId, text, opts ?? {}, { dedupeKey, laneKey, kind });
					if (queued.length === 0) log?.("warn", "feishu.conv.notify_not_queued", { chatId, kind, dedupeKey });
					return queued.length > 0;
				}
				const result = await deps.sender.send(chatId, text, opts);
				if (!result.success) log?.("warn", "feishu.conv.notify_failed", { chatId, kind, error: result.error ?? null });
				return result.success;
			} catch (error) {
				log?.("warn", "feishu.conv.notify_failed", { chatId, kind, error: error instanceof Error ? error.message : String(error) });
				return false;
			}
		},
	};
}

/** 忙碌排队时的回执（位置、怎么查进度、怎么清空）。 */
export function queuedNoticeText(position: number): string {
	return `已排队，第 ${position} 个（当前任务结束后执行；/progress 看当前进度，/queue list 查看队列，/queue clear 清空）`;
}
