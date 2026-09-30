/**
 * 命令注册表：命令元数据的唯一真源。
 *
 * 帮助文本（纯文本与卡片）、别名解析、"你是不是想用 …"的纠错都从这里生成 ——
 * 帮助列表、分发和别名如果各写一份，早晚会漂。
 * 处理函数不在这里：它们依赖桥的运行态（transport/outbox/会话管理器），由 index 按名字挂上。
 */

export type CommandGroup = "对话" | "模型" | "会话" | "管理";

export interface CommandSpec {
	/** 规范名（小写）。子命令形态写成 `/feishu status`。 */
	name: string;
	/** 别名（小写，完整形态，如 `/clear`、`/q`）。 */
	aliases?: string[];
	/** 用法（给人看）。 */
	usage: string;
	description: string;
	group: CommandGroup;
	/** 仅管理员（帮助里标注；真正的校验在处理函数里）。 */
	adminOnly?: boolean;
	/** 帮助卡片上做成按钮（点击等同于发送该命令；只适合无参命令）。 */
	button?: boolean;
}

export const COMMANDS: readonly CommandSpec[] = [
	// ---- 对话 ----
	{ name: "/new", aliases: ["/clear", "/reset"], usage: "/new [force]", description: "开新会话（旧会话进历史，可 /resume 回去）", group: "对话", button: true },
	{ name: "/stop", usage: "/stop", description: "中止当前任务；已排队的后续任务保留", group: "对话", button: true },
	{ name: "/steer", usage: "/steer <内容>", description: "注入当前任务（空闲时直接开始）", group: "对话" },
	{ name: "/queue", aliases: ["/q"], usage: "/queue <内容> | list | clear", description: "排队为独立任务；list 查看、clear 清空队列", group: "对话" },
	{ name: "/retry", usage: "/retry", description: "用同一条消息重新生成上一轮回答（换模型后再试很方便）", group: "对话", button: true },
	{ name: "/undo", usage: "/undo", description: "撤销最近一轮对话（只回退对话，不回滚已执行的副作用）", group: "对话" },
	{ name: "/compact", usage: "/compact [说明]", description: "压缩当前会话上下文", group: "对话" },
	// ---- 模型 ----
	{ name: "/model", aliases: ["/m"], usage: "/model [片段|provider/model] [-g]", description: "查看或切换模型（支持模糊匹配；-g 设为全局默认）", group: "模型", button: true },
	{ name: "/models", usage: "/models [页]", description: "列出可用模型", group: "模型", button: true },
	{ name: "/thinking", usage: "/thinking [等级] [-g]", description: "查看或设置思考等级", group: "模型" },
	// ---- 会话 ----
	{ name: "/sessions", usage: "/sessions [页]", description: "浏览本会话历史（卡片，可一键恢复）", group: "会话", button: true },
	{ name: "/resume", usage: "/resume <#N>", description: "恢复历史会话", group: "会话" },
	{ name: "/name", usage: "/name <名称>", description: "重命名当前会话", group: "会话" },
	{ name: "/fork", usage: "/fork [#N]", description: "从第 N 条用户消息处分叉出新会话", group: "会话" },
	{ name: "/export", usage: "/export [html|md|summary]", description: "把当前会话导出成文件发到这里", group: "会话" },
	{ name: "/workspace", usage: "/workspace [别名]", description: "查看（任何人）/切换（管理员）受控工作区", group: "会话" },
	{ name: "/cron", usage: "/cron add \"<表达式>\" <任务> | list | rm <id> | pause <id> | resume <id>", description: "定时任务（管理员）", group: "会话", adminOnly: true },
	// ---- 管理 ----
	{ name: "/help", aliases: ["/h", "/?", "/commands", "/feishu help"], usage: "/help", description: "本帮助", group: "管理" },
	{ name: "/feishu status", usage: "/feishu status", description: "连接、会话、队列、outbox 状态", group: "管理", button: true },
	{ name: "/feishu usage", usage: "/feishu usage [week]", description: "用量与费用（week = 近 7 天汇总）", group: "管理", button: true },
	{ name: "/feishu doctor", usage: "/feishu doctor", description: "可解释诊断", group: "管理" },
	{ name: "/feishu approvals", usage: "/feishu approvals", description: "查看当前生效的审批策略（哪些命令要审批）", group: "管理" },
	{ name: "/feishu export", usage: "/feishu export", description: "导出脱敏诊断包（发到管理员私聊）", group: "管理", adminOnly: true },
	{ name: "/feishu policy", usage: "/feishu policy <策略>", description: "设置当前群策略", group: "管理", adminOnly: true },
	{ name: "/feishu footer", usage: "/feishu footer [on|off]", description: "开关当前会话的页脚", group: "管理", adminOnly: true },
	{ name: "/feishu always", usage: "/feishu always [revoke <规则名>]", description: "查看/撤销「始终批准」规则", group: "管理", adminOnly: true },
	{ name: "/feishu prompt", usage: "/feishu prompt [show|set <内容>|clear]", description: "查看/设置本群（或私聊个人）提示词", group: "管理" },
	{ name: "/feishu budget", usage: "/feishu budget [<美元>|off]", description: "查看/设置本群每日费用上限", group: "管理", adminOnly: true },
];

