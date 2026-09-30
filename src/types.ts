/**
 * pi-feishu-channel 核心类型定义。
 */

// ---------------------------------------------------------------- 配置 ----

export type GroupPolicy = "open" | "mention" | "disabled" | "allowlist" | "blacklist" | "admin_only";

/** 进度展示档位（对齐 hermes `display.tool_progress`）。 */
export type ProgressMode = "off" | "new" | "all" | "verbose";

/** 每群规则（hermes FeishuGroupRule 对齐）：未配置字段继承全局。 */
export interface GroupRule {
	policy?: GroupPolicy;
	allowlist?: string[];
	blacklist?: string[];
	requireMention?: boolean; // undefined = 继承全局
	/**
	 * 该群的专属提示词（角色、约束）。会话首轮注入一次（会话重建/切换后再注入），
	 * 对齐 hermes `channel_prompts`。可用 `/feishu prompt` 在飞书里查看/修改（管理员）。
	 */
	prompt?: string;
	/**
	 * 该群可用的工具（白名单或预设档位 readonly/standard/full）。会话创建时生效。
	 * 与审批是两层独立防线：不在白名单里的工具，模型根本看不到。
	 */
	tools?: string[] | "readonly" | "standard" | "full";
	/** 该群每日费用上限（USD；0/缺省 = 不限）。 */
	dailyBudgetUsd?: number;
}

export interface BatchConfig {
	enabled: boolean;
	/** 合并窗口的**上限**：从窗口首条算起最多等这么久（旧语义：固定窗口）。 */
	textWindowMs: number;
	/**
	 * 防抖间隔（默认 800ms）。每来一条就把窗口往后延 debounceMs，但不超过 textWindowMs。
	 * 单条消息只等 debounceMs 就派发，不再固定等满 textWindowMs（线上 3s 的首响应延迟）。
	 * 设为 0 = 旧行为（固定等满 textWindowMs）。
	 */
	debounceMs?: number;
	/**
	 * 媒体合批（**默认关闭**）。开启后同一发送者/同一上下文连续发的图片、文件、音视频
	 * 与文字并成一个 turn（一次发 3 张图不再触发 3 轮 agent）。
	 */
	media?: boolean;
	maxMessages: number;
	maxChars: number;
}

export interface BridgeConfig {
	appId: string;
	appSecret: string;
	domain: "feishu" | "lark";
	/** 可选；启动后用 /open-apis/bot/v3/info 的查询结果覆盖 */
	botOpenId?: string;
	botUserId?: string;
	botName?: string;

	/**
	 * 展示用时区（IANA 名称，如 Asia/Shanghai）。
	 * 解析顺序：FEISHU_TIMEZONE 环境变量 > config.json > 容器 TZ > 默认 Asia/Shanghai。
	 * 只影响「面向用户的时间显示」；对时间戳存储/比较没有影响（那些一律用 epoch）。
	 */
	timezone: string;

