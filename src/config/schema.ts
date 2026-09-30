/**
 * 配置字段表 —— 用来发现拼错/过时的字段（例如 `allowchats`、`progress.maxline`）。
 *
 * 类型校验仍在 loadConfig 里逐字段做（非法值直接报错）；这里只回答"这个字段桥认不认识"：
 * 不认识的字段不会报错（向前兼容），但 `doctor` 会列出来 —— 拼错的配置项静默不生效是最难查的一类问题。
 */

/** 值为 true = 叶子字段；值为对象 = 已知子字段；"*" = 任意键（按 chatId/openId 索引的表）。 */
type Shape = { [key: string]: true | Shape };

const GROUP_RULE: Shape = { policy: true, allowlist: true, blacklist: true, requireMention: true, prompt: true, tools: true, dailyBudgetUsd: true };

export const CONFIG_SHAPE: Shape = {
	appId: true, appSecret: true, domain: true, botOpenId: true, botUserId: true, botName: true, timezone: true,
	groupPolicy: true, groupPolicyByChat: { "*": true }, groupRules: { "*": GROUP_RULE }, defaultGroupPolicy: true,
	allowChats: true, allowUsers: true, adminBypassMention: true, admins: true, allowBots: true,
	runIdleTimeoutMs: true, runMaxDurationMs: true, ignoreAtAll: true, groupAlsoOnReply: true, groupSessionsPerUser: true, requireMention: true,
	batch: { enabled: true, textWindowMs: true, debounceMs: true, media: true, maxMessages: true, maxChars: true },
	forwarding: { acceptMergeForward: true },
	approval: {
		autoApprove: true, timeoutMs: true, adminSkipApproval: true, policyEngine: true,
		commandPolicy: { enabled: true, extraReadOnly: true, extraDangerous: true },
		forwarding: { enabled: true, parentSessionId: true, alwaysApprove: true },
	},
	reaction: { processingEmoji: true, enabled: true, failureEmoji: true, steerEmoji: true },
	queueNotice: true,
	longReply: { asFile: true, thresholdChars: true, previewChars: true },
	directBash: { enabled: true, timeoutMs: true, allowAsk: true, p2pOnly: true },
	cron: { enabled: true, catchUp: true, maxJobs: true },
	alerts: { enabled: true, disconnectMs: true, reconnectsIn5m: true, pendingApprovals: true, cooldownMs: true, recipients: true },
	onboarding: { welcome: true, notifyAdmins: true, accessRequest: true, accessRequestCooldownMs: true, accessApprovers: true },
	feedback: { enabled: true },
	cardTool: { enabled: true },
	stt: { provider: true, endpoint: true, model: true, apiKeyEnv: true, maxBytes: true },
	userPrompts: { "*": true },
	retention: { sessionDays: true },
	statusHeartbeatMs: true,
	streamingCard: { enabled: true, throttleMs: true, printFrequencyMs: true, printStep: true },
	footer: { enabled: true, showCost: true, showCny: true, showContext: true, showSession: true },
	footerByChat: { "*": true },
	docComments: { enabled: true, allowUsers: true, tools: true },
	meetingInvite: { enabled: true },
	docTools: { enabled: true, maxChars: true },
	usage: { balanceTtlMs: true, snapshots: true, provider: true },
	sessionLifecycle: { idleTtlMs: true, maxResidentSessions: true, sweepIntervalMs: true },
	progress: { mode: true, showThinking: true, maxLines: true, previewChars: true, keepOnFinish: true },
	workspaces: { aliases: { "*": true } },
	sessionDir: true, debug: true, lastSentCacheSize: true, quotedFetchTtlMs: true, dedupCacheSize: true, dedupTtlMs: true, maxActiveSessions: true,
	agentContext: { sender: true, mentions: true },
	transport: { sdkAutoReconnect: true, selfHealMaxMs: true },
	// 运行时字段（不应写进文件，但出现了也不算"拼错"）
	implicitAdmins: true,
	appOwnerId: true,
	appCollaboratorIds: true,
};

/** 返回配置对象里桥不认识的字段路径（如 `progress.maxline`）。 */
export function unknownConfigFields(value: unknown, shape: Shape = CONFIG_SHAPE, prefix = ""): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const out: string[] = [];
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const path = prefix ? `${prefix}.${key}` : key;
		// 以 _ 或 $ 开头的键当注释用（如 "_comment"、"$schema"），不报
		if (key.startsWith("_") || key.startsWith("$")) continue;
		const spec = shape[key] ?? shape["*"];
		if (spec === undefined) { out.push(path); continue; }
		if (spec !== true) out.push(...unknownConfigFields(child, spec, path));
	}
	return out;
}