/** 允许直接以 `!` 开头执行命令的前缀，不属于斜杠命令表，但帮助里要提到。 */
export const DIRECT_BASH_PREFIX = "!";

export interface ResolvedCommand {
	spec: CommandSpec;
	/** 命令名之后的参数（按空白切分）。 */
	args: string[];
	/** 命令名之后的原始文本（保留空白与引号，/cron 这类需要）。 */
	rest: string;
}

function lookupTable(specs: readonly CommandSpec[]): Map<string, CommandSpec> {
	const table = new Map<string, CommandSpec>();
	for (const spec of specs) {
		table.set(spec.name, spec);
		for (const alias of spec.aliases ?? []) table.set(alias, spec);
	}
	return table;
}

const DEFAULT_TABLE = lookupTable(COMMANDS);

/**
 * 解析一条文本。先试两段式（`/feishu status`），再试一段式（`/new`）。
 * 不是桥命令返回 undefined（调用方决定交给 Pi 还是纠错）。
 */
export function resolveCommand(text: string, specs: readonly CommandSpec[] = COMMANDS): ResolvedCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const table = specs === COMMANDS ? DEFAULT_TABLE : lookupTable(specs);
	const match = /^(\S+)(?:\s+(\S+))?/.exec(trimmed);
	if (!match) return undefined;
	const first = match[1].toLowerCase();
	const second = match[2]?.toLowerCase();
	if (second) {
		const two = table.get(`${first} ${second}`);
		if (two) {
			const rest = trimmed.slice(match[0].length).trim();
			return { spec: two, args: rest ? rest.split(/\s+/) : [], rest };
		}
	}
	const one = table.get(first);
	if (!one) return undefined;
	const rest = trimmed.slice(match[1].length).trim();
	return { spec: one, args: rest ? rest.split(/\s+/) : [], rest };
}

/** Damerau 简化版编辑距离（插入/删除/替换/相邻交换）。 */
export function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
		}
	}
	return d[a.length][b.length];
}

/**
 * 对"像是打错的桥命令"给出建议（编辑距离 ≤ 2，且命令名至少 4 个字符避免误伤 `/x`）。
 * `known` 是 Pi 自己的命令/模板/技能名（带 `/`）：命中的不纠错，照常交给 Pi。
 */
export function suggestCommand(text: string, known: ReadonlySet<string> = new Set(), specs: readonly CommandSpec[] = COMMANDS): string | undefined {
	const match = /^(\/[^\s]+)(?:\s+(\S+))?/.exec(text.trim());
	if (!match) return undefined;
	const token = match[1].toLowerCase();
	if (token.length < 4 || known.has(token) || token.includes(":")) return undefined;
	const second = match[2]?.toLowerCase();
	let best: { name: string; distance: number } | undefined;
	for (const spec of specs) {
		for (const candidate of [spec.name, ...(spec.aliases ?? [])]) {
			const [head, sub] = candidate.split(" ");
			let distance: number;
			if (sub) {
				if (!second) continue;
				distance = editDistance(token, head) + editDistance(second, sub);
			} else {
				distance = editDistance(token, head);
			}
			if (distance > 0 && distance <= 2 && (!best || distance < best.distance)) best = { name: spec.name, distance };
		}
	}
	return best?.name;
}

/** 纯文本帮助（卡片发不出去时的降级）。 */
export function formatHelpText(specs: readonly CommandSpec[] = COMMANDS, extras: { piCommands?: Array<{ name: string; description?: string }> } = {}): string {
	const groups = new Map<CommandGroup, CommandSpec[]>();
	for (const spec of specs) groups.set(spec.group, [...(groups.get(spec.group) ?? []), spec]);
	const lines: string[] = ["可用命令："];
	for (const [group, list] of groups) {
		lines.push("", `【${group}】`);
		for (const spec of list) {
			const aliases = spec.aliases?.length ? `（别名 ${spec.aliases.join("、")}）` : "";
			lines.push(`${spec.usage}${aliases}${spec.adminOnly ? " 〔管理员〕" : ""}`, `  ${spec.description}`);
		}
	}
	if (extras.piCommands?.length) {
		lines.push("", "【技能与模板】");
		for (const command of extras.piCommands.slice(0, 30)) lines.push(`/${command.name}${command.description ? ` — ${command.description.slice(0, 60)}` : ""}`);
	}
	lines.push("", "忙碌时直接发送普通消息 = 注入当前任务；要等当前任务结束再做用 /queue。");
	return lines.join("\n");
}
