/**
 * 应用归属人（owner/creator）与应用管理员：启动时从开放平台查询，填入配置作为隐式管理员。
 * 自己驱动 agent 时不必手工维护 open_id，且换应用后自动刷新（open_id 是按应用视角生成的）。
 * 注意：这些人只豁免群策略层；群内 @ 仍按 adminBypassMention（默认 false）判定。
 *
 * 应用的协作者分三种角色（协作者接口的 `type`）：管理员 `administrator`、开发者 `developer`、运营 `operator`。
 * 只有管理员算隐式管理员 —— 开发者、运营能改代码或看数据，不代表能批准工具调用、放行群；
 * `type` 缺失或不认识的同样不算（宁可少认，漏掉的人可以写进 config.admins）。
 */
import type { BridgeRuntime } from "./bridge-runtime.js";
import type { BridgeLogger } from "./logger.js";

/** 协作者里算作应用管理员的角色。 */
const APP_ADMIN_TYPE = "administrator";

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

		// 协作者列表（可能也含归属人）。该接口可能因权限不足而失败，此时退化为仅有归属人，不影响启动。
		let appAdminIds: string[] = [];
		const excluded: Record<string, number> = {};
		try {
			const collab = await rt.transport?.rawRequest({
				url: `/open-apis/application/v6/applications/${rt.config.appId}/collaborators`,
				method: "GET",
				params: { user_id_type: "open_id", page_size: 50 },
			});
			const list = ((collab as { data?: { collaborators?: unknown[] } })?.data?.collaborators ?? []) as Array<Record<string, unknown>>;
			for (const item of list) {
				const id = typeof item.user_id === "string" ? item.user_id : undefined;
				if (!id) continue;
				if (item.type === APP_ADMIN_TYPE) appAdminIds.push(id);
				else {
					const type = typeof item.type === "string" && item.type ? item.type : "unknown";
					excluded[type] = (excluded[type] ?? 0) + 1;
				}
			}
		} catch (collabError) {
			log.warn("feishu.config.app_collaborators_hydrate_failed", {
				error: collabError instanceof Error ? collabError.message : String(collabError),
				hint: "查询应用协作者失败，只认应用归属人；其他管理员请写进 config.admins",
			});
		}

		// 角色分开记：展示时要区分"应用归属人"与"应用管理员"（列表里也可能含归属人，去掉）
		appAdminIds = [...new Set(appAdminIds)].filter((id) => id !== ownerId);
		rt.config.appOwnerId = ownerId;
		rt.config.appAdminIds = appAdminIds;
		const hydrated = [...new Set([ownerId, ...appAdminIds].filter((v): v is string => Boolean(v)))];
		rt.config.implicitAdmins = hydrated;
		log.info("feishu.config.app_owner_hydrated", {
			hasOwner: Boolean(ownerId),
			appAdminCount: appAdminIds.length,
			// 被排除的协作者，按角色计数（developer / operator / unknown）
			excludedCollaborators: excluded,
			totalImplicitAdmins: hydrated.length,
			adminBypassMention: rt.config.adminBypassMention === true,
		});
		if (excluded.unknown) {
			log.warn("feishu.config.app_collaborator_type_unknown", {
				count: excluded.unknown,
				hint: "协作者接口没有返回可识别的角色，这些人不算管理员；需要时写进 config.admins",
			});
		}
	} catch (error) {
		log.warn("feishu.config.app_owner_hydrate_failed", {
			error: error instanceof Error ? error.message : String(error),
			hint: "缺少 application:application:readonly 权限时无法查询应用归属人；管理员仍按 config.admins 生效",
		});
		rt.config.implicitAdmins = [];
	}
}