	groupPolicy: GroupPolicy;
	/** 每群策略覆盖（优先于全局）——保留向后兼容 */
	groupPolicyByChat: Record<string, GroupPolicy>;
	/** 每群完整规则（hermes group_rules 对齐） */
	groupRules: Record<string, GroupRule>;
	/** 未配置规则群的兜底策略（hermes default_group_policy；空 = 用全局 groupPolicy） */
	defaultGroupPolicy?: GroupPolicy;
	/** 群白名单；空数组 = 全部群按策略 */
	allowChats: string[];
	/** DM 白名单；空 = 全部放行 */
	/**
	 * 允许私聊（DM）的用户 open_id 白名单。
	 * 默认拒绝：空数组 = 拒绝所有私聊；管理员与应用归属人例外，
	 * 始终放行（归属人随应用自动刷新，无需手工维护）。
	 */
	allowUsers: string[];
	/**
	 * 管理员与「应用归属人」是否豁免 @ 检查（**默认 false**）。
	 * 默认关闭时对齐 hermes 两层模型：admin 只豁免策略层，群内仍必须 @ 才触发。
	 * 归属人由启动时调用开放平台接口查询得到（见 implicitAdmins），无需手工维护 open_id。
	 */
	adminBypassMention?: boolean;
	/**
	 * 启动时查询得到的隐式管理员（应用 owner/creator 的 open_id，当前应用视角）。
	 * 不写入配置文件：换应用/改归属后重启自动刷新。
	 */
	implicitAdmins?: string[];
	/** 启动时查询得到：应用归属人 open_id（不落盘）。展示与开通申请私聊用。 */
	appOwnerId?: string;
	/** 启动时查询得到：应用协作者 open_id（不含归属人，不落盘）。 */
	appCollaboratorIds?: string[];
	/** 管理员 open_id；豁免群策略层（@ 层由 adminBypassMention 决定） */
	admins: string[];
	/**
	 * 允许触发桥的 bot/app 白名单。
	 *
	 * 元素可以是：
	 * - `app_id`（如 cli_xxx）—— 跨应用稳定，推荐；
	 * - `open_bot_id`（如 ou_xxx）—— 按应用视角生成，换应用后失效；
	 * - 特殊值 `"mentions"` —— 任何 bot 消息只要 @ 了本 bot 就放行
	 *   （对齐 hermes allow_bots=mentions）。不依赖 id，故换应用后不失效，
	 *   且天然防死循环：两个 bot 自动互回时不会互相 @。
	 *
	 * 默认空 = 拒绝所有 bot 消息（hermes allow_bots=none 的安全默认）。
	 */
	allowBots?: string[];
	/** run 空闲超时（无任何事件产出才算）；0 = 关闭。默认 10 分钟。 */
	runIdleTimeoutMs?: number;
	/** run 总时长硬上限；0 = 不限制（默认）。 */
	runMaxDurationMs?: number;
	/**
	 * 是否忽略「@所有人」的唤醒（默认 true = 过滤）。
	 * @所有人 常用于群公告类广播，默认不应唤醒 agent；
	 * 显式设为 false 后，@所有人 与 @本 bot 等效（仍受群策略与白名单约束）。
	 */
	ignoreAtAll?: boolean;
	/** mention 策略下，回复 bot 消息（parent 命中本 bot 已发缓存）免 @ */
	groupAlsoOnReply: boolean;
	/** 群内普通消息按用户隔离会话（hermes group_sessions_per_user 默认 true）；
	 * 话题内始终共享话题会话（thread_sessions_per_user=false 等价）。 */
	groupSessionsPerUser: boolean;
	requireMention: boolean;

