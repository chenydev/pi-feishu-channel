/**
 * 按群限制可用工具（`groupRules.<chatId>.tools`）的解析。
 * 与审批是两层独立防线：不在白名单里的工具模型根本看不到。
 */

/** 只读档位允许的工具（与实际注册工具取交集）。 */
const READONLY_TOOLS = ["read", "grep", "find", "ls", "web_search", "web_fetch", "feishu_notify", "feishu_ask"];

/** 把档位/白名单解析成具体工具名（只保留实际存在的）。 */
export function resolveToolPolicy(policy: string[] | "readonly" | "standard" | "full", all: string[]): string[] {
	if (policy === "full") return all;
	if (policy === "readonly") return all.filter((name) => READONLY_TOOLS.includes(name));
	if (policy === "standard") return all.filter((name) => name !== "bash");
	return all.filter((name) => policy.includes(name));
}
