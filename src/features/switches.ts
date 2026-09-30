/**
 * 默认关闭的能力开关清单：回答「这个实例当前打开了哪些能力」，不用去翻配置文件。
 * 结果进入启动日志（`feishu.bridge.features`）、`status.json` 的 `features` 与 `/feishu doctor`。
 *
 * 可选能力插件从 FEATURES 派生；这里另外登记不属于插件、但同样默认关闭的实验开关。
 * 名字一旦出现在 status.json 里就是对外契约，不要随意改。
 */
import { resolvePsForwardingConfig } from "../approval/ps-forwarding.js";
import type { BridgeConfig } from "../types.js";
import { FEATURES } from "./index.js";

export interface FeatureSwitch {
	readonly name: string;
	enabled(config: BridgeConfig): boolean;
}

export const FEATURE_SWITCHES: readonly FeatureSwitch[] = [
	// 可选能力插件（features/index.ts）：开关判定与插件是否装配是同一个函数
	...FEATURES,
	// 实验开关：不属于可选能力插件，但同样默认关闭，线上是否打开同样需要一眼看到
	{ name: "streamingCard", enabled: (c) => c.streamingCard?.enabled === true },
	// 与实际生效条件一致：策略没有交给 pi-permission-system 时，转发开关不生效
	{ name: "psForwarding", enabled: (c) => resolvePsForwardingConfig(c.approval).enabled },
];

/** 当前打开的能力名（按登记顺序）；默认配置下为空数组。 */
export function enabledFeatures(config: BridgeConfig): string[] {
	return FEATURE_SWITCHES.filter((feature) => feature.enabled(config)).map((feature) => feature.name);
}
