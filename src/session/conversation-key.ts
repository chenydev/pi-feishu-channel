import type { BridgeConfig, FeishuInboundMessage } from "../types.js";

/**
 * 飞书消息的会话键的唯一来源。
 *
 * - 话题默认由参与者共享；
 * - 群主聊天默认全群共用 chatId；`groupSessionsPerUser` 开启时按发送者隔离（`chatId:u:openId`）；
 * - 私聊直接使用 chatId。
 */
export function buildConversationKey(
	msg: Pick<FeishuInboundMessage, "chatId" | "chatType" | "senderId" | "threadId">,
	config: Pick<BridgeConfig, "groupSessionsPerUser">,
): string {
	if (msg.threadId) return `${msg.chatId}:t:${msg.threadId}`;
	if (msg.chatType === "group" && config.groupSessionsPerUser) {
		return `${msg.chatId}:u:${msg.senderId || "unknown"}`;
	}
	return msg.chatId;
}
