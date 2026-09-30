/**
 * 可选能力·agent 自定义卡片（cardTool.enabled）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardToolFeature } from "../../src/features/card-tool.js";
import type { CardAction, FeishuTransport } from "../../src/inbound/transport.js";
import type { ConversationManager } from "../../src/session/conversation-manager.js";
import type { BridgeRoute } from "../../src/session/pi-bridge-hooks.js";
import { featureHostFor } from "./helpers.js";

const ROUTE: BridgeRoute = { conversationKey: "oc_g:u:ou_user", chatId: "oc_g", sourceMessageId: "om_src", senderId: "ou_user", runId: "r1" };

test("agent 自定义卡片·关：不提供工具、不登记按钮", async () => {
	const { host, cardRouter } = await featureHostFor([cardToolFeature], {});
	assert.equal(host.first("sendCard"), undefined);
	assert.equal(cardRouter.ops()["agent.card"], undefined);
	assert.deepEqual(host.names(), []);
});

test("agent 自定义卡片·开：发出带签名按钮的卡片；点击以「[卡片点击]」进入会话；篡改的按钮被拒", async () => {
	const { host, rt, cardRouter } = await featureHostFor([cardToolFeature], { cardTool: { enabled: true }, admins: ["ou_admin"] });
	const sent: unknown[] = [];
	rt.transport = { sendCard: async (_chatId: string, card: unknown) => { sent.push(card); return "om_card"; } } as unknown as FeishuTransport;
	const routed: string[] = [];
	rt.convManager = { route: async (msg: { text: string }) => { routed.push(msg.text); return "started"; } } as unknown as ConversationManager;

	const sendCard = host.first("sendCard");
	assert.ok(sendCard);
	const result = await sendCard({ toolCallId: "t1", params: { content: "选一个", buttons: ["好", "不好"] }, route: ROUTE });
	assert.equal(result.isError, undefined);
	const buttons = (sent[0] as { body: { elements: Array<{ value?: Record<string, unknown> }> } }).body.elements.filter((e) => e.value);
	assert.equal(buttons.length, 2);

	const click = (value: Record<string, unknown>, operator = "ou_user") =>
		cardRouter.handle({ messageId: "om_card", chatId: "oc_g", operatorOpenId: operator, value } as CardAction);
	const ok = await click(buttons[0].value!) as { toast: { content: string } };
	assert.equal(ok.toast.content, "已选择：好");
	assert.deepEqual(routed, ["[卡片点击] 好"]);

	const tampered = await click({ ...buttons[0].value!, l: "改过的" }) as { toast: { content: string } };
	assert.match(tampered.toast.content, /已失效/);
	const stranger = await click(buttons[1].value!, "ou_other") as { toast: { content: string } };
	assert.match(stranger.toast.content, /只有发起人或管理员/);
	assert.equal(routed.length, 1);
});

test("agent 自定义卡片·开：没有活动会话时工具返回错误", async () => {
	const { host } = await featureHostFor([cardToolFeature], { cardTool: { enabled: true } });
	const result = await host.first("sendCard")!({ toolCallId: "t1", params: { content: "x", buttons: ["a"] }, route: undefined });
	assert.equal(result.isError, true);
});
