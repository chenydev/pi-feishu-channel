/**
 * 配置文件（`config.json`）的 schema：字段清单与取值规则的唯一来源。
 *
 * - 校验：`validateFileConfig()` 在加载时检查每个字段的类型与取值，出错时报出完整字段路径；
 * - 未知字段：`unknownConfigFields()` 按 schema 找出拼错或过时的字段（不报错，`/feishu doctor` 会列出）；
 * - 类型：`FileConfig` 由 schema 推导，tests/config-schema.test.ts 保证它与 `BridgeConfig` 的字段一一对应。
 *
 * 默认值仍在 `DEFAULT_CONFIG`（types.ts），合并与规整在 `loadConfig`（config.ts）。
 * 以 `_` 或 `$` 开头的键当注释用（如 `"_comment"`、`"$schema"`），不校验也不报未知。
 */
import { z } from "zod";

const POLICIES = ["open", "mention", "disabled", "allowlist", "blacklist", "admin_only"] as const;
const PROGRESS_MODES = ["off", "new", "all", "verbose"] as const;

const choice = <T extends readonly [string, ...string[]]>(values: T, what: string) =>
	z.enum(values, { error: (issue) => `${what}「${String(issue.input)}」无效（可选 ${values.join("/")}）` });

const groupPolicy = choice(POLICIES, "群策略");
const bool = z.boolean({ error: "必须是 true/false" });
const num = z.number({ error: "必须是数字" }).finite();
const nonNegative = num.min(0, { error: "不能是负数" });
const str = z.string({ error: "必须是字符串" });
const strList = z.array(str, { error: "必须是字符串数组" });
const toolSet = z.union([z.enum(["readonly", "standard", "full"]), strList], { error: "必须是 readonly/standard/full 或工具名数组" });

const groupRule = z.object({
	policy: groupPolicy,
	allowlist: strList,
	blacklist: strList,
	requireMention: bool,
	prompt: str,
	tools: toolSet,
	dailyBudgetUsd: nonNegative,
}).partial();

export const fileConfigSchema = z.object({
	appId: str,
	appSecret: str,
	domain: choice(["feishu", "lark"], "域名"),
	botOpenId: str,
	botUserId: str,
	botName: str,
	timezone: str,

	groupPolicy,
	groupPolicyByChat: z.record(z.string(), groupPolicy),
	groupRules: z.record(z.string(), groupRule),
	defaultGroupPolicy: groupPolicy,
	allowChats: strList,
	allowUsers: strList,
	adminBypassMention: bool,
	admins: strList,
	allowBots: strList,
	runIdleTimeoutMs: nonNegative,
	runMaxDurationMs: nonNegative,
	ignoreAtAll: bool,
	groupAlsoOnReply: bool,
	groupSessionsPerUser: bool,
	requireMention: bool,

	batch: z.object({ enabled: bool, textWindowMs: nonNegative, debounceMs: nonNegative, media: bool, maxMessages: nonNegative, maxChars: nonNegative }).partial(),
	forwarding: z.object({ acceptMergeForward: bool }).partial(),
	approval: z.object({
		autoApprove: strList,
		timeoutMs: nonNegative,
		adminSkipApproval: bool,
		policyEngine: choice(["bridge", "pi-permission-system"], "审批策略引擎"),
		commandPolicy: z.object({ enabled: bool, extraReadOnly: strList, extraDangerous: strList }).partial(),
		forwarding: z.object({ enabled: bool, parentSessionId: str, alwaysApprove: bool }).partial(),
	}).partial(),
	reaction: z.object({ processingEmoji: str, enabled: bool, failureEmoji: str, steerEmoji: str }).partial(),
	queueNotice: bool,
	longReply: z.object({ asFile: bool, thresholdChars: nonNegative, previewChars: nonNegative }).partial(),
	directBash: z.object({ enabled: bool, timeoutMs: nonNegative, allowAsk: bool, p2pOnly: bool }).partial(),
	cron: z.object({ enabled: bool, catchUp: choice(["skip", "once"], "错过的定时任务处理方式"), maxJobs: nonNegative }).partial(),
	alerts: z.object({
		enabled: bool, disconnectMs: nonNegative, reconnectsIn5m: nonNegative, pendingApprovals: nonNegative, cooldownMs: nonNegative, recipients: strList,
	}).partial(),
	onboarding: z.object({
		welcome: bool, notifyAdmins: bool, accessRequest: bool, accessRequestCooldownMs: nonNegative,
		accessApprovers: choice(["owner", "owner_collaborators", "all"], "开通审批人范围"),
	}).partial(),
	feedback: z.object({ enabled: bool }).partial(),
	cardTool: z.object({ enabled: bool }).partial(),
	stt: z.object({ provider: choice(["off", "openai"], "语音转写服务"), endpoint: str, model: str, apiKeyEnv: str, maxBytes: nonNegative }).partial(),
	userPrompts: z.record(z.string(), str),
	retention: z.object({ sessionDays: nonNegative }).partial(),
	statusHeartbeatMs: nonNegative,
	docComments: z.object({ enabled: bool, allowUsers: strList, tools: toolSet }).partial(),
	meetingInvite: z.object({ enabled: bool }).partial(),
	docTools: z.object({ enabled: bool, maxChars: nonNegative }).partial(),
	streamingCard: z.object({ enabled: bool, throttleMs: nonNegative, printFrequencyMs: nonNegative, printStep: nonNegative }).partial(),
	footer: z.object({ enabled: bool, showCost: bool, showCny: bool, showContext: bool, showSession: bool }).partial(),
	footerByChat: z.record(z.string(), bool),
	usage: z.object({ balanceTtlMs: nonNegative, snapshots: bool, provider: choice(["deepseek", "none"], "用量提供方") }).partial(),
	sessionLifecycle: z.object({ idleTtlMs: nonNegative, maxResidentSessions: nonNegative, sweepIntervalMs: nonNegative }).partial(),
	progress: z.object({
		mode: choice(PROGRESS_MODES, "进度档位"), showThinking: bool, maxLines: num, previewChars: num, keepOnFinish: bool,
	}).partial(),
	workspaces: z.object({ aliases: z.record(z.string(), str) }).partial(),
	sessionDir: str,
	debug: bool,
	lastSentCacheSize: nonNegative,
	quotedFetchTtlMs: nonNegative,
	dedupCacheSize: nonNegative,
	dedupTtlMs: nonNegative,
	maxActiveSessions: nonNegative,
	agentContext: z.object({ sender: choice(["shared", "always", "off"], "发言人上下文"), mentions: bool }).partial(),
	transport: z.object({ sdkAutoReconnect: bool, selfHealMaxMs: nonNegative }).partial(),
	// 运行时字段：启动时从开放平台查询得到，不应写进文件；出现了也不算拼错
	implicitAdmins: strList,
	appOwnerId: str,
	appCollaboratorIds: strList,
}).partial();

