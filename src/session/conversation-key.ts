import type { BridgeConfig, FeishuInboundMessage } from "../types.js";

/**
 * 飞书消息的会话键的唯一来源。
 *
 * - 话题默认由参与者共享；
 * - 群主聊天默认全群共用 chatId；按人隔离的群按发送者分（`chatId:u:openId`），见 `groupSessionsPerUser()`；
 * - 私聊直接使用 chatId。
 */
export function buildConversationKey(
	msg: Pick<FeishuInboundMessage, "chatId" | "chatType" | "senderId" | "threadId">,
	config: Pick<BridgeConfig, "groupSessionsPerUser" | "groupRules">,
): string {
	if (msg.threadId) return `${msg.chatId}:t:${msg.threadId}`;
	if (msg.chatType === "group" && groupSessionsPerUser(config, msg.chatId)) {
		return `${msg.chatId}:u:${msg.senderId || "unknown"}`;
	}
	return msg.chatId;
}

/** 这个群的普通消息是否按人隔离会话：群规则里的 `sessionsPerUser` 优先，没设时用全局 `groupSessionsPerUser`。 */
export function groupSessionsPerUser(config: Pick<BridgeConfig, "groupSessionsPerUser" | "groupRules">, chatId: string): boolean {
	return config.groupRules?.[chatId]?.sessionsPerUser ?? config.groupSessionsPerUser;
}
