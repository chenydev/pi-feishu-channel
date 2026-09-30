/**
 * 应用归属人（owner/creator）与协作者：启动时从开放平台查询，填入配置作为隐式管理员。
 * 自己驱动 agent 时不必手工维护 open_id，且换应用后自动刷新（open_id 是按应用视角生成的）。
 * 注意：这些人只豁免群策略层；群内 @ 仍按 adminBypassMention（默认 false）判定。
 */
import type { BridgeRuntime } from "./bridge-runtime.js";
import type { BridgeLogger } from "./logger.js";

export async function loadAppAdmins(rt: BridgeRuntime, log: BridgeLogger): Promise<void> {
	try {
		const info = await rt.transport?.rawRequest({
			url: `/open-apis/application/v6/applications/${rt.config.appId}`,
			method: "GET",
			params: { lang: "zh_cn" },
		});
		const app = ((info as { data?: { app?: Record<string, unknown> } })?.data?.app ?? {}) as Record<string, unknown>;
		const ownerId = ((app.owner as { owner_id?: string } | undefined)?.owner_id)
			?? (typeof app.creator_id === "string" ? app.creator_id : undefined);

		// 协作者（owner 也在该列表中）—— 与归属人合并去重。
		// 该接口可能因 scope 不足而失败，此时退化为仅有归属人，不影响启动。
		let collaboratorIds: string[] = [];
		try {
			const collab = await rt.transport?.rawRequest({
				url: `/open-apis/application/v6/applications/${rt.config.appId}/collaborators`,
				method: "GET",
				params: { user_id_type: "open_id", page_size: 50 },
			});
			const list = ((collab as { data?: { collaborators?: unknown[] } })?.data?.collaborators ?? []) as Array<Record<string, unknown>>;
			collaboratorIds = list
				.map((c) => (typeof c.user_id === "string" ? c.user_id : undefined))
				.filter((v): v is string => Boolean(v));
		} catch (collabError) {
			log.warn("feishu.config.app_collaborators_hydrate_failed", {
				error: collabError instanceof Error ? collabError.message : String(collabError),
				hint: "查询应用协作者失败，仅归属人生效；管理员仍按 config.admins 生效",
			});
		}

		// 角色分开记：展示时要区分"应用归属人"与"协作者"（协作者列表里也含归属人，去掉）
		rt.config.appOwnerId = ownerId;
		rt.config.appCollaboratorIds = collaboratorIds.filter((id) => id !== ownerId);
		const hydrated = [...new Set([ownerId, ...collaboratorIds].filter((v): v is string => Boolean(v)))];
		rt.config.implicitAdmins = hydrated;
		log.info("feishu.config.app_owner_hydrated", {
			hasOwner: Boolean(ownerId),
			collaboratorCount: collaboratorIds.length,
			totalImplicitAdmins: hydrated.length,
			adminBypassMention: rt.config.adminBypassMention === true,
		});
	} catch (error) {
		log.warn("feishu.config.app_owner_hydrate_failed", {
			error: error instanceof Error ? error.message : String(error),
			hint: "缺少 application:application:readonly scope 时无法查询应用归属人；管理员仍按 config.admins 生效",
		});
		rt.config.implicitAdmins = [];
	}
}
