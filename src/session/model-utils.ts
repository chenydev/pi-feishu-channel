/**
 * 模型/会话展示用的无状态工具（ConversationManager 与 ConversationCommands 共用）。
 */
import type { SessionUsage } from "../commands/usage-card.js";
import type { SessionBackend } from "../types.js";

type AgentHandle = Awaited<ReturnType<SessionBackend["createSession"]>>;

/** 相对时间展示（不泄露绝对路径/时间戳细节）。 */
export function formatRelative(timestamp: number, now: number): string {
	const delta = Math.max(0, now - timestamp);
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * 把 SDK 会话统计收成报告用的形状。
 *
 * 两层容错：老 SDK 没这个方法、或取统计时抛错 —— 两者都只是"这段不显示"，
 * 不能让页脚和 `/feishu usage` 整体挂掉。
 */
export function sessionUsageStats(agent: AgentHandle | undefined): SessionUsage | undefined {
	try {
		const stats = agent?.getSessionStats?.();
		if (!stats) return undefined;
		const tokens = stats.tokens;
		return {
			...(tokens
				? { tokens: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite } }
				: {}),
			...(typeof stats.cost === "number" ? { cost: stats.cost } : {}),
			...(stats.contextUsage ? { contextUsage: stats.contextUsage } : {}),
			...(typeof stats.userMessages === "number" ? { userMessages: stats.userMessages } : {}),
			...(typeof stats.assistantMessages === "number" ? { assistantMessages: stats.assistantMessages } : {}),
			...(typeof stats.toolCalls === "number" ? { toolCalls: stats.toolCalls } : {}),
		};
	} catch {
		return undefined;
	}
}

/** 模型标签（带 provider 前缀，才能直接复制进 /model）。 */
export function modelLabel(model: { id: string; provider?: string }): string {
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/**
 * 模糊匹配。依次尝试：完整标签或 id 精确 → 前缀 → 包含（均不区分大小写）；
 * 某一层有命中就停（"flash" 前缀唯一命中时不会被包含层的更多候选淹没）。
 */
export function matchModels<T extends { id: string; provider?: string }>(models: T[], query: string): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const label = (model: T) => modelLabel(model).toLowerCase();
	const id = (model: T) => model.id.toLowerCase();
	const exact = models.filter((model) => label(model) === q || id(model) === q);
	if (exact.length > 0) return exact;
	const prefix = models.filter((model) => id(model).startsWith(q) || label(model).startsWith(q));
	if (prefix.length > 0) return prefix;
	return models.filter((model) => label(model).includes(q));
}
