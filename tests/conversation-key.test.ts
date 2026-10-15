/**
 * 会话键：群普通消息按群规则 `sessionsPerUser` 决定按人隔离还是全群共用，没设时跟随全局 `groupSessionsPerUser`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConversationKey } from "../src/session/conversation-key.js";
import type { BridgeConfig, FeishuInboundMessage } from "../src/types.js";

type Msg = Pick<FeishuInboundMessage, "chatId" | "chatType" | "senderId" | "threadId">;
const group = (chatId: string, threadId?: string): Msg => ({ chatId, chatType: "group", senderId: "ou_a", ...(threadId ? { threadId } : {}) });
const cfg = (perUser: boolean, groupRules: BridgeConfig["groupRules"] = {}) => ({ groupSessionsPerUser: perUser, groupRules });

test("会话键·按群设置：群规则优先于全局，两个方向都能覆盖", () => {
	const shared = cfg(false, { oc_solo: { sessionsPerUser: true } });
	assert.equal(buildConversationKey(group("oc_solo"), shared), "oc_solo:u:ou_a", "全局共用时，单个群可以设成按人隔离");
	assert.equal(buildConversationKey(group("oc_other"), shared), "oc_other", "没设的群跟随全局");

	const perUser = cfg(true, { oc_team: { sessionsPerUser: false } });
	assert.equal(buildConversationKey(group("oc_team"), perUser), "oc_team", "全局按人隔离时，单个群可以设成全群共用");
	assert.equal(buildConversationKey(group("oc_other"), perUser), "oc_other:u:ou_a");
	assert.equal(buildConversationKey(group("oc_team"), cfg(true, { oc_team: { policy: "open" } })), "oc_team:u:ou_a", "群规则里没写这一项时跟随全局");
});

test("会话键·按群设置：话题和私聊不受影响", () => {
	const config = cfg(false, { oc_solo: { sessionsPerUser: true } });
	assert.equal(buildConversationKey(group("oc_solo", "omt_1"), config), "oc_solo:t:omt_1", "话题里始终共用话题的会话");
	assert.equal(buildConversationKey({ chatId: "oc_dm", chatType: "p2p", senderId: "ou_a" }, cfg(false, { oc_dm: { sessionsPerUser: true } })), "oc_dm");
});
