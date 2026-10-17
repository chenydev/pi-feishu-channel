import type { FeishuInboundMessage } from "../types.js";

export interface HistoryCompensationResult {
	recovered: number;
	errors: number;
	windowTruncated: boolean;
	truncatedChats: number;
}

export async function compensateKnownChats(options: {
	chatIds: Iterable<string>;
	outageStartedAt: number;
	now: number;
	maxWindowMs: number;
	maxPerChat: number;
	/** `messages` 按时间升序；`hasMore` 表示接口在这一页之后还有记录（本次补收被截断）。 */
	list: (chatId: string, startTime: number, endTime: number, limit: number) => Promise<{ messages: FeishuInboundMessage[]; hasMore: boolean }>;
	handle: (message: FeishuInboundMessage) => Promise<void>;
	onError?: (chatId: string, error: unknown) => void;
}): Promise<HistoryCompensationResult> {
	const startTime = Math.max(options.outageStartedAt, options.now - options.maxWindowMs);
	let recovered = 0;
	let errors = 0;
	let truncatedChats = 0;
	for (const chatId of options.chatIds) {
		try {
			// 上限由接口单页（50 条）决定，不能靠「多要一条」探测：page_size 会被夹到 50，
			// 请求 51 条永远只回 50 条，截断计数恒为 0，而 `ByCreateTimeAsc` 下丢掉的恰好最新那几条。
			const limit = Math.max(1, options.maxPerChat);
			const page = await options.list(chatId, startTime, options.now, limit);
			if (page.hasMore) truncatedChats += 1;
			// 取回的是最近 limit 条（升序）：超出时丢更早的，不会丢用户最后问的那几条
			const batch = page.messages.slice(-limit);
			for (const message of batch) await options.handle(message);
			recovered += batch.length;
		} catch (error) {
			errors += 1;
			options.onError?.(chatId, error);
		}
	}
	return { recovered, errors, windowTruncated: options.outageStartedAt < startTime, truncatedChats };
}
