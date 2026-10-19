/**
 * 运行中重新读取 config.json（`/feishu config reload`），只应用「用到时才读」的字段。
 *
 * 每个字段在 `RELOAD_RULES` 里归为三类之一（顶层字段和对象的子字段漏写都编译不过）。docs/configuration.md 的「改后」列由它生成：
 * - `live`：每次用到时从 `rt.config` 读。重新读取后替换进内存，下一条消息 / 下一轮就生效。
 *   只在会话开始时用一次的（群设定 `prompt`、工具档位 `tools`、默认工作区）对新会话生效。
 * - `restart`：启动时读一次——建长连接、构造组件时传进去的数值（超时、缓存容量、定时器间隔），
 *   或者决定可选能力插件装不装。改了要重启；重新读取时**不写进内存**，只在回执里列出来，
 *   避免组件一半用新值一半用旧值。
 * - `runtime`：启动时从开放平台查到的字段，不从文件读，重新读取时保留当前值。
 *
 * 环境变量仍优先于文件：设了 `FEISHU_PROGRESS_MODE` 等变量时，改文件里对应的字段不会生效。
 */
import { isDeepStrictEqual } from "node:util";
import { loadConfig } from "../config.js";
import type { BridgeConfig } from "../types.js";
import type { FileConfig } from "./schema.js";

export type ReloadMode = "live" | "restart" | "runtime";

type SubRules<T> = NonNullable<T> extends unknown[] ? never
	: NonNullable<T> extends Record<string, unknown> ? { [K in keyof NonNullable<T>]-?: Exclude<ReloadMode, "runtime"> } : never;
type Rule<T> = ReloadMode | SubRules<T>;
/** 运行时看到的归类（类型层面的逐字段约束只在 RELOAD_RULES 的声明上）。 */
type LooseRule = ReloadMode | Record<string, ReloadMode>;

/** 「这个字段改了要不要重启」的唯一来源；归类依据写在每项后面。 */
export const RELOAD_RULES: { [K in keyof FileConfig]-?: Rule<FileConfig[K]> } = {
	// 长连接按应用凭据和域名建立
	appId: "restart",
	appSecret: "restart",
	domain: "restart",
	botOpenId: "runtime",
	botUserId: "runtime",
	botName: "runtime",
	// 用量账本启动时按时区建
	timezone: "restart",
	// 准入：每条消息按当前配置判定
	groupPolicy: "live",
	groupPolicyByChat: "live",
	groupRules: "live",
	defaultGroupPolicy: "live",
	allowChats: "live",
	allowUsers: "live",
	allowUsersAllGroups: "live",
	adminBypassMention: "live",
	admins: "live",
	allowBots: "live",
	// 会话管理器构造时取值
	runIdleTimeoutMs: "restart",
	runToolIdleTimeoutMs: "restart",
	runMaxDurationMs: "restart",
	ignoreAtAll: "live",
	groupAlsoOnReply: "live",
	// 已经在跑和排队的消息按原来的会话处理完，之后的消息按新规则分会话
	groupSessionsPerUser: "live",
	requireMention: "live",
	batch: { enabled: "live", textWindowMs: "live", debounceMs: "live", media: "live", maxMessages: "live", maxChars: "live" },
	forwarding: "live",
	approval: {
		autoApprove: "live",
		timeoutMs: "live",
		adminSkipApproval: "live",
		mode: "live",
		commandPolicy: "live",
		// 「始终批准」规则表启动时按它决定建不建
		plugin: "restart",
	},
	reaction: "live",
	queueNotice: "live",
	// 以下可选能力：开关决定插件装不装，整项按重启处理
	longReply: "restart",
	directBash: "restart",
	cron: "restart",
	alerts: "restart",
	// 监听地址/端口只在启动时读（改完重启才能换端口）
	metrics: "restart",
	// 限流参数每次判定都现读，改完 reload 即生效
	rateLimit: "live",
	onboarding: {
		welcome: "live",
		notifyAdmins: "live",
		// 开通申请是可选能力插件，冷却和每小时上限在装配时传入
		accessRequest: "restart",
		accessRequestCooldownMs: "restart",
		accessRequestMaxPerHour: "restart",
		accessApprovers: "live",
	},
	feedback: "live",
	// 提问存储构造时取有效期
	// waitMs 每次调用现读，改完 reload 即生效（ttlMs、panels 仍要重启：它们进了会话记录）
	clarify: "live",
	cardTool: "restart",
	stt: "restart",
	userPrompts: "live",
	retention: "restart",
	// 心跳定时器启动时定间隔
	statusHeartbeatMs: "restart",
	docComments: "restart",
	meetingInvite: "restart",
	docTools: "restart",
	streamingCard: "live",
	footer: "live",
	footerByChat: "live",
	// 用量提供方是懒建的，重新读取后丢掉旧的，下次用到时按新配置建
	usage: "live",
	// 回收定时器构造时定参数
	sessionLifecycle: "restart",
	progress: "live",
	workspaces: "live",
	sessionDir: "restart",
	debug: "live",
	// 缓存容量构造时定
	lastSentCacheSize: "restart",
	quotedFetchTtlMs: "live",
	dedupCacheSize: "restart",
	dedupTtlMs: "restart",
	maxActiveSessions: "live",
	agentContext: "live",
	// SDK 客户端按它建立
	transport: "restart",
	implicitAdmins: "runtime",
	appOwnerId: "runtime",
	appAdminIds: "runtime",
};

