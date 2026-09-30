import assert from "node:assert/strict";
import { test } from "node:test";
import { AccessRequestTracker, planAccessRequest } from "../src/runtime/access-request.js";
import { buildAccessNoticeCard, buildAccessRequestCard } from "../src/commands/cards.js";

const OWNER = "ou_owner";
const COLLAB = "ou_collab";
const ADMIN = "ou_admin";

test("开通申请路由：管理员有人在群里 → 群里弹卡，按角色顺序 @（归属人排第一）", () => {
	const plan = planAccessRequest({ admins: [OWNER, COLLAB, ADMIN], ownerId: OWNER, groupMembers: new Set(["ou_x", OWNER, COLLAB]), requesterId: "ou_x" });
	assert.deepEqual(plan, { mode: "group", approvers: [OWNER, COLLAB] });
});

test("开通申请路由：只有协作者在群里也在群里弹卡（不打扰不在群里的归属人）", () => {
	const plan = planAccessRequest({ admins: [OWNER, COLLAB], ownerId: OWNER, groupMembers: new Set(["ou_x", COLLAB]), requesterId: "ou_x" });
	assert.deepEqual(plan, { mode: "group", approvers: [COLLAB] });
});

test("开通申请路由：管理员都不在群里 → 私聊归属人；没有归属人 → 私聊全体管理员", () => {
	assert.deepEqual(planAccessRequest({ admins: [OWNER, ADMIN], ownerId: OWNER, groupMembers: new Set(["ou_x"]), requesterId: "ou_x" }), { mode: "dm", approvers: [OWNER] });
	assert.deepEqual(planAccessRequest({ admins: [COLLAB, ADMIN], collaboratorIds: [COLLAB], groupMembers: new Set(["ou_x"]), requesterId: "ou_x" }), { mode: "dm", approvers: [COLLAB] }, "没有归属人先找协作者");
	assert.deepEqual(planAccessRequest({ admins: [ADMIN], groupMembers: new Set(["ou_x"]), requesterId: "ou_x" }), { mode: "dm", approvers: [ADMIN] });
	assert.deepEqual(planAccessRequest({ admins: [], groupMembers: new Set(), requesterId: "ou_x" }), { mode: "none", approvers: [] });
});

test("开通申请路由：拿不到群成员时，申请人本身是管理员仍在群里弹卡，否则私聊归属人", () => {
	assert.deepEqual(planAccessRequest({ admins: [OWNER, ADMIN], ownerId: OWNER, requesterId: ADMIN }), { mode: "group", approvers: [ADMIN] });
	assert.deepEqual(planAccessRequest({ admins: [OWNER, ADMIN], ownerId: OWNER, requesterId: "ou_x" }), { mode: "dm", approvers: [OWNER] });
});

test("开通申请限流：冷却期内同群只申请一次；其他人各提醒一次；过了冷却再申请", () => {
	let now = 0;
	const tracker = new AccessRequestTracker({ cooldownMs: 1_000, remindIntervalMs: 500, now: () => now });
	assert.equal(tracker.decide("oc_1", "ou_a").action, "request");
	tracker.markRequested("oc_1", "ou_a", { mode: "dm", approvers: [OWNER] });
	assert.deepEqual(tracker.decide("oc_1", "ou_a"), { action: "silent", reason: "reminded" }, "申请人刚收到回告，不再重复");
	assert.deepEqual(tracker.decide("oc_1", "ou_b"), { action: "remind", approvers: [OWNER], mode: "dm" });
	assert.deepEqual(tracker.decide("oc_1", "ou_b"), { action: "silent", reason: "reminded" });
	now = 600;
	assert.equal(tracker.decide("oc_1", "ou_b").action, "remind", "提醒间隔过了可以再提醒");
	now = 1_000;
	assert.equal(tracker.decide("oc_1", "ou_b").action, "request");
	assert.equal(tracker.decide("oc_2", "ou_a").action, "request", "不同群互不影响");
});

test("开通申请限流：暂不放行后忽略期内保持安静；放行/退群清状态", () => {
	let now = 0;
	const tracker = new AccessRequestTracker({ now: () => now });
	tracker.markIgnored("oc_1", 100);
	assert.deepEqual(tracker.decide("oc_1", "ou_a"), { action: "silent", reason: "ignored" });
	now = 100;
	assert.equal(tracker.decide("oc_1", "ou_a").action, "request");
	tracker.markRequested("oc_1", "ou_a", { mode: "group", approvers: [OWNER] });
	tracker.clear("oc_1");
	assert.equal(tracker.decide("oc_1", "ou_a").action, "request");
});

test("开通申请卡：群内版 @ 申请人与审批人；私聊版带群名；按钮带申请人", () => {
	const group = JSON.stringify(buildAccessRequestCard({ mode: "group", chatId: "oc_1", requesterId: "ou_x", approvers: [OWNER, COLLAB] }));
	assert.match(group, /<at id=ou_x><\/at> @ 了机器人/);
	assert.match(group, /请 <at id=ou_owner><\/at> <at id=ou_collab><\/at> 审批/);
	const labelled = JSON.stringify(buildAccessRequestCard({ mode: "group", chatId: "oc_1", requesterId: "ou_x", approvers: [OWNER], approverLabel: "应用归属人 <at id=ou_owner></at>" }));
	assert.match(labelled, /请 应用归属人 <at id=ou_owner><\/at> 审批/);
	assert.match(group, /"op":"chat.allow","chatId":"oc_1","requester":"ou_x"/);
	assert.match(group, /"op":"chat.deny"/);
	const dm = JSON.stringify(buildAccessRequestCard({ mode: "dm", chatId: "oc_1", chatName: "研发群", requesterId: "ou_x", approvers: [OWNER] }));
	assert.match(dm, /研发群/);
	assert.match(dm, /申请人：<at id=ou_x><\/at>/);
	assert.match(JSON.stringify(buildAccessNoticeCard("hi", "green")), /本群已开通/);
});
