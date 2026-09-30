/**
 * 管理员角色：应用归属人 / 应用协作者 / 管理员（config.admins）。
 *
 * 三者都能审批（effectiveAdmins），但对人展示时必须分清 —— "已发给管理员张三"和"已发给应用归属人张三"
 * 对申请人意味着不同的等待预期。一个人同时有多个角色时取最高：归属人 > 协作者 > 管理员。
 */
import type { BridgeConfig } from "../types.js";

export type AdminRole = "owner" | "collaborator" | "admin";

const RANK: Record<AdminRole, number> = { owner: 0, collaborator: 1, admin: 2 };

export function roleLabel(role: AdminRole): string {
	return role === "owner" ? "应用归属人" : role === "collaborator" ? "应用协作者" : "管理员";
}

type RoleSource = Pick<BridgeConfig, "admins" | "appOwnerId" | "appCollaboratorIds" | "implicitAdmins">;

/** 某人的最高角色（不是任何管理员返回 undefined）。 */
export function roleOf(cfg: RoleSource, openId: string): AdminRole | undefined {
	if (cfg.appOwnerId === openId) return "owner";
	if (cfg.appCollaboratorIds?.includes(openId)) return "collaborator";
	// 旧数据兼容：只有 implicitAdmins（没有区分归属人与协作者）时，归属人/协作者统一按协作者展示
	if (!cfg.appOwnerId && !cfg.appCollaboratorIds && cfg.implicitAdmins?.includes(openId)) return "collaborator";
	if (cfg.admins.includes(openId)) return "admin";
	return undefined;
}

/** 按角色排序（归属人在前）；同角色保持原顺序。非管理员排最后。 */
export function sortByRole(cfg: RoleSource, ids: string[]): string[] {
	const rank = (id: string) => { const role = roleOf(cfg, id); return role ? RANK[role] : 9; };
	return ids.map((id, index) => ({ id, index })).sort((a, b) => (rank(a.id) - rank(b.id)) || (a.index - b.index)).map((item) => item.id);
}

/** 各角色人数（诊断用；按最高角色计，不重复计数）。 */
export function roleCounts(cfg: RoleSource, ids: string[]): Record<AdminRole, number> {
	const counts: Record<AdminRole, number> = { owner: 0, collaborator: 0, admin: 0 };
	for (const id of new Set(ids)) {
		const role = roleOf(cfg, id);
		if (role) counts[role] += 1;
	}
	return counts;
}

/**
 * "应用归属人 @张三、应用协作者 @李四" —— 同角色合并："应用协作者 @李四 @王五"。
 * `render` 决定一个人怎么显示（卡片里用 <at>，文本里用名字）。
 */
export function describeByRole(cfg: RoleSource, ids: string[], render: (id: string) => string): string {
	const groups = new Map<AdminRole, string[]>();
	for (const id of sortByRole(cfg, ids)) {
		const role = roleOf(cfg, id) ?? "admin";
		groups.set(role, [...(groups.get(role) ?? []), render(id)]);
	}
	return [...groups].map(([role, people]) => `${roleLabel(role)} ${people.join(" ")}`).join("、");
}

/**
 * 群开通审批权限（`onboarding.accessApprovers`，默认 owner）：
 * - owner：仅应用归属人；
 * - owner_collaborators：归属人 + 应用协作者；
 * - all：再加 config.admins。
 */
export type AccessApproverPolicy = "owner" | "owner_collaborators" | "all";

export function accessApproverPolicy(value: unknown): AccessApproverPolicy {
	return value === "all" || value === "owner_collaborators" ? value : "owner";
}

const POLICY_ROLES: Record<AccessApproverPolicy, AdminRole[]> = {
	owner: ["owner"],
	owner_collaborators: ["owner", "collaborator"],
	all: ["owner", "collaborator", "admin"],
};

/** 此人能否审批群开通。 */
export function canApproveAccess(cfg: RoleSource, openId: string, policy: AccessApproverPolicy): boolean {
	const role = roleOf(cfg, openId);
	return role !== undefined && POLICY_ROLES[policy].includes(role);
}

/** 按策略可审批的人（已按角色排序）。 */
export function accessApprovers(cfg: RoleSource, candidates: string[], policy: AccessApproverPolicy): string[] {
	return sortByRole(cfg, [...new Set(candidates)].filter((id) => canApproveAccess(cfg, id, policy)));
}

/** 策略的人话描述（卡片与提示用）："仅应用归属人" / "应用归属人或应用协作者" / …。 */
export function accessApproverHint(policy: AccessApproverPolicy): string {
	return policy === "owner" ? "仅应用归属人" : policy === "owner_collaborators" ? "应用归属人或应用协作者" : "应用归属人、应用协作者或管理员";
}