	batch: BatchConfig;
	forwarding: { acceptMergeForward: boolean };
	/**
	 * 审批策略：
	 * - autoApprove：按工具名免审批（原有）
	 * - adminSkipApproval：**管理员/应用归属人发起的工具调用直接放行**（默认 false）
	 */
	approval: {
		autoApprove: string[];
		timeoutMs: number;
		adminSkipApproval?: boolean;
		/**
		 * 命令级审批策略：按 bash 命令语义分级，避免「每个 shell 命令都要点一次审批」。
		 * - 只读命令（ls/cat/git status…）免审
		 * - 危险命令（rm -rf/、fork 炸弹、curl|sh、git push --force…）直接拒绝
		 * - 其余仍弹审批卡
		 * 判定不确定时一律归为「询问」，宁可多问不可误放。
		 */
		/**
		 * 策略引擎归属：
		 * - "bridge"（默认）：用桥自研的 command-policy + 飞书审批卡
		 * - "pi-permission-system"：策略完全交给 @gotgenes/pi-permission-system
		 *   （它在 pi 的子会话里先于桥的拦截执行，deny 时桥根本收不到调用），
		 *   桥不再弹审批卡 —— 用户用该扩展的配置文件维护放行/黑名单规则。
		 *
		 * **默认拒绝**：若该扩展实际上没装成，桥会退回到自己的审批而非静默放行。
		 */
		policyEngine?: "bridge" | "pi-permission-system";
		commandPolicy?: {
			enabled: boolean;
			extraReadOnly?: string[];
			extraDangerous?: string[];
		};
		/**
		 * pi-permission-system 父会话转发（**默认关闭**，实验性）。
		 *
		 * 打开后桥充当该扩展的「父会话应答方」：在进程环境里声明父子关系（PI_SUBAGENT_PARENT_SESSION，
		 * 见 approval/ps-forwarding.ts 的 PS_FORWARDING_PARENT_ENV_KEYS），
		 * 并在 <agentDir>/sessions/permission-forwarding/ 下发布心跳 + 轮询子会话写入的请求文件，
		 * 把 PS 的 ask 变成飞书审批卡。
		 * 关闭时桥不碰该环境变量、不读写转发目录（保持 33.0.3 的现状：ask 无人应答 → 拒绝）。
		 */
		forwarding?: {
			enabled: boolean;
			/** 桥侧父会话 id（PS 用它命名转发目录；必须稳定且不等于任何真实 session id）。 */
			parentSessionId?: string;
			/**
			 * 「始终批准」规则表（默认 true）。开启后审批卡多一个 always 按钮；
			 * 命中已记规则的请求直接放行、不再弹卡。撤销见 `/feishu always revoke`。
			 */
			alwaysApprove?: boolean;
		};
	};
	/**
	 * 处理状态表情。`failureEmoji`（默认 CrossMark）：处理失败时加在原消息上，
	 * 用户不用翻错误消息就能看出哪条没成功；设为空字符串关闭。
	 */
	reaction: {
		processingEmoji: string;
		enabled: boolean;
		failureEmoji?: string;
		/** 忙碌时并入当前任务的消息改加这个表情（默认 JIAYI「+1」；空串 = 仍用 processingEmoji）。 */
		steerEmoji?: string;
	};
	/**
	 * 忙碌时排队的消息回复一次"已排队，第 N 个"（同一会话 10 秒内只提示一次；默认开）。
	 */
	queueNotice?: boolean;
	/**
	 * 超长回答转文件（**默认关闭**）。开启后超过 `thresholdChars`（默认 6000）的回答
	 * 正文只放开头 + "完整内容见附件"，全文以 .md 文件经持久 outbox 发送。
	 */
	longReply?: { asFile?: boolean; thresholdChars?: number; previewChars?: number };
	/**
	 * `!<命令>` 直接执行（**默认关闭**，仅管理员）。不经过模型；经桥的命令分级：
	 * deny 直接拒绝、ask 需要 `allowAsk` 才放行（没有审批卡通道时一律拒绝），全部写审计日志。
	 */
	directBash?: { enabled?: boolean; timeoutMs?: number; allowAsk?: boolean; p2pOnly?: boolean };
	/** 定时任务（**默认关闭**，仅管理员可增删）。 */
	cron?: { enabled?: boolean; catchUp?: "skip" | "once"; maxJobs?: number };
	/** 桥自身告警私聊管理员（**默认关闭**）。 */
	alerts?: {
		enabled?: boolean;
		/** 断线超过多久告警（默认 2 分钟）。 */
		disconnectMs?: number;
		/** 近 5 分钟重连超过多少次告警（默认 10）。 */
		reconnectsIn5m?: number;
		/** 审批积压超过多少条告警（默认 5）。 */
		pendingApprovals?: number;
		/** 同类告警最短间隔（默认 30 分钟）。 */
		cooldownMs?: number;
		/** 接收人（默认全体有效管理员）。 */
		recipients?: string[];
	};
	/** 入群欢迎与未放行群的管理员提示（默认开；只在已放行群发欢迎）。 */
	onboarding?: {
		welcome?: boolean;
		notifyAdmins?: boolean;
		/**
		 * 开通申请（**默认关闭**）：未放行的群里有人 @ 机器人 → 管理员在群里就在群里弹审批卡并 @ 他们，
		 * 否则私聊应用归属人；群里回告申请人"已发给谁"。开启后取代"只有管理员 @ 才私聊他"的旧行为。
		 */
		accessRequest?: boolean;
		/** 同一个群两次开通申请的最短间隔（默认 1 小时）。 */
		accessRequestCooldownMs?: number;
		/**
		 * 谁能审批群开通（点"放行此群 / 暂不放行"，也决定申请发给谁）。默认 `owner`：仅应用归属人。
		 * `owner_collaborators` = 归属人 + 应用协作者；`all` = 再加 config.admins。
		 */
		accessApprovers?: "owner" | "owner_collaborators" | "all";
	};
	/** 表情反馈统计（默认开，只记计数）与 agent 自定义卡片工具（默认关）。 */
	feedback?: { enabled?: boolean };
	cardTool?: { enabled?: boolean };
	/** 语音转写（**默认关闭**）。`provider: "openai"` = OpenAI 兼容的 /audio/transcriptions。 */
	stt?: { provider?: "off" | "openai"; endpoint?: string; model?: string; apiKeyEnv?: string; maxBytes?: number };
	/** 私聊个人提示词（open_id → 提示词；`/feishu prompt set` 在私聊里写这里）。 */
	userPrompts?: Record<string, string>;
	/** 数据卫生。会话文件保留期（天；0 = 不归档，默认 0）。 */
	retention?: { sessionDays?: number };
	/** status.json 心跳间隔（默认 30s；0 = 关闭）。 */
	statusHeartbeatMs?: number;
	/**
	 * 在云文档评论里 @ 机器人 → 机器人在评论区回复（**默认关闭**）。
	 * 只响应管理员与 `allowUsers` 里的人；`tools` 缺省 readonly（评论区没有审批卡可点）。
	 * 需要应用订阅 `drive.notice.comment_add_v1` 事件并具备云文档评论读写权限。
	 */
	docComments?: { enabled?: boolean; allowUsers?: string[]; tools?: string[] | "readonly" | "standard" | "full" };
	/**
	 * 会议邀请（`vc.bot.meeting_invited_v1`）→ 在邀请人私聊里开一轮任务（**默认关闭**）。
	 * 只响应私聊准入允许的人（管理员 / allowUsers）。
	 */
	meetingInvite?: { enabled?: boolean };
	/** 给 agent 的 `feishu_doc_read` 工具（读取云文档纯文本，**默认关闭**）。 */
	docTools?: { enabled?: boolean; maxChars?: number };
	/**
	 * CardKit 流式卡片（**默认关闭**）。
	 * 打开后过程内容用流式卡片呈现，最终回答仍走 durable 文本通道（卡片失败不影响交付）。
	 * 需要应用具备 `cardkit:card:write` 权限；也可用环境变量 FEISHU_STREAMING_CARD=1 临时启用。
	 */
	streamingCard?: {
		enabled: boolean;
		throttleMs: number;
		/** 打字机参数：每次上屏间隔（毫秒）。平台默认 70，越小越快。 */
		printFrequencyMs?: number;
		/** 打字机参数：每次上屏字符数。平台默认 1（500 字要播 35 秒），实测 50 可显著加速。 */
		printStep?: number;
	};
	/**
	 * final 页脚（模型/耗时/token/上下文/费用估算）。
	 *
	 * `showCny` / `showContext` 默认开；关掉后回到旧版页脚（只有 $ 与 token）。
	 */
	footer: { enabled: boolean; showCost: boolean; showCny?: boolean; showContext?: boolean; showSession?: boolean };
	/**
	 * 页脚**群级开关**（chat_id → 是否显示）。
	 *
	 * 为什么不只放全局：页脚对"看答案的人"是噪声，对"管钱的人"是信号 —— 群里谁来
	 * 决定？让该群的管理员当场决定（`/feishu footer off`），而不是让所有人一起去改配置。
	 * 缺省（该群没有条目）= 跟随 `footer.enabled`。
	 */
	footerByChat?: Record<string, boolean>;
	/**
	 * 用量报告（`/feishu usage`）的账户余额查询。
	 *
	 * 只在用户主动执行命令时才打外部接口，带 TTL 缓存（避免连续查询打爆）。
	 */
	usage?: { balanceTtlMs?: number; snapshots?: boolean; /** 账户用量提供方；none = 不查余额、页脚不折算人民币。默认 deepseek。 */ provider?: "deepseek" | "none" };
	/** 空闲会话回收（与 maxActiveSessions 的“并发上限”语义不同）。 */
	sessionLifecycle: { idleTtlMs: number; maxResidentSessions: number; sweepIntervalMs: number };
	/**
	 * 处理中进度展示。
	 *
	 * `mode` 对齐 hermes 的 `display.tool_progress`：`off` 完全不发进度消息；`new` 只在
	 * **工具变化**时追加一行（hermes 给飞书的默认档，降噪）；`all` 每次工具调用都追加
	 *（本桥默认 —— 用户诉求是「看到了执行了什么 bash 命令」，new 档会把连续同名工具折叠掉）；
	 * `verbose` 同 `all` 但参数预览放宽到 180 字。
	 *
	 * `keepOnFinish` 默认 true（对齐 hermes `cleanup_progress: false`）：完成后**保留**进度消息，
	 * 让「这轮做了什么」可回看；设为 false 才在交付最终答案后撤回。
	 */
	progress: {
		mode: ProgressMode;
		showThinking: boolean;
		/** 进度消息最多保留多少行工具日志（超出则只显示最后 N 行 + 「共 N 步」）。 */
		maxLines: number;
		/** 单行参数预览截断长度（hermes 飞书档位 40）。 */
		previewChars: number;
		keepOnFinish: boolean;
	};
	/**
	 * 受控工作区别名 —— 只允许别名映射到 realpath 白名单目录。
	 * 空对象 = 功能关闭（默认）；绝对路径/`..`/白名单外的值一律拒绝。
	 */
	workspaces: { aliases: Record<string, string> };
	sessionDir: string;
	debug: boolean;
	/** 最近已发消息缓存容量（回复判定用） */
	lastSentCacheSize: number;
	/** 拉取被回复原文的 TTL（毫秒） */
	quotedFetchTtlMs: number;
	/** 入站去重缓存容量 */
	dedupCacheSize: number;
	dedupTtlMs: number;
	/** 同时执行的 Pi 会话上限；其余 conversation 在内存队列等待。 */
	maxActiveSessions: number;
	/**
	 * 给 agent 的上下文。
	 * - `sender`：在消息前加 `[发言人：张三]`。`shared`（默认）只在多人共用的会话（话题、
	 *   或 groupSessionsPerUser=false 的群）里加；`always` 群聊都加；`off` 不加。
	 * - `mentions`（默认 true）：消息里 @ 了别人时追加 `[提及：张三(ou_x)]`，agent 才知道"他"是谁、能 @ 回去。
	 */
	agentContext?: { sender?: "shared" | "always" | "off"; mentions?: boolean };
	/**
	 * WS 连接层。
	 * - `sdkAutoReconnect`（默认 true）：断线交给 SDK 自带重连，桥只在 SDK 进入终态或自动重连超时后整体重建。
	 *   设为 false 退回旧的"桥自管重连"模式（排障用）。
	 * - `selfHealMaxMs`（默认 5 分钟）：SDK 自动重连超过该时长仍未恢复，桥强制整体重建。
	 */
	transport?: { sdkAutoReconnect?: boolean; selfHealMaxMs?: number };
}

