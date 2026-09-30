/**
 * 兼容入口：命令元数据的唯一来源已移到 `commands/registry.ts`。
 * 这里只把注册表投影成旧的 `{ usage, description }` 形状，供仍在引用它的地方使用。
 */
import { COMMANDS, formatHelpText } from "./commands/registry.js";

export interface SlashCommandHelp {
	usage: string;
	description: string;
}

/** 飞书端真正由桥消费的命令；未知 slash 仍交给 Pi 的扩展/技能/模板解析。 */
export const FEISHU_SLASH_COMMANDS: ReadonlyArray<SlashCommandHelp> = COMMANDS.map((spec) => ({
	usage: spec.aliases?.length ? `${spec.usage}（别名 ${spec.aliases.join("、")}）` : spec.usage,
	description: spec.description,
}));

export function formatSlashCommandHelp(): string {
	return formatHelpText();
}
