/**
 * 默认关闭的能力开关清单：回答「这个实例当前打开了哪些能力」，不用去翻配置文件。
 * 结果进入启动日志（`feishu.bridge.features`）、`status.json` 的 `features` 与 `/feishu doctor`。
 *
 * 新增默认关闭的能力时在这里登记；名字一旦出现在 status.json 里就是对外契约，不要随意改。
 */
import { resolvePsForwardingConfig } from "../approval/ps-forwarding.js";
import type { BridgeConfig } from "../types.js";

export interface FeatureSwitch {
	readonly name: string;
	enabled(config: BridgeConfig): boolean;
}

export const FEATURE_SWITCHES: readonly FeatureSwitch[] = [
	{ name: "cron", enabled: (c) => c.cron?.enabled === true },
	{ name: "alerts", enabled: (c) => c.alerts?.enabled === true },
	// 与 createTranscriber 的判定一致：只选了 provider 而没有 endpoint 时并不会创建转写器
	{ name: "stt", enabled: (c) => c.stt?.provider === "openai" && Boolean(c.stt.endpoint) },
	{ name: "docComments", enabled: (c) => c.docComments?.enabled === true },
	{ name: "meetingInvite", enabled: (c) => c.meetingInvite?.enabled === true },
	{ name: "cardTool", enabled: (c) => c.cardTool?.enabled === true },
	{ name: "docTools", enabled: (c) => c.docTools?.enabled === true },
	{ name: "directBash", enabled: (c) => c.directBash?.enabled === true },
	{ name: "longReply", enabled: (c) => c.longReply?.asFile === true },
	{ name: "retention", enabled: (c) => (c.retention?.sessionDays ?? 0) > 0 },
	{ name: "accessRequest", enabled: (c) => c.onboarding?.accessRequest === true },
	// 实验开关：不属于可选能力插件，但同样默认关闭，线上是否打开同样需要一眼看到
	{ name: "streamingCard", enabled: (c) => c.streamingCard?.enabled === true },
	// 与实际生效条件一致：策略引擎没让权给 pi-permission-system 时，转发开关不生效
	{ name: "psForwarding", enabled: (c) => resolvePsForwardingConfig(c.approval).enabled },
];

/** 当前打开的能力名（按登记顺序）；默认配置下为空数组。 */
export function enabledFeatures(config: BridgeConfig): string[] {
	return FEATURE_SWITCHES.filter((feature) => feature.enabled(config)).map((feature) => feature.name);
}