export const DEFAULT_CONFIG: BridgeConfig = {
	appId: "",
	appSecret: "",
	domain: "feishu",
	// 默认上海：容器基础镜像是 UTC，不显式指定的话用户看到的时间会差 8 小时
	timezone: "Asia/Shanghai",
	groupPolicy: "mention",
	groupPolicyByChat: {},
	groupRules: {},
	allowChats: [],
	allowUsers: [],
	admins: [],
	groupAlsoOnReply: true,
	allowBots: [],
	// 空闲超时：只在「完全没有事件产出」时中止（对齐 hermes 不设固定总时长的做法）
	runIdleTimeoutMs: 600_000,
	// 总时长上限：默认 0 = 不限制
	runMaxDurationMs: 0,
	groupSessionsPerUser: true,
	requireMention: true,
	// 群内 @ 检查对所有人一致（含管理员/应用归属人）——管理员可显式设为 true 豁免
	adminBypassMention: false,
	batch: { enabled: true, textWindowMs: 3000, debounceMs: 800, media: false, maxMessages: 8, maxChars: 12_000 },
	forwarding: { acceptMergeForward: true },
	approval: {
		autoApprove: [], timeoutMs: 300_000, adminSkipApproval: false, commandPolicy: { enabled: true },
		// 实验性：默认关闭。打开前先确认 pi-permission-system 的 ask 规则确实需要人工判定。
		forwarding: {
			enabled: false,
			// 「始终批准」：桥侧维护规则表，命中规则的转发请求直接放行、不再弹卡。
			// 语义等价于 PS 原生对话框的「始终批准」（PS 记在父会话 SessionRules 里，
			// 桥走不到那条路，改为按规则名记在自己的表里）。默认开 —— 它需要管理员
			// 主动点卡片才生效，且撤销入口存在（/feishu always revoke）。
			alwaysApprove: true,
		},
	},
	reaction: { processingEmoji: "Typing", enabled: true, failureEmoji: "CrossMark", steerEmoji: "JIAYI" },
	queueNotice: true,
	footer: { enabled: true, showCost: true, showCny: true, showContext: true, showSession: true },
	footerByChat: {},
	usage: { balanceTtlMs: 5 * 60_000, snapshots: true },
	sessionLifecycle: { idleTtlMs: 30 * 60_000, maxResidentSessions: 32, sweepIntervalMs: 60_000 },
	progress: { mode: "all", showThinking: false, maxLines: 6, previewChars: 40, keepOnFinish: true },
	// 默认关闭 —— 未确定授权范围前不允许切换工作区
	workspaces: { aliases: {} },
	sessionDir: "sessions/feishu",
	debug: false,
	lastSentCacheSize: 64,
	quotedFetchTtlMs: 5 * 60_000,
	dedupCacheSize: 4096,
	dedupTtlMs: 24 * 60 * 60_000,
	maxActiveSessions: 8,
};

