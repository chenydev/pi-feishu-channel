import assert from "node:assert/strict";
import { test } from "node:test";
import { CardTokenDedupe, authorizeSessionCardAction } from "../src/interaction/card-actions.js";

const action = (operatorOpenId: string, chatId = "oc_g") => ({ messageId: "om", chatId, operatorOpenId });

test("卡片鉴权：发起人与管理员可操作，其他人被拒", () => {
	const value = { op: "thinking.set", conversationKey: "oc_g:u:ou_owner", owner: "ou_owner" };
	assert.equal(authorizeSessionCardAction(action("ou_owner"), value, []), undefined);
	assert.equal(authorizeSessionCardAction(action("ou_admin"), value, ["ou_admin"]), undefined);
	assert.match(authorizeSessionCardAction(action("ou_other"), value, ["ou_admin"]) ?? "", /发起人或管理员/);
});

test("卡片鉴权：没有 owner 的老卡片只允许管理员", () => {
	const value = { op: "thinking.set", conversationKey: "oc_g" };
	assert.equal(authorizeSessionCardAction(action("ou_admin"), value, ["ou_admin"]), undefined);
	assert.match(authorizeSessionCardAction(action("ou_x"), value, ["ou_admin"]) ?? "", /过期/);
});

test("卡片鉴权：回调所在 chat 与 conversationKey 不一致 → 拒绝（即便是管理员）", () => {
	const value = { op: "thinking.set", conversationKey: "oc_other:u:ou_a", owner: "ou_a" };
	assert.match(authorizeSessionCardAction(action("ou_a", "oc_g"), value, ["ou_a"]) ?? "", /不匹配/);
	assert.equal(authorizeSessionCardAction(action("ou_a", "oc_other"), value, []), undefined);
});

test("卡片鉴权：token 去重，过期后可再次接受", () => {
	let now = 0;
	const dedupe = new CardTokenDedupe(1_000, () => now);
	assert.equal(dedupe.accept("t1"), true);
	assert.equal(dedupe.accept("t1"), false);
	assert.equal(dedupe.accept(undefined), true);
	now = 2_000;
	assert.equal(dedupe.accept("t1"), true);
});
