/**
 * 群开通相关的公共操作：谁有审批权、怎么称呼审批人、私聊管理员、在群里发卡片。
 * 入口（入群通知、放行卡）与可选能力「群开通申请」共用。
 */
import { atList } from "../commands/cards.js";
import type { BridgeLogger } from "./logger.js";
import type { BridgeRuntime } from "./bridge-runtime.js";
import { accessApproverPolicy, describeByRole, roleOf } from "./admin-roles.js";

export class Onboarding {
	constructor(private readonly rt: BridgeRuntime, private readonly log: BridgeLogger) {}

	/** 私聊一张卡给若干管理员（失败只记日志）。 */
	async dmAdmins(recipients: string[], card: unknown, what: string): Promise<number> {
		let sent = 0;
		for (const openId of recipients.slice(0, 5)) {
			try {
				await this.rt.transport?.sendToUser(openId, "interactive", card);
				sent += 1;
			} catch (error) {
				this.log.warn("feishu.admin_dm_failed", { what, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return sent;
	}

	/** 群里发卡片（失败只记日志，返回是否发出）。 */
	async sendChatCard(chatId: string, card: unknown, opts: { replyTo?: string; threadId?: string }, what: string): Promise<boolean> {
		try {
			await this.rt.transport?.sendCard(chatId, card, opts);
			return true;
		} catch (error) {
			this.log.warn("feishu.access_request.card_failed", { chatId, what, error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	/** 群开通审批策略（配置热改后立即生效）。 */
	approverPolicy() {
		return accessApproverPolicy(this.rt.config.onboarding?.accessApprovers);
	}

	/** 带角色的 @ 列表（卡片 markdown）："应用归属人 @张三、应用协作者 @李四"。 */
	atByRole(ids: string[]): string {
		return describeByRole(this.rt.config, ids, (id) => atList([id]));
	}

	/** 带角色的名字（私聊场景：审批人不在群里，@ 不会提醒，写名字更直观）："应用归属人 张三"。 */
	async approverNames(ids: string[]): Promise<string> {
		const names = new Map(await Promise.all(ids.map(async (id) => [id, (await this.rt.transport?.resolveUserName(id).catch(() => undefined)) ?? "（未知）"] as const)));
		return describeByRole(this.rt.config, ids, (id) => names.get(id) ?? "（未知）");
	}

	/** 操作人的角色 + @（放行/暂不放行回告用）。 */
	operatorByRole(openId: string): string {
		const role = roleOf(this.rt.config, openId);
		return role ? this.atByRole([openId]) : atList([openId]);
	}
}