// ------------------------------------------------------------ 入站消息 ----

export type InboundMsgType = "text" | "image" | "video" | "audio" | "file" | "post" | "merge_forward" | "share_chat" | "interactive" | "unknown";

export interface FeishuMentionRef {
	/** 占位符 key（@_user_N / @_all） */
	key?: string;
	id?: { open_id?: string; user_id?: string; union_id?: string };
	name?: string;
	isSelf: boolean;
}

export interface ResourceRef {
	kind: "image" | "video" | "audio" | "file";
	key: string;
	messageId: string;
	name?: string;
	mimeType?: string;
	size?: number;
}

export interface PiImageContent {
	type: "image";
	/** 裸 base64，不含 data: URI 前缀。 */
	data: string;
	mimeType: string;
}

export interface FeishuInboundMessage {
	messageId: string;
	chatId: string;
	chatType: "p2p" | "group" | "topic";
	senderId: string;
	/**
	 * app/bot 消息的 app_id（如 cli_xxx）。app_id 跨应用稳定，
	 * 而 open_id/open_bot_id 是按应用视角生成的，换应用后会变 —— allowBots 白名单应优先用它。
	 */
	senderAppId?: string; // open_id 优先
	senderName?: string;
	isBot: boolean;
	msgType: InboundMsgType;
	text: string;
	mentions: FeishuMentionRef[];
	resources: ResourceRef[];
	/** 回复链路：被回复消息 id（parent_id ?? upper_message_id ?? root_id） */
	replyToMessageId?: string;
	/** 被回复消息原文（API 拉取；失败为占位文本） */
	replyToText?: string;
	/** 话题/根消息 */
	threadId?: string;
	raw: unknown;
	ts: number;
	/** batch 后保留所有原始事件 id，供恢复审计。 */
	sourceMessageIds?: string[];
	/**
	 * 合成消息（卡片按钮、定时任务）的去重后缀：同一张卡片可以点很多次，
	 * 回执的 outbox dedupeKey 不能只按 messageId（那是卡片的 id）。
	 */
	dedupeNonce?: string;
	/** 合成消息：回复目标（卡片消息 id）；null = 不挂回复直接发（定时任务）；缺省用 messageId。 */
	replyTarget?: string | null;
	/** 合成消息（卡片按钮、定时任务、/retry）：messageId 不是真实飞书消息，不能加表情。 */
	synthetic?: boolean;
	/**
	 * 非聊天的交付目标（云文档评论）。设置后本轮不发进度/卡片/页脚，
	 * 最终回答与错误提示都经 `deliverExternal` 发到目标处；chatId 为 `doc:` 前缀的虚拟会话 id。
	 */
	deliverTo?: DeliveryTarget;
}

