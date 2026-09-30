/**
 * 卡片回调的统一校验。
 *
 * 审批卡有自己的 token + 操作者校验（permission-bridge）；这里覆盖其余"会改会话状态"的按钮
 * （思考等级、模型表格展开等），并对所有回调做 token 去重。
 */
import type { CardAction } from "../inbound/transport.js";

/**
 * 会话类按钮的授权：返回拒绝原因，放行返回 undefined。
 * - 回调所在 chat 必须与 conversationKey 所属 chat 一致（key 形如 `oc`、`oc:u:ou`、`oc:t:th`）；
 * - 操作者必须是卡片发起人（value.owner）或管理员；老卡片没有 owner 时只允许管理员。
 */
export function authorizeSessionCardAction(action: CardAction, value: Record<string, unknown>, admins: readonly string[]): string | undefined {
	const key = typeof value.conversationKey === "string" ? value.conversationKey : "";
	if (action.chatId && key && key !== action.chatId && !key.startsWith(`${action.chatId}:`)) return "卡片与当前会话不匹配";
	const owner = typeof value.owner === "string" ? value.owner : undefined;
	if (admins.includes(action.operatorOpenId) || (owner && owner === action.operatorOpenId)) return undefined;
	return owner ? "只有发起人或管理员可以操作这张卡片" : "这张卡片已过期，请重新发送命令获取新卡片";
}

/** 回调 token 去重：飞书重投同一次点击时不重复执行（窗口默认 15 分钟，对齐 hermes）。 */
export class CardTokenDedupe {
	private seen = new Map<string, number>();

	constructor(private ttlMs = 15 * 60_000, private now: () => number = Date.now) {}

	/** 第一次见到返回 true；重复返回 false。没有 token 时总是 true。 */
	accept(token: string | undefined): boolean {
		if (!token) return true;
		const at = this.now();
		for (const [key, seenAt] of this.seen) {
			if (at - seenAt <= this.ttlMs) break; // Map 按插入顺序：遇到未过期的就可以停
			this.seen.delete(key);
		}
		if (this.seen.has(token)) return false;
		this.seen.set(token, at);
		return true;
	}
}
