import assert from "node:assert/strict";
import { test } from "node:test";
import { describeByRole, roleCounts, roleLabel, roleOf, sortByRole } from "../src/runtime/admin-roles.js";

const cfg = { admins: ["ou_admin", "ou_collab"], appOwnerId: "ou_owner", appCollaboratorIds: ["ou_collab", "ou_c2"], implicitAdmins: ["ou_owner", "ou_collab", "ou_c2"] };

test("角色：归属人 > 协作者 > 管理员，一人多角色取最高", () => {
	assert.equal(roleOf(cfg, "ou_owner"), "owner");
	assert.equal(roleOf(cfg, "ou_collab"), "collaborator", "既是协作者又在 admins 里 → 协作者");
	assert.equal(roleOf(cfg, "ou_admin"), "admin");
	assert.equal(roleOf(cfg, "ou_x"), undefined);
	assert.equal(roleLabel("owner"), "应用归属人");
});

test("角色：旧数据只有 implicitAdmins 时按协作者展示（不冒认归属人）", () => {
	assert.equal(roleOf({ admins: [], implicitAdmins: ["ou_a"] }, "ou_a"), "collaborator");
});

test("角色：排序、计数与按角色合并描述", () => {
	assert.deepEqual(sortByRole(cfg, ["ou_admin", "ou_c2", "ou_owner", "ou_collab"]), ["ou_owner", "ou_c2", "ou_collab", "ou_admin"]);
	assert.deepEqual(roleCounts(cfg, ["ou_owner", "ou_collab", "ou_c2", "ou_admin", "ou_admin"]), { owner: 1, collaborator: 2, admin: 1 });
	assert.equal(describeByRole(cfg, ["ou_admin", "ou_collab", "ou_owner", "ou_c2"], (id) => `@${id.slice(3)}`), "应用归属人 @owner、应用协作者 @collab @c2、管理员 @admin");
});

test("群开通审批策略：默认仅归属人；可放宽到协作者、再到全部管理员", async () => {
	const { accessApproverPolicy, accessApprovers, canApproveAccess, accessApproverHint } = await import("../src/runtime/admin-roles.js");
	assert.equal(accessApproverPolicy(undefined), "owner");
	assert.equal(accessApproverPolicy("bogus"), "owner", "非法值按最严处理");
	const all = ["ou_admin", "ou_collab", "ou_c2", "ou_owner"];
	assert.deepEqual(accessApprovers(cfg, all, "owner"), ["ou_owner"]);
	assert.deepEqual(accessApprovers(cfg, all, "owner_collaborators"), ["ou_owner", "ou_collab", "ou_c2"]);
	assert.deepEqual(accessApprovers(cfg, all, "all"), ["ou_owner", "ou_collab", "ou_c2", "ou_admin"]);
	assert.equal(canApproveAccess(cfg, "ou_admin", "owner_collaborators"), false);
	assert.equal(canApproveAccess(cfg, "ou_x", "all"), false);
	assert.equal(accessApproverHint("owner"), "仅应用归属人");
});

test("群开通审批策略：owner 策略下没查到归属人 → 无人可批（不偷偷退回给其他人）", async () => {
	const { accessApprovers } = await import("../src/runtime/admin-roles.js");
	assert.deepEqual(accessApprovers({ admins: ["ou_admin"], appCollaboratorIds: ["ou_c"] }, ["ou_admin", "ou_c"], "owner"), []);
});