/** 云文档评论的回复位置。 */
export interface DeliveryTarget {
	kind: "doc_comment";
	fileToken: string;
	fileType: string;
	commentId: string;
	/** 全文评论（没有划词引用）：回复走新增全文评论。 */
	isWhole: boolean;
}

/** 虚拟会话 id 前缀（云文档评论）。这类 chatId 不是真实飞书会话，不能向其发消息。 */
export const EXTERNAL_CHAT_PREFIX = "doc:";

export type AdmitReason = "self_echo" | "bots_disabled" | "bot_not_mentioned" | "dm_policy_rejected" | "group_policy_rejected" | "not_allowlisted";

// ------------------------------------------------------------ 出站 ----

export interface SendOptions {
	replyTo?: string;
	threadId?: string;
	/** durable final 覆盖此前流式更新的消息；编辑目标失效时回退 reply/create。 */
	editMessageId?: string;
}

export interface SendResult {
	success: boolean;
	messageId?: string;
	error?: string;
	fallback?: boolean; // 是否发生过 reply→create 回退
	retryable?: boolean;
	errorCode?: number;
	retryAfterMs?: number;
	/** 统一错误分类（rate_limited/permission/not_found/...），用于日志与降级决策。 */
	errorClass?: string;
}

export class RetryableError extends Error {}
export class FatalDeliveryError extends Error {}