/** 某个字段（点分路径的各段，按 id 索引的表里的字段用 `<id>` 占位）的生效方式。 */
export function reloadModeOf(path: readonly string[]): ReloadMode {
	const rule = (RELOAD_RULES as Record<string, LooseRule>)[path[0]];
	if (rule === undefined) throw new Error(`config reload：字段 ${path.join(".")} 没有归类`);
	if (typeof rule === "string") return rule;
	const sub = path[1] === undefined ? undefined : rule[path[1]];
	if (sub === undefined) throw new Error(`config reload：字段 ${path.join(".")} 没有归类到子字段`);
	return sub;
}

export interface ReloadResult {
	/** 已生效的字段（点分路径）。 */
	applied: string[];
	/** 文件里改了、但要重启才生效的字段。 */
	restartRequired: string[];
}

/**
 * 读取 config.json，把 `live` 字段的变化写进 `current`（原地修改：各组件持有的是同一个对象）。
 * 文件不合法时抛错，`current` 不动。
 */
export function reloadConfig(homeDir: string, current: BridgeConfig, env: NodeJS.ProcessEnv = process.env): ReloadResult {
	const next = loadConfig(homeDir, env);
	const applied: string[] = [];
	const restartRequired: string[] = [];
	const target = current as unknown as Record<string, unknown>;
	const source = next as unknown as Record<string, unknown>;
	for (const [key, rule] of Object.entries(RELOAD_RULES as Record<string, LooseRule>)) {
		if (rule === "runtime") continue;
		if (typeof rule === "string") {
			if (same(target[key], source[key])) continue;
			if (rule === "live") {
				target[key] = source[key];
				applied.push(key);
			} else {
				restartRequired.push(key);
			}
			continue;
		}
		const before = (target[key] ?? {}) as Record<string, unknown>;
		const after = (source[key] ?? {}) as Record<string, unknown>;
		const merged = { ...before };
		for (const [sub, mode] of Object.entries(rule)) {
			if (same(before[sub], after[sub])) continue;
			if (mode === "live") {
				if (after[sub] === undefined) delete merged[sub];
				else merged[sub] = after[sub];
				applied.push(`${key}.${sub}`);
			} else {
				restartRequired.push(`${key}.${sub}`);
			}
		}
		// 换成新对象而不是改旧对象：组件只经 `rt.config` 取子对象，不单独持有
		if (applied.some((path) => path.startsWith(`${key}.`))) target[key] = merged;
	}
	return { applied, restartRequired };
}

/** 比较两个配置值；`undefined` 与缺省的键视为相同（运行中的命令清空字段时两种写法都有）。 */
function same(a: unknown, b: unknown): boolean {
	return isDeepStrictEqual(normalize(a), normalize(b));
}

function normalize(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown;
}
