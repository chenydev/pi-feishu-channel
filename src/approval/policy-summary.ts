/**
 * `/feishu approvals` —— 汇总"哪些操作要审批"（当前会话实际生效的审批模式）。
 * 直接执行命令的放行判定也用这里的 PS 规则匹配（executeBash 不经过 tool_call 拦截，桥得自己把关）。
 *
 * 只读 pi-permission-system 的配置文件做**摘要**，不复刻它的完整语义：
 * 摘要的目标是让人知道"大致哪些会弹卡、哪些直接拒"，精确判定仍以 PS 运行时为准。
 */
import { existsSync, readFileSync } from "node:fs";
import type { BridgeConfig } from "../types.js";
import { type ApprovalMode, type ApprovalModeSource, describeApprovalMode } from "./mode.js";
import { splitCommandSegments } from "./command-policy.js";
import { PS_LINK_NAME, PS_MIN_VERSION, type PsLinkStatus } from "./pi-permission-system.js";

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
 * bash 命令在 PS 规则下的保守判定，**逐段**判定后取最严（deny > ask > allow）。
 *
 * 每一段：命中 deny 规则 → deny；否则命中 ask → ask；否则命中 allow → allow；都没命中 → `*` 默认（缺省 ask）。
 * 同一段同时命中 `git *: ask` 和 `git status: allow` 时取 ask —— 比 PS 的"最具体规则优先"更保守，
 * 用于桥自己把关时宁严勿松。
 *
 * **按段判定**（`&&`、`||`、`;`、`|`、换行）：PS 的 bash 规则本来就只看单个命令，
 * 拿整串去匹配会让 `cd /tmp && cat x.env` 错过 `cat *.env: deny`，落到 `*: allow` 上放行。
 * 段里没命中任何规则的部分仍然按 `*` 判定：`*: deny` 下 `cd x && rm y` 不会因为 `cd *: allow` 被放行。
 */
export function psBashVerdict(config: PsPermissionConfig | undefined, command: string): { verdict: Action; rule?: string } | undefined {
	const bash = config?.permission?.bash;
	if (!config?.permission) return undefined;
	const rules = typeof bash === "object" ? bash : undefined;
	const fallback: Action = typeof bash === "string" ? bash : typeof config.permission["*"] === "string" ? config.permission["*"] as Action : "ask";
	if (!rules) return { verdict: fallback };
	const segments = splitCommandSegments(command);
	// 拆不出段（空命令）时退回整串：与以前一致，不额外放行
	const candidates = segments.length > 0 ? segments : [command.trim()];
	const defaultAction: Action = rules["*"] ?? fallback;
	const severity: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };
	let worst: { verdict: Action; rule?: string } | undefined;
	for (const segment of candidates) {
		const matched: Partial<Record<Action, string>> = {};
		for (const [pattern, action] of Object.entries(rules)) {
			if (pattern === "*" || matched[action]) continue;
			if (globToRegExp(pattern).test(segment)) matched[action] = pattern;
		}
		const verdict: { verdict: Action; rule?: string } = matched.deny ? { verdict: "deny", rule: matched.deny }
			: matched.ask ? { verdict: "ask", rule: matched.ask }
				: matched.allow ? { verdict: "allow" }
					: { verdict: defaultAction };
		if (verdict.verdict === "deny") return verdict;
		if (!worst || severity[verdict.verdict] > severity[worst.verdict]) worst = verdict;
	}
	return worst ?? { verdict: defaultAction };
}

export function summarizeApprovalPolicy(input: {
	config: BridgeConfig;
	/** 当前会话实际生效的模式及来源。 */
	mode: { mode: ApprovalMode; source: ApprovalModeSource };
	ps?: PsPermissionConfig;
	psInstalled: boolean;
	/** 授权链环节能否生效（pi-permission-system 模式下显示）。 */
	link?: PsLinkStatus;
	alwaysRules?: Array<{ pattern: string }>;
	pendingApprovals: number;
}): string {
	const { config } = input;
	const { mode } = input.mode;
	const lines: string[] = ["当前审批策略", "", `模式：${describeApprovalMode(input.mode)}`];
	if (mode === "off") {
		lines.push("· 工具调用全部直接放行，不弹审批卡，危险命令也不拦截");
		// 插件的拦截先于本扩展执行，本扩展关不掉它
		if (input.psInstalled) lines.push("· ⚠️ 已安装 pi-permission-system：它的规则仍会独立生效，被它拒绝的调用照样被拒绝");
	} else if (mode === "pi-permission-system" && input.psInstalled) {
		lines.push("· 规则由管理员在 pi-permission-system 的配置文件里维护");
		lines.push(...linkLines(input.link));
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
		if (mode === "pi-permission-system") lines.push("· ⚠️ pi-permission-system 未安装 —— 已退回内置审批");
		const policy = config.approval.commandPolicy;
		if (config.approval.autoApprove.includes("bash")) lines.push("· bash：免审（在免审工具里）");
		else if (policy?.enabled === false) lines.push("· bash：每条命令都弹审批卡（命令分级已关闭）");
		else {
			lines.push("· bash：只读命令（ls/cat/git status…）免审；危险命令（rm -rf /、curl|sh、git push --force…）直接拒绝；其余弹审批卡");
			if (policy?.extraReadOnly?.length) lines.push(`　额外免审：${policy.extraReadOnly.join("、")}`);
			if (policy?.extraDangerous?.length) lines.push(`　额外禁止：${policy.extraDangerous.join("、")}`);
		}
		lines.push(`· 其他工具：${config.approval.autoApprove.length ? `免审 ${config.approval.autoApprove.join("、")}；其余弹卡` : "都弹审批卡"}`);
	}
	lines.push("");
	if (mode !== "off") {
		lines.push(`· 管理员免审：${config.approval.adminSkipApproval ? "开（管理员发起的调用直接放行）" : "关"}`);
		if (mode === "pi-permission-system" && input.alwaysRules) {
			lines.push(`· 「始终批准」规则：${input.alwaysRules.length ? input.alwaysRules.map((rule) => rule.pattern).slice(0, 10).join("、") : "无"}`);
		}
		lines.push(`· 审批卡超时：${Math.round(config.approval.timeoutMs / 60_000)} 分钟（超时按拒绝处理）`);
	}
	lines.push(`· 当前待审批：${input.pendingApprovals} 条`);
	lines.push("", "切换（管理员）：/feishu approvals off|builtin|pi-permission-system 只改本会话；加 -g 写入配置；/feishu approvals reset 恢复全局设置");
	return lines.join("\n");
}

/** 「需审批」的调用会怎样：弹卡，还是因为环节没生效被直接拒绝。 */
function linkLines(link: PsLinkStatus | undefined): string[] {
	if (!link) return [];
	if (!link.versionOk) return [`· ⚠️ pi-permission-system ${link.version ?? "?"} 版本过低（需要 ≥ ${PS_MIN_VERSION}）：「需审批」的调用会被直接拒绝`];
	if (!link.inChain) return [`· ⚠️ 它的 authorizerChain 里没有 ${PS_LINK_NAME}：「需审批」的调用会被直接拒绝`];
	return [
		"· 「需审批」的调用弹飞书审批卡",
		"· 访问路径类的请求（path / external_directory）不能在卡上批准，需要时在它的配置里放行",
	];
}

function label(action: string): string {
	return action === "allow" ? "放行" : action === "deny" ? "禁止" : action === "ask" ? "需审批" : action;
}
