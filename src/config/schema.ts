/**
 * 配置文件（`config.json`）的 schema：字段清单与取值规则的唯一来源。
 *
 * - 校验：`validateFileConfig()` 在加载时检查每个字段的类型与取值，出错时报出完整字段路径；
 * - 未知字段：`unknownConfigFields()` 按 schema 找出拼错或过时的字段（不报错，`/feishu doctor` 会列出）；
 * - 类型：`FileConfig` 由 schema 推导，tests/config-schema.test.ts 保证它与 `BridgeConfig` 的字段一一对应。
 *
 * 默认值仍在 `DEFAULT_CONFIG`（types.ts），合并与规整在 `loadConfig`（config.ts）。
 * 每个字段带说明（`FieldMeta`），`npm run docs:config` 据此生成 docs/configuration.md。
 * 以 `_` 或 `$` 开头的键当注释用（如 `"_comment"`、`"$schema"`），不校验也不报未知。
 */
import { z } from "zod";

const POLICIES = ["open", "mention", "disabled", "allowlist", "blacklist", "admin_only"] as const;
const PROGRESS_MODES = ["off", "new", "all", "verbose"] as const;

const choice = <T extends readonly [string, ...string[]]>(values: T, what: string) =>
	z.enum(values, { error: (issue) => `${what}「${String(issue.input)}」无效（可选 ${values.join("/")}）` });

/** 字段说明（生成 docs/configuration.md 用）：`default` 只在默认值不在 `DEFAULT_CONFIG` 里时填写；`env` 是可覆盖它的环境变量。 */
export interface FieldMeta {
	description: string;
	default?: string;
	env?: string;
	/** 启动时查询得到、不需要手写的字段。 */
	runtime?: boolean;
}

const m = <T extends z.ZodType>(schema: T, description: string, extra: Omit<FieldMeta, "description"> = {}): T =>
	schema.meta({ description, ...extra } satisfies FieldMeta) as T;

const groupPolicy = choice(POLICIES, "群策略");
const bool = z.boolean({ error: "必须是 true/false" });
const num = z.number({ error: "必须是数字" }).finite();
const nonNegative = num.min(0, { error: "不能是负数" });
const str = z.string({ error: "必须是字符串" });
const strList = z.array(str, { error: "必须是字符串数组" });
const toolSet = z.union([z.enum(["readonly", "standard", "full"]), strList], { error: "必须是 readonly/standard/full 或工具名数组" });
const TOOLS_HELP = "`readonly`（只读工具：read/grep/find/ls/网页搜索等）、`standard`（除 bash 以外的全部工具）、`full`（全部工具），或工具名数组";

const groupRule = z.object({
	policy: m(groupPolicy, "这个群的触发策略，取值同 `groupPolicy`"),
	allowlist: m(strList, "`allowlist` 策略下允许触发的用户 open_id"),
	blacklist: m(strList, "`blacklist` 策略下不允许触发的用户 open_id"),
	requireMention: m(bool, "这个群是否必须 @ 机器人才触发"),
	prompt: m(str, "这个群的设定（会话开始时告诉 agent 一次，之后留在会话历史里）"),
	tools: m(toolSet, `这个群里 agent 可用的工具：${TOOLS_HELP}`),
	dailyBudgetUsd: m(nonNegative, "这个群每天的费用上限（美元）。用尽后当天不再接新任务（进行中的不打断）；也可以用 `/feishu budget` 设置"),
}).partial();

