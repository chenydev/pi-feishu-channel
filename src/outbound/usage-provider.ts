/**
 * 账户用量提供方（余额 / 计费档位 / 汇率）的可插拔接口。
 *
 * 桥本身与模型厂商无关：`/feishu usage` 与页脚的人民币换算统一经由 `UsageProvider`，
 * 不直接依赖某家厂商。默认 `deepseek`，`none` 则只展示会话用量、
 * 不打任何外部接口、页脚不做人民币换算。新增厂商只需实现这个接口并在 `createUsageProvider` 注册。
 */
import { createBalanceClient, type BalanceResult } from "./deepseek-balance.js";
import { cnyPerUsdForModel, pricingTierAt, tierLabel } from "./deepseek-usage.js";

export type UsageProviderId = "deepseek" | "none";

export interface UsageProvider {
	readonly id: UsageProviderId;
	/** 卡片"账户"段标题里的厂商名；undefined = 不展示账户段。 */
	readonly accountLabel?: string;
	/** 账户余额（失败降级为 unavailable，不抛异常）。 */
	balance(): Promise<BalanceResult>;
	/** 当前计费档位的展示文案（无分时计价时 undefined）。 */
	tierLabel(now: Date): string | undefined;
	/** 模型的美元→人民币折算系数（未知模型 undefined = 不显示人民币）。 */
	cnyPerUsd(modelId: string | undefined): number | undefined;
}

export interface UsageProviderOptions {
	provider?: UsageProviderId;
	balanceTtlMs?: number;
	snapshotPath?: string;
	apiKey?: string;
	log?: (level: "debug" | "info" | "warn", message: string, meta?: Record<string, unknown>) => void;
}

const NONE_PROVIDER: UsageProvider = {
	id: "none",
	balance: async () => ({ status: "unavailable", reason: "未配置用量提供方（usage.provider = none）" }),
	tierLabel: () => undefined,
	cnyPerUsd: () => undefined,
};

export function createUsageProvider(options: UsageProviderOptions): UsageProvider {
	if (options.provider === "none") return NONE_PROVIDER;
	let client: ReturnType<typeof createBalanceClient> | undefined;
	return {
		id: "deepseek",
		accountLabel: "DeepSeek",
		balance() {
			// 懒建：只在 /feishu usage 时才可能打外部接口
			client ??= createBalanceClient({
				apiKey: options.apiKey,
				ttlMs: options.balanceTtlMs,
				snapshotPath: options.snapshotPath,
				log: options.log,
			});
			return client.get();
		},
		tierLabel: (now) => tierLabel(pricingTierAt(now)),
		cnyPerUsd: cnyPerUsdForModel,
	};
}
