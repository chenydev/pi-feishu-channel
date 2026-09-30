/**
 * 模型类命令：查看/切换模型、模型列表、思考等级（`-g` 写全局默认，仅管理员）。
 */
import type { CommandHandler } from "../dispatch.js";
import type { CommandServices } from "./services.js";
import { splitModelTarget, writeGlobalDefaults } from "../../config/global-defaults.js";
import { buildModelStatusCard, buildModelsTable } from "../models-card.js";

export function modelCommands(svc: CommandServices): Record<string, CommandHandler> {
	return {
		"/model": async ({ msg, args, rest, isAdmin, reply, trySendCard }) => {
			// 无参 = 状态卡（当前模型 + 最近使用 + 档位按钮 + 「查看全部模型」按钮）。
			// 带参仍是命令式切换，保持文本回执 —— 那是一次性动作，不需要卡片。
			if (!args[0]) {
				const data = await svc.rt.convManager?.commands.modelStatusCardData(msg);
				if (data && await trySendCard(buildModelStatusCard({ ...data, ownerOpenId: msg.senderId }), "model")) return;
			}
			const { wantsGlobal, value: target } = splitGlobalFlag(rest);
			const result = await svc.rt.convManager?.commands.modelConversation(msg, target || undefined) ?? "会话不可用";
			if (!wantsGlobal || !target) { reply(result); return; }
			if (!isAdmin) { reply(`${result}\n（--global/-g 需要管理员或应用归属人）`); return; }
			// 模糊匹配后以实际切换到的模型为准（回执里 "已切换模型：provider/id"）
			const switched = /^已切换模型：(\S+)/.exec(result)?.[1];
			if (!switched) { reply(result); return; }
			const { model, provider } = splitModelTarget(switched);
			const written = writeGlobalDefaults(svc.rt.homeDir, { defaultModel: model, ...(provider ? { defaultProvider: provider } : {}) });
			reply(written.ok ? `${result}\n已设为全局默认：新建会话的模型 = ${switched}` : `${result}\n⚠️ 全局默认写入失败：${written.reason}`);
			svc.log.info("feishu.global_default.written", { kind: "model", value: switched, ok: written.ok, operator: msg.senderId, reason: written.reason ?? null });
		},
		"/models": async ({ msg, args, reply, trySendCard }) => {
			// 表格卡片：飞书客户端自带分页（page_size）；页码只在文本降级时有意义，对用户一律从 1 开始数。
			const pageIndex = Math.max(1, Number.parseInt(args[0] ?? "1", 10) || 1) - 1;
			const data = pageIndex === 0 ? await svc.rt.convManager?.commands.modelsCardData(msg) : undefined;
			if (data && await trySendCard(buildModelsTable(data), "models")) return;
			reply(await svc.rt.convManager?.commands.listModels(msg, pageIndex) ?? "会话不可用");
		},
		"/thinking": async ({ msg, rest, isAdmin, reply }) => {
			const { wantsGlobal, value: level } = splitGlobalFlag(rest);
			const result = await svc.rt.convManager?.commands.thinkingConversation(msg, level || undefined) ?? "会话不可用";
			if (!wantsGlobal || !level) { reply(result); return; }
			// 改全局默认 = 影响所有人 → 限管理员/归属人（与会话级改动不同）
			if (!isAdmin) { reply(`${result}\n（--global/-g 需要管理员或应用归属人）`); return; }
			const written = writeGlobalDefaults(svc.rt.homeDir, { defaultThinkingLevel: level });
			reply(written.ok ? `${result}\n已设为全局默认：新建会话的思考等级 = ${level}` : `${result}\n⚠️ 全局默认写入失败：${written.reason}`);
			svc.log.info("feishu.global_default.written", { kind: "thinkingLevel", value: level, ok: written.ok, operator: msg.senderId, reason: written.reason ?? null });
		},
	};
}

/** `--global`/`-g` 在任意位置都算（对齐 hermes 的 /reasoning 解析）；去掉它之后剩下的才是值。 */
function splitGlobalFlag(raw: string): { wantsGlobal: boolean; value: string } {
	const pattern = /(^|\s)(--global|-g)(\s|$)/;
	return { wantsGlobal: pattern.test(raw), value: raw.replace(/(^|\s)(--global|-g)(\s|$)/g, " ").trim() };
}
