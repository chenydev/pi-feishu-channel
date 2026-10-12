/**
 * 审批模式：工具调用要不要审批、由谁判定。
 *
 * - `off`（默认）：不审批，工具调用直接放行；
 * - `builtin`：内置审批 —— bash 命令分级 + 免审工具 + 飞书审批卡；
 * - `plugin`：交给 pi-permission-system 插件判定（插件没装上时退回 `builtin`）。
 *
 * 生效顺序：会话覆盖（`/feishu approvals <模式>`，只在内存里）> 环境变量 `FEISHU_CHANNEL_APPROVAL_MODE`
 * > 配置文件 `approval.mode` > 默认 `off`。环境变量在判定时读取而不是并进配置：
 * `-g` 写配置文件时不能把环境变量的值写进去。
 */
import { channelEnv } from "../runtime/identity.js";
import type { ApprovalMode, BridgeConfig } from "../types.js";

export type { ApprovalMode };
export const APPROVAL_MODES: readonly ApprovalMode[] = ["off", "builtin", "plugin"];
export type ApprovalModeSource = "session" | "env" | "config" | "default";

export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
	off: "关闭",
	builtin: "内置",
	plugin: "插件（pi-permission-system）",
};

const SOURCE_LABEL: Record<ApprovalModeSource, string> = {
	session: "本会话临时设置",
	env: "环境变量 FEISHU_CHANNEL_APPROVAL_MODE",
	config: "配置文件",
	default: "默认",
};

const ALIASES: Record<string, ApprovalMode> = { 关闭: "off", 内置: "builtin", 插件: "plugin" };

/** 解析模式名（英文或中文），不认识的返回 undefined。 */
export function parseApprovalMode(raw: string | undefined): ApprovalMode | undefined {
	const value = raw?.trim().toLowerCase();
	if (!value) return undefined;
	if ((APPROVAL_MODES as readonly string[]).includes(value)) return value as ApprovalMode;
	return ALIASES[value];
}

/** 环境变量 `FEISHU_CHANNEL_APPROVAL_MODE` 的原值（未设为 undefined）。 */
export function approvalModeEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = channelEnv(env, "APPROVAL_MODE");
	return raw === undefined || raw === "" ? undefined : raw;
}

/** 全局模式（不看会话覆盖）：环境变量 > 配置文件 > 默认。 */
export function globalApprovalMode(
	config: Pick<BridgeConfig, "approval">,
	env: NodeJS.ProcessEnv = process.env,
): { mode: ApprovalMode; source: Exclude<ApprovalModeSource, "session"> } {
	const fromEnv = parseApprovalMode(approvalModeEnv(env));
	if (fromEnv) return { mode: fromEnv, source: "env" };
	if (config.approval.mode) return { mode: config.approval.mode, source: "config" };
	return { mode: "off", source: "default" };
}

/** 某个会话实际生效的模式：会话覆盖优先，其次全局。 */
export function effectiveApprovalMode(
	config: Pick<BridgeConfig, "approval">,
	overrides: ReadonlyMap<string, ApprovalMode>,
	conversationKey: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): { mode: ApprovalMode; source: ApprovalModeSource } {
	const override = conversationKey ? overrides.get(conversationKey) : undefined;
	if (override) return { mode: override, source: "session" };
	return globalApprovalMode(config, env);
}

export function describeApprovalMode(state: { mode: ApprovalMode; source: ApprovalModeSource }): string {
	return `${APPROVAL_MODE_LABEL[state.mode]}（${SOURCE_LABEL[state.source]}）`;
}
