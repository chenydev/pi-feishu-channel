/**
 * `/feishu approvals` —— 汇总"哪些操作要审批"。
 * 直接执行命令的放行判定也用这里的 PS 规则匹配（executeBash 不经过 tool_call 拦截，桥得自己把关）。
 *
 * 只读 pi-permission-system 的配置文件做**摘要**，不复刻它的完整语义：
 * 摘要的目标是让人知道"大致哪些会弹卡、哪些直接拒"，精确判定仍以 PS 运行时为准。
 */
import { existsSync, readFileSync } from "node:fs";
import type { BridgeConfig } from "../types.js";

type Action = "allow" | "ask" | "deny";

export interface PsPermissionConfig {
	yoloMode?: boolean;
	permission?: Record<string, Action | Record<string, Action>>;
}

export function loadPsConfig(file: string | undefined): PsPermissionConfig | undefined {
	if (!file || !existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as PsPermissionConfig;
	} catch {
		return undefined;
	}
}

/** PS 风格的通配（`*` 匹配任意串，其余字面量）。 */
function globToRegExp(pattern: string): RegExp {
	return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
}

/**
 * bash 命令在 PS 规则下的保守判定：任一 deny 规则命中 → deny；否则任一 ask 命中 → ask；
 * 否则取 `*` 默认（缺省 ask）。比 PS 的"最具体规则优先"更保守 —— 用于桥自己把关时宁严勿松。
 */
export function psBashVerdict(config: PsPermissionConfig | undefined, command: string): { verdict: Action; rule?: string } | undefined {
	const bash = config?.permission?.bash;
	if (!config?.permission) return undefined;
	const rules = typeof bash === "object" ? bash : undefined;
	const fallback: Action = typeof bash === "string" ? bash : typeof config.permission["*"] === "string" ? config.permission["*"] as Action : "ask";
	if (!rules) return { verdict: fallback };
	const cmd = command.trim();
	let ask: string | undefined;
	for (const [pattern, action] of Object.entries(rules)) {
		if (pattern === "*") continue;
		if (!globToRegExp(pattern).test(cmd)) continue;
		if (action === "deny") return { verdict: "deny", rule: pattern };
		if (action === "ask") ask ??= pattern;
	}
	if (ask) return { verdict: "ask", rule: ask };
	return { verdict: rules["*"] ?? fallback };
}

export function summarizeApprovalPolicy(input: {
	config: BridgeConfig;
	ps?: PsPermissionConfig;
	psInstalled: boolean;
	alwaysRules?: Array<{ pattern: string }>;
	pendingApprovals: number;
}): string {
	const { config } = input;
	const lines: string[] = ["当前审批策略"];
	const engine = config.approval.policyEngine ?? "bridge";
	if (engine === "pi-permission-system" && input.psInstalled) {
		lines.push("", "引擎：pi-permission-system（规则由管理员在 PS 配置文件里维护）");
		const ps = input.ps;
		if (!ps?.permission) {
			lines.push("· 读不到 PS 配置文件，无法摘要（运行时仍以 PS 为准）");
		} else {
			if (ps.yoloMode) lines.push("· ⚠️ yoloMode 已开启：所有操作直接放行");
			for (const [tool, rule] of Object.entries(ps.permission)) {
				if (tool === "*") continue;
				if (typeof rule === "string") {
					lines.push(`· ${tool}：${label(rule)}`);
					continue;
				}
				const entries = Object.entries(rule);
				const deny = entries.filter(([pattern, action]) => action === "deny" && pattern !== "*").map(([pattern]) => pattern);
				const ask = entries.filter(([pattern, action]) => action === "ask" && pattern !== "*").map(([pattern]) => pattern);
				const parts = [`默认${label(rule["*"] ?? "ask")}`];
				if (ask.length) parts.push(`需审批 ${ask.length} 条：${ask.slice(0, 8).join("、")}${ask.length > 8 ? " …" : ""}`);
				if (deny.length) parts.push(`禁止 ${deny.length} 条：${deny.slice(0, 6).join("、")}${deny.length > 6 ? " …" : ""}`);
				lines.push(`· ${tool}：${parts.join("；")}`);
			}
			const defaultRule = ps.permission["*"];
			if (typeof defaultRule === "string") lines.push(`· 其他工具：${label(defaultRule)}`);
		}
	} else {
		if (engine === "pi-permission-system") lines.push("", "⚠️ 配置为 pi-permission-system，但该扩展未安装 —— 已退回到桥自己的审批。");
		lines.push("", "引擎：桥内置（bash 命令按语义分级）");
		const policy = config.approval.commandPolicy;
		if (policy?.enabled === false) lines.push("· bash：每条命令都弹审批卡（命令分级已关闭）");
		else {
			lines.push("· bash：只读命令（ls/cat/git status…）免审；危险命令（rm -rf /、curl|sh、git push --force…）直接拒绝；其余弹审批卡");
			if (policy?.extraReadOnly?.length) lines.push(`　额外免审：${policy.extraReadOnly.join("、")}`);
			if (policy?.extraDangerous?.length) lines.push(`　额外禁止：${policy.extraDangerous.join("、")}`);
		}
		lines.push(`· 其他工具：${config.approval.autoApprove.length ? `免审 ${config.approval.autoApprove.join("、")}；其余弹卡` : "都弹审批卡"}`);
	}
	lines.push("");
	lines.push(`· 管理员免审：${config.approval.adminSkipApproval ? "开（管理员发起的调用直接放行）" : "关"}`);
	if (input.alwaysRules) {
		lines.push(`· 「始终批准」规则：${input.alwaysRules.length ? input.alwaysRules.map((rule) => rule.pattern).slice(0, 10).join("、") : "无"}`);
	}
	lines.push(`· 审批卡超时：${Math.round(config.approval.timeoutMs / 60_000)} 分钟（超时按拒绝处理）`);
	lines.push(`· 当前待审批：${input.pendingApprovals} 条`);
	return lines.join("\n");
}

function label(action: string): string {
	return action === "allow" ? "放行" : action === "deny" ? "禁止" : action === "ask" ? "需审批" : action;
}