// ------------------------------------------------------------ 会话 ----

export interface SessionBackend {
	createSession(opts: {
		chatId: string;
		conversationKey: string;
		sessionFile?: string;
		/** 该会话的工作目录（默认进程 cwd；绝不修改进程全局 cwd）。 */
		cwd?: string;
		}): Promise<{
			sessionId: string;
			prompt(text: string, images?: PiImageContent[]): Promise<unknown>;
			steer?(text: string, images?: PiImageContent[]): Promise<void>;
			followUp?(text: string, images?: PiImageContent[]): Promise<void>;
			subscribe(fn: (event: unknown) => void): () => void;
			abort(): Promise<void>;
			dispose(): Promise<void>;
			modelId: string;
			compact?(instructions?: string): Promise<string>;
			setModel?(modelId: string): Promise<boolean>;
			/** 已认证模型清单（provider 用于区分同名模型）。 */
			listModels?(): Promise<Array<{ id: string; provider?: string }>>;
			/** 当前模型支持的思考等级（空/未实现表示不支持）。 */
			availableThinkingLevels?(): string[];
			/** 当前思考等级。 */
			thinkingLevel?(): string;
			/** 设置思考等级（由 provider 内部按模型能力 clamp）。 */
			setThinkingLevel?(level: string): void;
			/** 列出会话目录下的会话（仅用于归属校验后的浏览）。 */
			listSessions?(): Promise<Array<{ path: string; id: string; name?: string; modified: number; messageCount: number }>>;
			/** 当前会话名称。 */
			sessionName?(): string | undefined;
			/** 重命名当前会话（写入 Pi transcript）。 */
			setSessionName?(name: string): void;
			/** 会话累计统计（token/费用/上下文占用）；老 SDK 可能没这个方法。 */
			getSessionStats?(): PiSessionStats | undefined;
			/** 当前启用的工具 / 全部已注册工具 / 设置启用工具（下一轮生效）。 */
			activeToolNames?(): string[];
			allToolNames?(): string[];
			setActiveTools?(names: string[]): void;
			/** 清空 pi 侧的 steer/followUp 排队。 */
			clearQueue?(): { steering: string[]; followUp: string[] };
			/** 直接执行命令（不经过模型；结果记入会话上下文）。 */
			executeBash?(command: string, onChunk?: (chunk: string) => void): Promise<{ output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string }>;
			abortBash?(): void;
			/** 可回退/分叉的用户消息（按时间顺序）。 */
			userMessages?(): Array<{ entryId: string; text: string }>;
			/** 会话树内跳转到某个节点（同一文件）；用户消息节点返回其原文。 */
			navigateTo?(entryId: string): Promise<{ editorText?: string; cancelled: boolean }>;
			/** 从某节点分叉出新会话文件（只含根到该节点的路径）。 */
			branchedSessionFile?(leafId: string): string | undefined;
			/** 当前叶子节点 / 某节点的父节点（null = 根；undefined = 不存在或不支持）。 */
			leafId?(): string | undefined;
			entryParentId?(entryId: string): string | null | undefined;
			/** 导出。 */
			exportHtml?(outputPath: string): Promise<string>;
			exportJsonl?(outputPath: string): string;
			summarizeForBugReport?(hint?: string): Promise<string>;
			lastAssistantText?(): string | undefined;
		}>;
}