export const fileConfigSchema = z.object({
	appId: m(str, "飞书应用的 App ID（`cli_` 开头）。必填", { env: "FEISHU_APP_ID" }),
	appSecret: m(str, "飞书应用的 App Secret。必填；建议用环境变量提供，不要写进文件", { env: "FEISHU_APP_SECRET" }),
	domain: m(choice(["feishu", "lark"], "域名"), "`feishu`（飞书）或 `lark`（Lark 国际版）", { env: "FEISHU_DOMAIN" }),
	botOpenId: m(str, "机器人自己的 open_id。启动时从开放平台查询并覆盖，不用填", { runtime: true }),
	botUserId: m(str, "机器人自己的 user_id。启动时查询，不用填", { runtime: true }),
	botName: m(str, "机器人名称。启动时查询，不用填", { runtime: true }),
	timezone: m(str, "面向用户显示时间用的时区（IANA 名，如 `Asia/Shanghai`）。优先级：环境变量 > 本字段 > 容器的 `TZ` > `Asia/Shanghai`；无效值会被跳过，不会导致启动失败", { env: "FEISHU_TIMEZONE" }),

	groupPolicy: m(groupPolicy, "群聊的默认触发策略：`mention` @ 机器人才响应；`open` 所有消息都响应；`disabled` 不响应群消息；`allowlist` / `blacklist` 按群规则里的名单；`admin_only` 只响应管理员", { env: "FEISHU_GROUP_POLICY" }),
	groupPolicyByChat: m(z.record(z.string(), groupPolicy), "按群覆盖触发策略（群 id → 策略），优先于 `groupPolicy`。新配置建议用 `groupRules`", { env: "FEISHU_GROUP_POLICY_BY_CHAT" }),
	groupRules: m(z.record(z.string(), groupRule), "按群的完整规则（群 id → 规则），字段见下表", { env: "FEISHU_GROUP_RULES" }),
	defaultGroupPolicy: m(groupPolicy, "没有群规则的群使用的策略；不设时用 `groupPolicy`"),
	allowChats: m(strList, "允许使用机器人的群 id。**空数组 = 拒绝所有群**", { env: "FEISHU_ALLOW_CHATS" }),
	allowUsers: m(strList, "允许私聊机器人的用户 open_id。**空数组 = 拒绝所有私聊**；管理员与应用归属人始终可以私聊", { env: "FEISHU_ALLOW_USERS" }),
	adminBypassMention: m(bool, "管理员与应用归属人在群里是否可以不 @ 机器人直接触发"),
	admins: m(strList, "管理员 open_id。管理员不受群策略限制（是否仍需 @ 见 `adminBypassMention`），可以审批工具调用、执行管理命令。应用归属人与协作者启动时自动识别，不用写进来", { env: "FEISHU_ADMINS" }),
	allowBots: m(strList, "允许触发机器人的其它机器人或应用：`app_id`（`cli_` 开头，换应用也不变，推荐）、机器人的 open_id（换应用后会变），或特殊值 `\"mentions\"`（任何 @ 了本机器人的机器人都放行）。空数组 = 拒绝所有机器人发的消息"),
	runIdleTimeoutMs: m(nonNegative, "一轮任务连续多久没有任何进展就中止（毫秒；0 = 不限制）"),
	runMaxDurationMs: m(nonNegative, "一轮任务的总时长上限（毫秒；0 = 不限制）"),
	ignoreAtAll: m(bool, "忽略「@所有人」。设为 false 时，@所有人 等同于 @ 本机器人（仍受群策略和白名单约束）", { default: "true" }),
	groupAlsoOnReply: m(bool, "`mention` 策略下，回复机器人发出的消息时不用再 @", { env: "FEISHU_GROUP_ALSO_ON_REPLY" }),
	groupSessionsPerUser: m(bool, "群里每个人各用一个独立会话；设为 false 时全群共用一个会话。话题里始终共用该话题的会话"),
	requireMention: m(bool, "群里是否必须 @ 机器人才触发", { env: "FEISHU_REQUIRE_MENTION" }),

	batch: m(z.object({
		enabled: m(bool, "把同一个人短时间内连发的多条消息合并成一轮处理"),
		textWindowMs: m(nonNegative, "合并窗口（毫秒）：第一条消息之后这么久内的消息会被合并"),
		debounceMs: m(nonNegative, "最后一条消息之后再等多久（毫秒）才开始处理"),
		media: m(bool, "图片、文件也参与合并"),
		maxMessages: m(nonNegative, "一批最多合并多少条消息"),
		maxChars: m(nonNegative, "一批最多合并多少字"),
	}).partial(), "连续消息合并"),
	forwarding: m(z.object({
		acceptMergeForward: m(bool, "接受「合并转发」的聊天记录，展开后交给 agent"),
	}).partial(), "转发消息"),
	approval: m(z.object({
		autoApprove: m(strList, "不需要审批的工具名"),
		timeoutMs: m(nonNegative, "审批卡的有效期（毫秒），超时视为拒绝"),
		adminSkipApproval: m(bool, "管理员与应用归属人发起的工具调用不用审批"),
		policyEngine: m(choice(["bridge", "pi-permission-system"], "审批策略引擎"), "由谁判定工具调用：`bridge` 用内置规则 + 飞书审批卡；`pi-permission-system` 交给 pi-permission-system 扩展（扩展没装上时自动退回 `bridge`）。详见 [approval.md](approval.md)", { default: '"bridge"', env: "FEISHU_CHANNEL_POLICY_ENGINE" }),
		commandPolicy: m(z.object({
			enabled: m(bool, "按 bash 命令分级：只读命令免审批，危险命令直接拒绝，其余弹审批卡"),
			extraReadOnly: m(strList, "额外当作只读的命令名（按命令名匹配，如 `jq`）"),
			extraDangerous: m(strList, "额外当作危险的命令名（直接拒绝）"),
		}).partial(), "bash 命令分级（`policyEngine` 为 `bridge` 时生效）"),
		forwarding: m(z.object({
			enabled: m(bool, "父会话转发：把 pi-permission-system 的「询问」变成飞书审批卡（实验性）", { env: "FEISHU_PS_FORWARDING" }),
			parentSessionId: m(str, "转发用的父会话 id；必须稳定，且不能和任何真实会话 id 相同", { default: "\"feishu-channel-parent\"" }),
			alwaysApprove: m(bool, "审批卡上提供「始终批准」；命中已批准规则的请求直接放行。撤销用 `/feishu always revoke`", { env: "FEISHU_PS_ALWAYS" }),
		}).partial(), "pi-permission-system 父会话转发"),
	}).partial(), "工具审批。详见 [approval.md](approval.md)"),
	reaction: m(z.object({
		processingEmoji: m(str, "处理中加在原消息上的表情"),
		enabled: m(bool, "处理消息时在原消息上加表情"),
		failureEmoji: m(str, "处理失败时加的表情；空字符串 = 不加"),
		steerEmoji: m(str, "忙碌时被并入当前任务的消息加的表情；空字符串 = 用 `processingEmoji`"),
	}).partial(), "处理状态表情"),
	queueNotice: m(bool, "忙碌时排队的消息回复一次「已排队」（同一会话 10 秒内只提示一次）"),
	longReply: m(z.object({
		asFile: m(bool, "超长回答只发开头，全文作为 .md 附件发送", { default: "false" }),
		thresholdChars: m(nonNegative, "超过多少字算超长", { default: "6000" }),
		previewChars: m(nonNegative, "正文里保留的开头字数", { default: "1500" }),
	}).partial(), "超长回答转文件（可选能力，默认关闭）"),
	directBash: m(z.object({
		enabled: m(bool, "管理员发 `!<命令>` 直接在宿主执行，不经过模型；同样经过 bash 命令分级，全部写审计日志", { default: "false" }),
		timeoutMs: m(nonNegative, "命令超时（毫秒）", { default: "60000" }),
		allowAsk: m(bool, "分级为「需要审批」的命令也直接执行（默认拒绝）", { default: "false" }),
		p2pOnly: m(bool, "只在私聊里可用", { default: "false" }),
	}).partial(), "直接执行命令（可选能力，默认关闭）"),
	cron: m(z.object({
		enabled: m(bool, "定时任务（只有管理员能增删）", { default: "false" }),
		catchUp: m(choice(["skip", "once"], "错过的定时任务处理方式"), "停机期间错过的触发：`skip` 跳过（下次执行时注明错过了几次）；`once` 补跑一次", { default: "\"skip\"" }),
		maxJobs: m(nonNegative, "最多多少个定时任务", { default: "20" }),
	}).partial(), "定时任务（可选能力，默认关闭）"),
	alerts: m(z.object({
		enabled: m(bool, "出问题时私聊管理员：断线、连接抖动、消息永久发送失败、审批积压（带冷却和恢复通知）", { default: "false" }),
		disconnectMs: m(nonNegative, "断线超过多久告警（毫秒）", { default: "120000" }),
		reconnectsIn5m: m(nonNegative, "5 分钟内重连超过多少次告警", { default: "10" }),
		pendingApprovals: m(nonNegative, "待审批超过多少条告警", { default: "5" }),
		cooldownMs: m(nonNegative, "同类告警的最短间隔（毫秒）", { default: "1800000" }),
		recipients: m(strList, "接收告警的 open_id；不设时发给全部管理员"),
	}).partial(), "告警（可选能力，默认关闭）"),
	onboarding: m(z.object({
		welcome: m(bool, "机器人被拉进已放行的群时发欢迎消息", { default: "true" }),
		notifyAdmins: m(bool, "未放行的群里有人 @ 机器人时提示管理员", { default: "true" }),
		accessRequest: m(bool, "开通申请：未放行的群里有人 @ 机器人时，把申请发给能审批的人（在群里弹审批卡，或私聊应用归属人），放行后通知申请人（可选能力，默认关闭）", { default: "false" }),
		accessRequestCooldownMs: m(nonNegative, "同一个群两次开通申请的最短间隔（毫秒）", { default: "3600000" }),
		accessApprovers: m(choice(["owner", "owner_collaborators", "all"], "开通审批人范围"), "谁能审批群开通：`owner` 只有应用归属人；`owner_collaborators` 加上应用协作者；`all` 再加上 `admins`", { default: "\"owner\"" }),
	}).partial(), "入群与开通"),
	feedback: m(z.object({
		enabled: m(bool, "统计用户对回复点的 👍 / 👎（只记计数）", { default: "true" }),
	}).partial(), "回复反馈"),
	cardTool: m(z.object({
		enabled: m(bool, "给 agent 一个 `feishu_card` 工具，用来发自定义交互卡片", { default: "false" }),
	}).partial(), "agent 自定义卡片（可选能力，默认关闭）"),
	stt: m(z.object({
		provider: m(choice(["off", "openai"], "语音转写服务"), "`openai` = 调用 OpenAI 兼容的 `/audio/transcriptions` 接口", { default: "\"off\"" }),
		endpoint: m(str, "转写接口的地址"),
		model: m(str, "转写模型名"),
		apiKeyEnv: m(str, "存放 API key 的环境变量名（key 本身不写进配置）"),
		maxBytes: m(nonNegative, "语音文件大小上限（字节）", { default: "20971520" }),
	}).partial(), "语音消息转写（可选能力，默认关闭）"),
	userPrompts: m(z.record(z.string(), str), "私聊的个人提示词（open_id → 提示词）；在私聊里用 `/feishu prompt set` 设置"),
	retention: m(z.object({
		sessionDays: m(nonNegative, "超过这个天数的会话文件压缩归档；0 = 不归档（可选能力，默认关闭）", { default: "0" }),
	}).partial(), "会话归档"),
	statusHeartbeatMs: m(nonNegative, "`status.json` 的刷新间隔（毫秒；0 = 不定时刷新）", { default: "30000" }),
	docComments: m(z.object({
		enabled: m(bool, "在云文档评论里 @ 机器人，机器人在评论区回复。需要订阅 `drive.notice.comment_add_v1` 事件与云文档评论权限", { default: "false" }),
		allowUsers: m(strList, "除管理员外，还有谁可以在评论里 @ 机器人"),
		tools: m(toolSet, `评论区里 agent 可用的工具：${TOOLS_HELP}。评论区没有审批卡，缺省只读`, { default: "\"readonly\"" }),
	}).partial(), "云文档评论（可选能力，默认关闭）"),
	meetingInvite: m(z.object({
		enabled: m(bool, "机器人被邀请进会议时，在邀请人的私聊里开一轮任务（只响应允许私聊的人）", { default: "false" }),
	}).partial(), "会议邀请（可选能力，默认关闭）"),
	docTools: m(z.object({
		enabled: m(bool, "给 agent 一个 `feishu_doc_read` 工具，读取云文档的纯文本", { default: "false" }),
		maxChars: m(nonNegative, "单次最多读取多少字", { default: "30000" }),
	}).partial(), "云文档读取（可选能力，默认关闭）"),
	streamingCard: m(z.object({
		enabled: m(bool, "用流式卡片展示处理过程；最终回答仍以普通消息发送（卡片失败不影响交付）。需要 `cardkit:card:write` 权限", { env: "FEISHU_STREAMING_CARD" }),
		throttleMs: m(nonNegative, "卡片更新的最短间隔（毫秒）"),
		printFrequencyMs: m(nonNegative, "打字机效果：每次上屏的间隔（毫秒）。飞书平台默认 70，越小越快"),
		printStep: m(nonNegative, "打字机效果：每次上屏的字数。飞书平台默认 1（500 字要播 35 秒）"),
	}).partial(), "流式卡片（默认关闭）"),
	footer: m(z.object({
		enabled: m(bool, "在最终回答末尾显示页脚（模型、耗时、token、上下文、费用）"),
		showCost: m(bool, "页脚显示费用（美元）"),
		showCny: m(bool, "页脚显示折算的人民币"),
		showContext: m(bool, "页脚显示上下文占用"),
		showSession: m(bool, "页脚显示会话编号"),
	}).partial(), "回答页脚"),
	footerByChat: m(z.record(z.string(), bool), "按群开关页脚（群 id → 是否显示），优先于 `footer.enabled`；在群里用 `/feishu footer on|off` 设置"),
	usage: m(z.object({
		balanceTtlMs: m(nonNegative, "账户余额查询结果的缓存时间（毫秒）"),
		snapshots: m(bool, "记录余额快照，用来估算消耗速度"),
		provider: m(choice(["deepseek", "none"], "用量提供方"), "账户余额从哪里查：`deepseek`；`none` = 不查余额，页脚也不折算人民币", { default: "\"deepseek\"" }),
	}).partial(), "用量报告（`/feishu usage`）"),
	sessionLifecycle: m(z.object({
		idleTtlMs: m(nonNegative, "会话空闲多久后释放内存（毫秒）。会话文件保留，下一条消息会自动恢复"),
		maxResidentSessions: m(nonNegative, "内存里最多保留多少个会话"),
		sweepIntervalMs: m(nonNegative, "空闲检查的间隔（毫秒）"),
	}).partial(), "空闲会话回收"),
	progress: m(z.object({
		mode: m(choice(PROGRESS_MODES, "进度档位"), "处理过程的展示：`off` 不展示；`new` 只在换了工具时加一行；`all` 每次工具调用加一行；`verbose` 同 `all`，参数预览更长", { env: "FEISHU_PROGRESS_MODE" }),
		showThinking: m(bool, "展示模型的思考过程"),
		maxLines: m(num, "进度消息最多显示多少行（至少 1）"),
		previewChars: m(num, "每行参数预览的长度（至少 4）"),
		keepOnFinish: m(bool, "回答完成后保留进度消息；设为 false 时撤回"),
	}).partial(), "处理进度"),
	workspaces: m(z.object({
		aliases: m(z.record(z.string(), str), "工作区别名（别名 → 目录）。只能切换到这里列出的目录；空 = 不允许切换工作区"),
	}).partial(), "工作区"),
	sessionDir: m(str, "保留字段，目前不生效：会话文件固定在运行时目录的 `sessions/` 下"),
	debug: m(bool, "输出调试日志", { env: "FEISHU_DEBUG" }),
	lastSentCacheSize: m(nonNegative, "记住最近多少条机器人发出的消息（判断「是不是在回复机器人」）"),
	quotedFetchTtlMs: m(nonNegative, "被回复消息原文的缓存时间（毫秒）"),
	dedupCacheSize: m(nonNegative, "消息去重记录的容量"),
	dedupTtlMs: m(nonNegative, "消息去重记录的保留时间（毫秒）"),
	maxActiveSessions: m(nonNegative, "同时运行的会话上限，超出的排队等待"),
	agentContext: m(z.object({
		sender: m(choice(["shared", "always", "off"], "发言人上下文"), "在消息前加 `[发言人：张三]`：`shared` 只在多人共用的会话里加；`always` 群聊都加；`off` 不加", { default: "\"shared\"" }),
		mentions: m(bool, "消息里 @ 了别人时，告诉 agent 被 @ 的人是谁（姓名和 open_id）", { default: "true" }),
	}).partial(), "给 agent 的上下文"),
	transport: m(z.object({
		sdkAutoReconnect: m(bool, "断线后先交给飞书 SDK 自动重连，超时仍未恢复才整体重建连接；设为 false 时完全由本扩展重连（排障用）", { default: "true" }),
		selfHealMaxMs: m(nonNegative, "SDK 自动重连超过多久仍未恢复就整体重建（毫秒）", { default: "300000" }),
	}).partial(), "长连接"),
	implicitAdmins: m(strList, "启动时查询得到的应用归属人等隐式管理员。不要手写，也不会写回文件", { runtime: true }),
	appOwnerId: m(str, "启动时查询得到的应用归属人 open_id", { runtime: true }),
	appCollaboratorIds: m(strList, "启动时查询得到的应用协作者 open_id", { runtime: true }),
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
