/**
 * 开通申请：没有权限的人找机器人 → 找管理员审批。三种申请：
 * - `chat`：未放行的群里有人 @ 机器人（放行此群 / 全局放行此人）；
 * - `group_user`：群已放行，但这个人不在群名单里（加入本群名单 / 全局放行此人）；
 * - `dm`：未放行的人私聊机器人（放行私聊）。
 *
 * 路由规则：
 * - 管理员（应用归属人、应用管理员、config.admins）有人在群里 → 审批卡直接发在群里，@ 这些人，并回复申请人那条消息；
 * - 没有（私聊申请总是这样）→ 私聊应用归属人（拿不到归属人时私聊全体管理员，最多 5 人），回告申请人"已发给谁"。
 *
 * 限流：同一项申请（一个群 / 群里的一个人 / 私聊的一个人）在冷却期内只发一次审批；期间再有人来，每人最多提醒一次"已在审批中"；
 * 管理员点了"暂不放行"后，这一项在忽略期内不再发申请；所有申请合计每小时有上限，超出的只记日志（避免被刷屏）。
 */

export type AccessRequestKind = "chat" | "group_user" | "dm";

/** 申请项的限流键：群级申请用群 id（放行群、退群时按群 id 清理），个人申请带上 open_id。 */
export function accessRequestKey(kind: AccessRequestKind, chatId: string, openId: string): string {
	if (kind === "chat") return chatId;
	if (kind === "group_user") return `${chatId}/${openId}`;
	return `dm/${openId}`;
}

export interface AccessRequestPlan {
	/** group = 群里弹卡；dm = 私聊审批人；none = 找不到任何审批人。 */
	mode: "group" | "dm" | "none";
	approvers: string[];
}

export interface PlanInput {
	/** 全部可审批的人（归属人 + 应用管理员 + config.admins），**已按角色排好序**（归属人在前）。 */
	admins: string[];
	/** 应用归属人。 */
	ownerId?: string;
	/** 应用管理员（不含归属人）。 */
	appAdminIds?: string[];
	/** 群成员 open_id；undefined = 拿不到（缺权限或接口失败）。 */
	groupMembers?: ReadonlySet<string>;
	/** 申请人（本身就是管理员时，一定在群里）。 */
	requesterId: string;
}

export function planAccessRequest(input: PlanInput): AccessRequestPlan {
	// admins 已按角色排序：@ 的顺序即优先级（归属人 → 应用管理员 → 管理员）
	const inGroup = input.admins.filter((id) => id === input.requesterId || input.groupMembers?.has(id));
	if (inGroup.length > 0) return { mode: "group", approvers: inGroup.slice(0, 5) };
	// 都不在群里：私聊归属人；没有归属人找应用管理员；再没有找管理员
	if (input.ownerId) return { mode: "dm", approvers: [input.ownerId] };
	if (input.appAdminIds?.length) return { mode: "dm", approvers: input.appAdminIds.slice(0, 5) };
	if (input.admins.length > 0) return { mode: "dm", approvers: input.admins.slice(0, 5) };
	return { mode: "none", approvers: [] };
}

interface ChatState {
	requestedAt?: number;
	mode?: AccessRequestPlan["mode"];
	approvers?: string[];
	ignoredUntil?: number;
	reminded: Map<string, number>;
}

export interface AccessRequestTrackerOptions {
	/** 同一项申请两次审批请求的最短间隔（默认 1 小时）。 */
	cooldownMs?: number;
	/** 每小时最多发出几次申请（所有申请项合计；默认 10，0 = 不限）。 */
	maxPerHour?: number;
	/** 同一个人"已在审批中"提醒的最短间隔（默认 10 分钟）。 */
	remindIntervalMs?: number;
	now?: () => number;
}

export type AccessRequestAction =
	| { action: "request" }
	| { action: "remind"; approvers: string[]; mode: AccessRequestPlan["mode"] }
	| { action: "silent"; reason: "ignored" | "reminded" | "rate_limited" };

export class AccessRequestTracker {
	private readonly chats = new Map<string, ChatState>();
	/** 近一小时发出申请的时间（总量上限用）。 */
	private sentAt: number[] = [];
	private readonly cooldownMs: number;
	private readonly maxPerHour: number;
	private readonly remindIntervalMs: number;
	private readonly now: () => number;

	constructor(options: AccessRequestTrackerOptions = {}) {
		this.cooldownMs = options.cooldownMs ?? 3_600_000;
		this.maxPerHour = options.maxPerHour ?? 10;
		this.remindIntervalMs = options.remindIntervalMs ?? 600_000;
		this.now = options.now ?? Date.now;
	}

	/** 没有权限的人找机器人：该发审批、提醒"审批中"，还是保持安静。`key` 见 {@link accessRequestKey}。 */
	decide(key: string, requesterId: string): AccessRequestAction {
		const now = this.now();
		const state = this.chats.get(key);
		if (state?.ignoredUntil !== undefined && now < state.ignoredUntil) return { action: "silent", reason: "ignored" };
		if (state?.requestedAt === undefined || now - state.requestedAt >= this.cooldownMs) {
			this.sentAt = this.sentAt.filter((at) => now - at < 3_600_000);
			if (this.maxPerHour > 0 && this.sentAt.length >= this.maxPerHour) return { action: "silent", reason: "rate_limited" };
			return { action: "request" };
		}
		const last = state.reminded.get(requesterId);
		if (last !== undefined && now - last < this.remindIntervalMs) return { action: "silent", reason: "reminded" };
		state.reminded.set(requesterId, now);
		return { action: "remind", approvers: state.approvers ?? [], mode: state.mode ?? "none" };
	}

	markRequested(key: string, requesterId: string, plan: AccessRequestPlan): void {
		const now = this.now();
		this.sentAt.push(now);
		this.chats.set(key, { requestedAt: now, mode: plan.mode, approvers: plan.approvers, reminded: new Map([[requesterId, now]]) });
	}

	/** 管理员"暂不放行"：忽略期内这一项不再发申请。 */
	markIgnored(key: string, forMs = 24 * 3_600_000): void {
		this.chats.set(key, { ignoredUntil: this.now() + forMs, reminded: new Map() });
	}

	/** 已放行 / 机器人退群：清掉状态。 */
	clear(key: string): void {
		this.chats.delete(key);
	}
}
