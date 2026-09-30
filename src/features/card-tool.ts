/**
 * agent 自定义卡片（`cardTool.enabled`，默认关）：子会话里多一个 `feishu_card` 工具，
 * agent 可以发一张带按钮的卡片；用户点按钮后以「[卡片点击] 按钮名」的新消息回到会话。
 *
 * 按钮值带 HMAC 签名（密钥随每次启动随机生成）：重启后旧卡片的按钮失效，这是预期的。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { effectiveAdmins } from "../inbound/admit.js";
import type { CardAction } from "../inbound/transport.js";
import type { ExtensionToolResult } from "../pi-types.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import type { BridgeRoute } from "../session/pi-bridge-hooks.js";
import type { BridgeFeature } from "./feature.js";

export const cardToolFeature: BridgeFeature = {
	name: "cardTool",
	enabled: (config) => config.cardTool?.enabled === true,
	setup({ rt, log }) {
		const secret = randomBytes(32);
		const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 32);
		return {
			sendCard: (input) => sendAgentCard(rt, sign, input.params, input.route),
			cardOps: {
				"agent.card": (action, value) => handleAgentCardClick(rt, log, sign, action, value),
			},
		};
	},
};

/** feishu_card 工具的实现（子会话内联扩展调用；只发到当前活动会话）。 */
async function sendAgentCard(rt: BridgeRuntime, sign: (payload: string) => string, params: Record<string, unknown>, route: BridgeRoute | undefined): Promise<ExtensionToolResult> {
	if (!route || !rt.transport) return { content: [{ type: "text", text: "无法发送：当前不是由飞书消息触发的活动会话" }], isError: true };
	const labels = (Array.isArray(params.buttons) ? params.buttons : []).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 20)).slice(0, 6);
	if (labels.length === 0) return { content: [{ type: "text", text: "buttons 至少要有一个" }], isError: true };
	const chatType = route.chatType ?? (route.conversationKey.includes(":t:") ? "topic" : "group");
	const buttons = labels.map((label) => {
		const base = { k: route.conversationKey, c: route.chatId, th: route.threadId ?? "", o: route.senderId ?? "", l: label, t: chatType };
		return {
			tag: "button", size: "small", type: "primary", width: "fill",
			text: { tag: "plain_text", content: label },
			value: { op: "agent.card", ...base, s: sign(JSON.stringify([base.k, base.c, base.th, base.o, base.l, base.t])) },
		};
	});
	const card = {
		schema: "2.0",
		config: { wide_screen_mode: true },
		...(typeof params.title === "string" && params.title.trim() ? { header: { title: { tag: "plain_text", content: params.title.trim().slice(0, 60) }, template: "blue" } } : {}),
		body: { elements: [{ tag: "markdown", content: String(params.content ?? "").slice(0, 3_000) }, ...buttons] },
	};
	try {
		await rt.transport.sendCard(route.chatId, card, { replyTo: route.sourceMessageId, threadId: route.threadId });
		return { content: [{ type: "text", text: `卡片已发送（按钮：${labels.join("、")}）。用户点击后会以「[卡片点击] 按钮名」的新消息告诉你，本轮可以先结束。` }] };
	} catch (error) {
		return { content: [{ type: "text", text: `卡片发送失败：${error instanceof Error ? error.message : String(error)}` }], isError: true };
	}
}

/** agent 卡片的按钮点击 → 校验签名与操作者 → 以 `[卡片点击] 按钮名` 进入会话。 */
async function handleAgentCardClick(rt: BridgeRuntime, log: BridgeLogger, sign: (payload: string) => string, action: CardAction, value: Record<string, unknown>): Promise<unknown> {
	const field = (key: string) => (typeof value[key] === "string" ? value[key] as string : "");
	const payload = JSON.stringify([field("k"), field("c"), field("th"), field("o"), field("l"), field("t")]);
	const expected = Buffer.from(sign(payload));
	const actual = Buffer.from(field("s"));
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return { toast: { type: "warning", content: "这张卡片已失效（机器人重启过），请让它重新发一张" } };
	}
	if (action.chatId !== field("c")) return { toast: { type: "warning", content: "卡片与当前会话不匹配" } };
	const owner = field("o");
	if (owner && owner !== action.operatorOpenId && !effectiveAdmins(rt.config).includes(action.operatorOpenId)) {
		return { toast: { type: "warning", content: "只有发起人或管理员可以点这张卡片" } };
	}
	const chatType = field("t") === "p2p" || field("t") === "topic" ? field("t") as "p2p" | "topic" : "group";
	const result = await rt.convManager?.route({
		messageId: `${action.messageId}#${action.token ?? randomBytes(6).toString("hex")}`,
		replyTarget: action.messageId, synthetic: true,
		chatId: field("c"), chatType, ...(field("th") ? { threadId: field("th") } : {}),
		senderId: action.operatorOpenId, isBot: false, msgType: "text",
		text: `[卡片点击] ${field("l")}`, mentions: [], resources: [], raw: undefined, ts: Date.now(),
	}, { conversationKey: field("k") });
	log.info("feishu.agent_card.click", { label: field("l"), operator: action.operatorOpenId, result: result ?? "unavailable" });
	return { toast: { type: result === "rejected" ? "warning" : "success", content: result === "rejected" ? "当前队列已满，请稍后再试" : `已选择：${field("l")}` } };
}