/** 配置文件的类型（全部字段可选；由 schema 推导）。 */
export type FileConfig = z.infer<typeof fileConfigSchema>;

/** 去掉注释键（`_xxx` / `$xxx`），递归处理对象与按 id 索引的表。 */
function stripCommentKeys(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.filter(([key]) => !key.startsWith("_") && !key.startsWith("$"))
		.map(([key, child]) => [key, stripCommentKeys(child)]));
}

/** 校验配置文件内容；不合法时抛出带完整字段路径的错误（`source` 是路径前缀，如 `config`）。 */
export function validateFileConfig(value: unknown, source = "config"): void {
	const result = fileConfigSchema.safeParse(stripCommentKeys(value));
	if (result.success) return;
	const problems = result.error.issues.map((issue) => `${[source, ...issue.path.map(String)].join(".")}：${issue.message}`);
	throw new Error(`配置无效：${problems.join("；")}`);
}

/** 校验单个字段（环境变量里的 JSON 等），出错时报出 `source` 开头的字段路径。 */
export function validateField<K extends keyof typeof fileConfigSchema.shape>(key: K, value: unknown, source: string): void {
	const result = fileConfigSchema.shape[key].safeParse(value);
	if (result.success) return;
	const problems = result.error.issues.map((issue) => `${[source, ...issue.path.map(String)].join(".")}：${issue.message}`);
	throw new Error(`配置无效：${problems.join("；")}`);
}

/** 返回配置对象里 schema 不认识的字段路径（如 `progress.maxline`）。 */
export function unknownConfigFields(value: unknown, schema: z.ZodType = fileConfigSchema, prefix = ""): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const inner = unwrap(schema);
	const out: string[] = [];
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (key.startsWith("_") || key.startsWith("$")) continue;
		const path = prefix ? `${prefix}.${key}` : key;
		let childSchema: z.ZodType | undefined;
		if (inner instanceof z.ZodObject) childSchema = (inner.shape as Record<string, z.ZodType>)[key];
		else if (inner instanceof z.ZodRecord) childSchema = inner.valueType as z.ZodType;
		else continue;
		if (!childSchema) { out.push(path); continue; }
		out.push(...unknownConfigFields(child, childSchema, path));
	}
	return out;
}

function unwrap(schema: z.ZodType): z.ZodType {
	let current = schema;
	while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable) current = current.unwrap() as z.ZodType;
	return current;
}