/**
 * `AgentSession.getSessionStats()` 的最小子集（只声明桥用到的字段）。
 *
 * 不直接 import SDK 类型：桥对 pi 的依赖面一直保持在「官方导出 + 结构匹配」级别
 * （见 DESIGN §7.2），SDK 加字段不会让桥编译不过。
 */
export interface PiSessionStats {
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total?: number };
	/** 会话累计费用（USD，pi 口径；已含各消息的 peak/off-peak 计价）。 */
	cost?: number;
	/** 当前上下文窗口占用（压缩后 tokens/percent 可能为 null）。 */
	contextUsage?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
}

export interface BridgeSessionState {
	chatId: string;
	conversationKey: string;
	sessionFile: string;
	queue: Array<{ text: string; images: PiImageContent[]; messageId: string; replyToMessageId?: string; replyToText?: string }>;
	activeRun: boolean;
	lastReplyId?: string;
	busySince?: number;
}

// ------------------------------------------------------------ 状态 ----

export interface BridgeStatus {
	appId?: string;
	pid?: number;
	updatedAt?: number;
	connState: "disconnected" | "connecting" | "connected" | "error";
	downSince?: number;
	lastError?: string;
	/** 本进程累计重连次数。 */
	reconnectCount: number;
	/** 最近 5 分钟重连次数：持续偏高即连接在抖动（flapping），此时 connected 与 mtime 都不可信。 */
	reconnectsLast5m?: number;
	startedAt?: number;
	botOpenId?: string;
	botName?: string;
	conversations: number;
	sessionQueues?: { queued: number; active: number; waiting: number };
	pendingApprovals?: number;
	outboxDepth: number;
	outbox: {
		pending: number;
		sending: number;
		sent: number;
		failed: number;
		lanes: number;
		oldestAgeMs: number;
	};
	lastMessageAt?: number;
	messageTotal: number;
	messageDropped: number;
	compensatedMessages: number;
	compensationErrors: number;
	compensationTruncated: number;
	/** 已打开的默认关闭能力（见 features/switches.ts）；默认配置下为空数组。 */
	features?: string[];
}

export interface BotIdentity {
	openId?: string;
	userId?: string;
	name?: string;
}
