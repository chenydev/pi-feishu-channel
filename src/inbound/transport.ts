/**
 * 飞书 WS 长连 transport：lark SDK 包装 + bot 身份水合 + 事件分发 + 连接状态。
 * 关键决策：
 * - WSClient 开启 SDK 自带重连（对齐 hermes 与 SDK 官方 LarkChannel）：断线由 SDK 的重连阶梯处理，
 *   transport 只通过 onReconnecting/onReconnected 观察状态；上层 ReconnectSupervisor 只在 SDK 报告终态
 *   失败（failed/idle）或自愈超时后才整体重建。`transport.sdkAutoReconnect=false` 可退回旧的自管模式；
 * - 带 extraUaTags ['channel']（官方推荐：不带时部分租户不推群内 @ 事件）；
 * - 关闭时发 CLOSE 帧（close() 非 force）：terminate 不告知服务端，服务端会继续往失效端点推送直到超时；
 * - SDK 回调立即返回：消息按 chat 串行在后台处理；卡片回调 2.5s 内没算完先回 toast，算完再刷卡；
 * - bot 身份水合 GET /open-apis/bot/v3/info（openId + name 一起水合，hermes 设计）；
 * - 事件负载可能被 SDK 包成 { event: {...} }，统一剥壳。
 */
import { type DocCommentEvent, parseDocCommentEvent } from "./doc-comments.js";
import { type MeetingInvite, parseMeetingInvite } from "./meeting-invite.js";
import type { BotIdentity, BridgeConfig, FeishuInboundMessage } from "../types.js";
import type { ResourceRef } from "../types.js";
import { normalizeFeishuMessage } from "./normalize.js";
import { apiErrorCode, assertApiOk, isReplyFallbackCode } from "../outbound/api-errors.js";
import type { Readable } from "node:stream";

// ---- 结构接口（真实 @larksuiteoapi/node-sdk 满足；测试注入 fake）----

export interface LarkSdkClient {
	request(opts: { url: string; method: string; params?: unknown; data?: unknown; headers?: Record<string, string> }): Promise<unknown>;
	im?: { v1?: {
		messageResource?: { get(payload: { params: { type: string }; path: { message_id: string; file_key: string } }): Promise<{ getReadableStream(): Readable; headers?: Record<string, unknown> }> };
		image?: { create(payload: { data: { image_type: "message"; image: Buffer } }): Promise<unknown> };
		file?: { create(payload: { data: { file_type: "stream" | "mp4" | "opus"; file_name: string; file: Buffer } }): Promise<unknown> };
	} };
}

export interface LarkSdkDispatcher {
	register(handlers: Record<string, (data: unknown) => Promise<unknown> | unknown>): LarkSdkDispatcher;
}

export interface LarkSdkWsClient {
	start(opts: { eventDispatcher: LarkSdkDispatcher }): void;
	close(params?: { force?: boolean }): void;
	getConnectionStatus?(): string | { state?: string };
}

export interface LarkSdkLike {
	Domain: { Feishu: string; Lark: string };
	Client: new (opts: { appId: string; appSecret: string; appType: number; domain: string; loggerLevel?: number }) => LarkSdkClient;
	WSClient: new (opts: {
		appId: string;
		appSecret: string;
		domain?: string;
		autoReconnect?: boolean;
		extraUaTags?: string[];
		onReady?: () => void;
		onError?: (err: unknown) => void;
		onReconnecting?: () => void;
		onReconnected?: () => void;
	}) => LarkSdkWsClient;
	EventDispatcher: new (opts?: { loggerLevel?: number }) => LarkSdkDispatcher;
}

export interface TransportEventMap {
	message: FeishuInboundMessage;
	status: { connState: string; reconnectCount: number };
}

export interface TransportDeps {
	config: BridgeConfig;
	sdk: LarkSdkLike;
	onMessage: (msg: FeishuInboundMessage) => Promise<void>;
	onStatus?: (connState: string, reconnectCount: number) => void;
	onCardAction?: (action: CardAction) => Promise<unknown>;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	probeTtlMs?: number; // 测试注入
	now?: () => number;
	/** 卡片回调同步应答时限（飞书 3s；默认 2500ms）。 */
	cardActionBudgetMs?: number;
	/** 消息之外的生命周期事件（撤回、入群/退群、私聊进入、表情）。 */
	onLifecycleEvent?: (event: LifecycleEvent) => Promise<void>;
}

/** 桥关心的非消息事件（字段已规整，处理方不用再猜 SDK 结构）。 */
export type LifecycleEvent =
	| { type: "recalled"; messageId: string; chatId?: string }
	| { type: "bot_added"; chatId: string; chatName?: string; operatorOpenId?: string }
	| { type: "bot_removed"; chatId: string }
	| { type: "p2p_entered"; chatId: string; operatorOpenId?: string }
	| { type: "reaction"; action: "created" | "deleted"; messageId: string; emoji: string; operatorOpenId?: string; operatorType?: string }
	| { type: "doc_comment"; event: DocCommentEvent }
	| { type: "meeting_invite"; invite: MeetingInvite };

/** 把 SDK 事件 data 规整成 LifecycleEvent（字段缺失返回 undefined）。 */
export function parseLifecycleEvent(kind: string, data: unknown): LifecycleEvent | undefined {
	const d = (data ?? {}) as Record<string, unknown>;
	const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	const openId = (value: unknown) => str((value as { open_id?: unknown } | undefined)?.open_id);
	switch (kind) {
		case "recalled": {
			const messageId = str(d.message_id);
			return messageId ? { type: "recalled", messageId, ...(str(d.chat_id) ? { chatId: str(d.chat_id) } : {}) } : undefined;
		}
		case "bot_added":
		case "bot_removed":
		case "p2p_entered": {
			const chatId = str(d.chat_id);
			if (!chatId) return undefined;
			if (kind === "bot_removed") return { type: "bot_removed", chatId };
			const operatorOpenId = openId(d.operator_id);
			if (kind === "p2p_entered") return { type: "p2p_entered", chatId, ...(operatorOpenId ? { operatorOpenId } : {}) };
			return { type: "bot_added", chatId, ...(str(d.name) ? { chatName: str(d.name) } : {}), ...(operatorOpenId ? { operatorOpenId } : {}) };
		}
		case "reaction_created":
		case "reaction_deleted": {
			const messageId = str(d.message_id);
			const emoji = str((d.reaction_type as { emoji_type?: unknown } | undefined)?.emoji_type);
			if (!messageId || !emoji) return undefined;
			const operatorOpenId = openId(d.user_id);
			return {
				type: "reaction", action: kind === "reaction_created" ? "created" : "deleted", messageId, emoji,
				...(operatorOpenId ? { operatorOpenId } : {}),
				...(str(d.operator_type) ? { operatorType: str(d.operator_type) } : {}),
			};
		}
		case "doc_comment": {
			const event = parseDocCommentEvent(data);
			return event ? { type: "doc_comment", event } : undefined;
		}
		case "meeting_invite": {
			const invite = parseMeetingInvite(data);
			return invite ? { type: "meeting_invite", invite } : undefined;
		}
		default:
			return undefined;
	}
}

export interface CardAction {
	messageId: string;
	chatId?: string;
	operatorOpenId: string;
	/** 回调 token（每次点击唯一）：用于去重。 */
	token?: string;
	value?: Record<string, unknown>;
}

export interface BotProbeResult {
	openId?: string;
	name?: string;
	userId?: string;
}

export class FeishuTransport {
	private client: LarkSdkClient | undefined;
	private wsClient: LarkSdkWsClient | undefined;
	private wsReady = false;
	private running = false;
	private reconnectCount = 0;
	private botIdentity: BotIdentity = {};
	private probeCache: { at: number; identity: BotIdentity } | undefined;
	/** 最近一次 start() 的时间戳：上层 watchdog 据此宽限握手期，避免误判重连。 */
	private connectStartedAt = 0;
	private downSince: number | undefined;
	private generation = 0;
	/** 仅显式 start/stop 改变，用于使并发 reconnect 意图失效。 */
	private lifecycleIntent = 0;
	private startPromise: Promise<void> | undefined;
	private reconnectPromise: Promise<void> | undefined;
	private readonly now: () => number;
	/** 入站按 chat 串行（保序），不同 chat 并发；SDK 回调不等待。 */
	private readonly inboundTails = new Map<string, Promise<void>>();
	private inboundInFlight = 0;

	constructor(private deps: TransportDeps) {
		this.now = deps.now ?? Date.now;
	}

	getBotIdentity(): BotIdentity {
		return this.botIdentity;
	}

	getConnectStartedAt(): number {
		return this.connectStartedAt;
	}

	getDownSince(): number | undefined {
		return this.downSince;
	}

	isConnected(): boolean {
		const sdkState = this.sdkState();
		if (sdkState && sdkState !== "connected" && this.wsReady && this.running) this.markDisconnected(new Error(`ws state ${sdkState}`));
		return this.wsReady;
	}

	private sdkState(): string | undefined {
		const sdkStatus = this.wsClient?.getConnectionStatus?.();
		return typeof sdkStatus === "string" ? sdkStatus : sdkStatus?.state;
	}

	private get sdkAutoReconnect(): boolean {
		return this.deps.config.transport?.sdkAutoReconnect !== false;
	}

	/**
	 * SDK 正在自己重连：上层 supervisor 此时不应插手 —— 插手就是把 SDK 的重连循环打断重来。
	 * 只有 SDK 进入终态（failed/idle）或自愈超时，才由 supervisor 整体重建。
	 */
	isSelfHealing(): boolean {
		if (!this.sdkAutoReconnect || !this.running) return false;
		const state = this.sdkState();
		return state === "reconnecting" || state === "connecting";
	}

	/** 入站后台处理中的消息数（诊断/优雅关闭用）。 */
	inboundPending(): number {
		return this.inboundInFlight;
	}

	/** 等待入站后台处理排空（关闭时调用；有界由调用方控制）。 */
	async drainInbound(): Promise<void> {
		await Promise.allSettled([...this.inboundTails.values()]);
	}

	isRunning(): boolean {
		return this.running;
	}

	async start(): Promise<void> {
		if (this.running) return;
		if (this.startPromise) return this.startPromise;
		this.lifecycleIntent += 1;
		this.startPromise = this.doStart();
		try {
			await this.startPromise;
		} finally {
			this.startPromise = undefined;
		}
	}

	private async doStart(): Promise<void> {
		const { sdk, config } = this.deps;
		const generation = ++this.generation;
		this.running = true;
		this.connectStartedAt = this.now();
		const domain = config.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu;
		this.closeWs();
		this.client = new sdk.Client({ appId: config.appId, appSecret: config.appSecret, appType: 0, domain });

		// bot 身份水合（hermes 设计：不依赖 env/时序；失败不阻塞启动，降级为空）
		this.botIdentity = await this.hydrateBotIdentity();
		if (!this.running || generation !== this.generation) return;
		// 配置里写死的 open_id 与接口不一致 = 换过应用（open_id 按应用视角生成），以接口为准并告警
		if (this.botIdentity.openId && config.botOpenId && config.botOpenId !== this.botIdentity.openId) {
			this.deps.log?.("warn", "feishu.transport.bot_open_id_stale", {
				configured: config.botOpenId, actual: this.botIdentity.openId,
				hint: "config.botOpenId 已过期（换过应用？），以 /bot/v3/info 为准；请更新或删除该字段",
			});
		}
		if (!this.botIdentity.openId && config.botOpenId) this.botIdentity.openId = config.botOpenId;
		if (!this.botIdentity.name && config.botName) this.botIdentity.name = config.botName;
		this.deps.log?.("info", "feishu.transport.bot_identity", this.botIdentity);

		const dispatcher = new sdk.EventDispatcher({}).register({
			// 立即返回，后台按 chat 串行处理（SDK 等回调返回后才回 ACK，慢命令会拖到飞书重投）。
			"im.message.receive_v1": (data: unknown) => { this.dispatchInbound(data); },
			"card.action.trigger": async (data: unknown) => this.handleCardAction(data),
			"im.message.message_read_v1": async () => undefined,
			// 生命周期事件同样立即返回，后台处理（失败只记日志）
			"im.message.recalled_v1": (data: unknown) => { this.dispatchLifecycle("recalled", data); },
			"im.chat.member.bot.added_v1": (data: unknown) => { this.dispatchLifecycle("bot_added", data); },
			"im.chat.member.bot.removed_v1": (data: unknown) => { this.dispatchLifecycle("bot_removed", data); },
			"im.chat.access_event.bot_p2p_chat_entered_v1": (data: unknown) => { this.dispatchLifecycle("p2p_entered", data); },
			"im.message.reaction.created_v1": (data: unknown) => { this.dispatchLifecycle("reaction_created", data); },
			// 撤回自身表情也会收到 deleted 事件（处理方按 operator 过滤）
			"im.message.reaction.deleted_v1": (data: unknown) => { this.dispatchLifecycle("reaction_deleted", data); },
			// 云文档评论 @ 与会议邀请（功能开关在处理方判断；应用没订阅这两个事件时不会收到）
			"drive.notice.comment_add_v1": (data: unknown) => { this.dispatchLifecycle("doc_comment", data); },
			"vc.bot.meeting_invited_v1": (data: unknown) => { this.dispatchLifecycle("meeting_invite", data); },
		});

		const markReady = (event: string) => {
			if (!this.running || generation !== this.generation) return;
			this.wsReady = true;
			this.connectStartedAt = 0;
			this.downSince = undefined;
			this.deps.onStatus?.("connected", this.reconnectCount);
			this.deps.log?.("info", event);
		};
		this.wsClient = new sdk.WSClient({
			appId: config.appId,
			appSecret: config.appSecret,
			autoReconnect: this.sdkAutoReconnect,
			extraUaTags: ["channel"],
			onReady: () => markReady("feishu.transport.ws_ready"),
			onReconnected: () => markReady("feishu.transport.ws_reconnected"),
			onReconnecting: () => {
				if (!this.running || generation !== this.generation) return;
				this.reconnectCount += 1;
				this.wsReady = false;
				this.downSince ??= this.now();
				this.deps.onStatus?.("reconnecting", this.reconnectCount);
				this.deps.log?.("warn", "feishu.transport.ws_reconnecting", { sdkReconnects: this.reconnectCount });
			},
			onError: (err: unknown) => {
				if (generation === this.generation) this.markDisconnected(err);
			},
		});
		try {
			this.wsClient.start({ eventDispatcher: dispatcher });
		} catch (err) {
			this.markDisconnected(err);
			this.running = false;
			throw err;
		}
	}

	private markDisconnected(error: unknown): void {
		if (!this.running) return;
		this.wsReady = false;
		this.downSince ??= this.now();
		this.deps.onStatus?.("error", this.reconnectCount);
		this.deps.log?.("error", "feishu.transport.ws_error", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	async stop(): Promise<void> {
		this.lifecycleIntent += 1;
		this.stopTransport();
	}

	private stopTransport(): void {
		this.running = false;
		this.wsReady = false;
		this.connectStartedAt = 0;
		this.generation += 1;
		this.closeWs();
	}

	/**
	 * 关闭当前 WSClient。先发 CLOSE 帧（非 force）：terminate 不告知服务端，
	 * 服务端会继续往这个失效端点推消息直到 CLOSE-WAIT 超时（hermes #10202），这段时间频道静默。
	 * SDK 的 close() 先摘掉 socket 监听再关闭，所以关闭握手不会触发 SDK 自己的重连。
	 */
	private closeWs(): void {
		const ws = this.wsClient;
		this.wsClient = undefined;
		if (!ws) return;
		try {
			ws.close();
		} catch {
			try { ws.close({ force: true }); } catch { /* ignore */ }
		}
	}

	/**
	 * 拉取被回复消息原文（回复链路可见性的关键）。失败返回 undefined。
	 * 任意消息类型都走 normalize（post/合并转发/分享群名片/卡片都转成可读文本），
	 * 不再把 post 的原始 JSON 塞进提示词。
	 */
	async getMessageText(messageId: string): Promise<string | undefined> {
		try {
			const res = (await this.authedRequest({ url: `/open-apis/im/v1/messages/${messageId}`, method: "GET" })) as Record<string, unknown>;
			const data = (res?.data ?? res) as Record<string, unknown>;
			const items = Array.isArray(data?.items) ? (data.items as Array<Record<string, unknown>>) : undefined;
			const msg = (items?.[0] ?? data?.message ?? data) as Record<string, unknown> | undefined;
			if (!msg) return undefined;
			// 实测（2026-09-02）：content 在 body.content（嵌套 JSON），顶层 content 缺失
			const body = (msg.body ?? {}) as Record<string, unknown>;
			const content = typeof msg.content === "string" ? msg.content : typeof body.content === "string" ? body.content : undefined;
			if (!content) return undefined;
			const messageType = typeof msg.msg_type === "string" ? msg.msg_type : typeof msg.message_type === "string" ? msg.message_type : "text";
			// 卡片消息：正文在卡片里，从 API 拿不到（只拿到 card_id 引用）。
			// 返回 undefined 让上层给一句短提示，而不是把卡片 JSON 整块喂进提示词。
			try {
				const parsed = JSON.parse(content) as Record<string, unknown>;
				if (parsed.type === "card") return undefined;
			} catch { /* 非 JSON 内容交给 normalize */ }
			const normalized = normalizeFeishuMessage({
				messageId,
				chatId: typeof msg.chat_id === "string" ? msg.chat_id : "",
				chatType: "group",
				messageType,
				content,
				sender: { sender_id: {}, sender_type: undefined },
				mentions: Array.isArray(msg.mentions) ? msg.mentions : undefined,
				bot: this.botIdentity,
			});
			const text = normalized.text.trim();
			return text || undefined;
		} catch (err) {
			this.deps.log?.("warn", "feishu.transport.quote_fetch_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	}

	/** 整体重建：SDK 自愈失败（终态）后由 supervisor 调用（指数退避在 supervisor）。 */
	async reconnect(): Promise<void> {
		if (this.reconnectPromise) return this.reconnectPromise;
		this.reconnectPromise = (async () => {
			const lifecycleIntent = this.lifecycleIntent;
			this.reconnectCount += 1;
			this.stopTransport();
			// 给并发的显式 stop 一个失效本次重连意图的机会。
			await Promise.resolve();
			if (this.lifecycleIntent !== lifecycleIntent) return;
			await this.start();
		})();
		try {
			await this.reconnectPromise;
		} finally {
			this.reconnectPromise = undefined;
		}
	}

	/** 获取单个 chat 的有界历史消息，供短时断线补收。 */
	async listChatHistory(chatId: string, startTimeMs: number, endTimeMs: number, limit = 50): Promise<FeishuInboundMessage[]> {
		const res = (await this.authedRequest({
			url: "/open-apis/im/v1/messages",
			method: "GET",
			params: {
				// 枚举值是 "chat" / "thread"；写成 "chat_id" 会被接口以 400 拒绝（补收因此从未成功过）。
				container_id_type: "chat",
				container_id: chatId,
				start_time: String(Math.floor(startTimeMs / 1000)),
				end_time: String(Math.ceil(endTimeMs / 1000)),
				sort_type: "ByCreateTimeAsc",
				page_size: Math.max(1, Math.min(50, limit)),
			},
		})) as Record<string, unknown>;
		const data = (res.data ?? res) as Record<string, unknown>;
		const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
		const output: FeishuInboundMessage[] = [];
		for (const item of items.slice(0, limit)) {
			const body = (item.body ?? {}) as Record<string, unknown>;
			const sender = (item.sender ?? {}) as Record<string, unknown>;
			const rawSenderId = sender.id ?? sender.sender_id ?? {};
			const idType = typeof sender.id_type === "string" ? sender.id_type : "open_id";
			const senderId = typeof rawSenderId === "string" ? { [idType]: rawSenderId } : rawSenderId as Record<string, unknown>;
			const normalized = await this.normalizeInbound({
				messageId: typeof item.message_id === "string" ? item.message_id : "",
				chatId: typeof item.chat_id === "string" ? item.chat_id : chatId,
				chatType: typeof item.chat_type === "string" ? item.chat_type : "group",
				messageType: typeof item.msg_type === "string" ? item.msg_type : typeof item.message_type === "string" ? item.message_type : "text",
				content: typeof body.content === "string" ? body.content : typeof item.content === "string" ? item.content : "",
				sender: { sender_id: senderId, sender_type: sender.sender_type },
				mentions: Array.isArray(item.mentions) ? item.mentions : undefined,
				parentId: typeof item.parent_id === "string" ? item.parent_id : undefined,
				rootId: typeof item.root_id === "string" ? item.root_id : undefined,
				threadId: typeof item.thread_id === "string" ? item.thread_id : undefined,
				bot: this.botIdentity,
			});
			if (normalized) output.push(normalized);
		}
		return output;
	}

	async downloadResource(ref: ResourceRef, maxBytes: number): Promise<{ buffer: Buffer; mimeType?: string }> {
		const messageResource = this.client?.im?.v1?.messageResource;
		if (!messageResource) throw new Error("messageResource.get unavailable");
		const response = await messageResource.get({
			params: { type: ref.kind === "image" ? "image" : "file" },
			path: { message_id: ref.messageId, file_key: ref.key },
		});
		const headers = response.headers ?? {};
		const declared = Number(headers["content-length"] ?? headers["Content-Length"] ?? 0);
		if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`resource too large: ${declared} > ${maxBytes}`);
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of response.getReadableStream()) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
			total += buffer.length;
			if (total > maxBytes) throw new Error(`resource too large: ${total} > ${maxBytes}`);
			chunks.push(buffer);
		}
		const contentType = headers["content-type"] ?? headers["Content-Type"];
		return { buffer: Buffer.concat(chunks), mimeType: typeof contentType === "string" ? contentType.split(";")[0]?.trim() : undefined };
	}

	async uploadImage(image: Buffer): Promise<string> {
		const api = this.client?.im?.v1?.image;
		if (!api) throw new Error("image.create unavailable");
		const response = await api.create({ data: { image_type: "message", image } }) as { image_key?: string; data?: { image_key?: string } };
		const key = response.data?.image_key ?? response.image_key;
		if (!key) throw new Error("upload image failed: no image_key");
		return key;
	}

	async uploadFile(fileName: string, file: Buffer, fileType: "stream" | "mp4" | "opus" = "stream"): Promise<string> {
		const api = this.client?.im?.v1?.file;
		if (!api) throw new Error("file.create unavailable");
		// opus 带上时长（毫秒），否则客户端语音条显示 0 秒
		const duration = fileType === "opus" ? oggOpusDurationMs(file) : undefined;
		const response = await api.create({ data: { file_type: fileType, file_name: fileName, file, ...(duration ? { duration } : {}) } }) as { file_key?: string; data?: { file_key?: string } };
		const key = response.data?.file_key ?? response.file_key;
		if (!key) throw new Error("upload file failed: no file_key");
		return key;
	}

	private dispatchLifecycle(kind: string, data: unknown): void {
		const handler = this.deps.onLifecycleEvent;
		if (!handler) return;
		const event = parseLifecycleEvent(kind, data);
		if (!event) {
			this.deps.log?.("debug", "feishu.transport.lifecycle_unparsable", { kind });
			return;
		}
		void handler(event).catch((error: unknown) => {
			this.deps.log?.("warn", "feishu.transport.lifecycle_failed", { kind, error: error instanceof Error ? error.message : String(error) });
		});
	}

	/**
	 * 私聊某个用户（receive_id_type=open_id）。私聊还没建立时飞书会自动建。
	 * 返回 message_id；业务码非 0 抛出。
	 */
	async sendToUser(openId: string, msgType: "text" | "interactive" | "file", content: unknown): Promise<string> {
		return (await this.sendToUserDetailed(openId, msgType, content)).messageId;
	}

	/** 同 sendToUser，额外返回私聊的 chat_id（之后在这个私聊里开任务、回复）。 */
	async sendToUserDetailed(openId: string, msgType: "text" | "interactive" | "file", content: unknown): Promise<{ messageId: string; chatId?: string }> {
		const response = await this.rawRequest({
			url: "/open-apis/im/v1/messages", method: "POST",
			params: { receive_id_type: "open_id" },
			data: { receive_id: openId, msg_type: msgType, content: JSON.stringify(content) },
		});
		assertApiOk(response, "send to user");
		const data = (response as { data?: { message_id?: string; chat_id?: string } }).data;
		const messageId = data?.message_id;
		if (!messageId) throw new Error("send to user returned no message_id");
		return { messageId, ...(data?.chat_id ? { chatId: data.chat_id } : {}) };
	}

	/** 群名（放行卡上要让管理员认得出是哪个群）；失败返回 undefined。 */
	async getChatName(chatId: string): Promise<string | undefined> {
		try {
			const response = await this.rawRequest({ url: `/open-apis/im/v1/chats/${chatId}`, method: "GET" }) as { code?: number; data?: { name?: string } };
			return response?.code === 0 || response?.code === undefined ? response?.data?.name : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 开通申请：群成员 open_id（只含真人，不含机器人）。拿不到（缺 im:chat.members:read 权限等）返回 undefined，
	 * 调用方按"管理员不在群里"处理 —— 转为私聊审批，不会因此失败。最多翻 10 页（1000 人）。
	 */
	async listChatMemberIds(chatId: string): Promise<Set<string> | undefined> {
		const ids = new Set<string>();
		let pageToken: string | undefined;
		try {
			for (let page = 0; page < 10; page++) {
				const response = await this.rawRequest({
					url: `/open-apis/im/v1/chats/${chatId}/members`, method: "GET",
					params: { member_id_type: "open_id", page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
				}) as { code?: number; msg?: string; data?: { items?: Array<{ member_id?: string }>; has_more?: boolean; page_token?: string } };
				if (response?.code !== undefined && response.code !== 0) {
					this.deps.log?.("warn", "feishu.transport.chat_members_failed", { chatId, code: response.code, msg: response.msg, hint: "需要应用具备「获取群成员」权限（im:chat.members:read）；缺失时开通申请改为私聊归属人" });
					return undefined;
				}
				for (const item of response?.data?.items ?? []) if (item.member_id) ids.add(item.member_id);
				if (!response?.data?.has_more || !response.data.page_token) break;
				pageToken = response.data.page_token;
			}
			return ids;
		} catch (error) {
			this.deps.log?.("warn", "feishu.transport.chat_members_failed", { chatId, error: error instanceof Error ? error.message : String(error) });
			return undefined;
		}
	}

	/**
	 * 发交互卡片（审批卡、状态卡等）。业务码非 0 视为失败（抛出）；
	 * 被回复消息已撤回/不存在时回退为直接发送 —— 否则审批卡根本没发出去，工具只能干等到超时。
	 */
	async sendCard(chatId: string, card: unknown, opts: { replyTo?: string; threadId?: string } = {}): Promise<string | undefined> {
		const content = JSON.stringify(card);
		const create = () => this.rawRequest({
			url: "/open-apis/im/v1/messages", method: "POST",
			params: opts.threadId ? { receive_id_type: "thread_id" } : { receive_id_type: "chat_id" },
			data: { receive_id: opts.threadId ?? chatId, msg_type: "interactive", content },
		});
		let response: unknown;
		if (opts.replyTo) {
			try {
				response = await this.rawRequest({
					url: `/open-apis/im/v1/messages/${opts.replyTo}/reply`, method: "POST",
					data: { msg_type: "interactive", content, reply_in_thread: Boolean(opts.threadId) },
				});
				if (isReplyFallbackCode((response as { code?: number } | undefined)?.code)) response = await create();
			} catch (error) {
				if (!isReplyFallbackCode(apiErrorCode(error))) throw error;
				response = await create();
			}
		} else {
			response = await create();
		}
		assertApiOk(response, "send card");
		const messageId = (response as { data?: { message_id?: string } }).data?.message_id;
		if (!messageId) throw new Error("send card returned no message_id");
		return messageId;
	}

	private async handleCardAction(data: unknown): Promise<unknown> {
		const outer = data as Record<string, unknown>;
		const context = (outer.context ?? outer) as Record<string, unknown>;
		const operator = (outer.operator ?? {}) as Record<string, unknown>;
		const action = (outer.action ?? {}) as Record<string, unknown>;
		const messageId = context.open_message_id ?? context.message_id ?? outer.open_message_id;
		const operatorOpenId = operator.open_id;
		// 解析失败时**必须留痕**：静默 return 会让"按钮点了没反应"完全无法排障
		// （分不清是飞书没推、还是字段名对不上）。只记结构不记内容。
		if (typeof messageId !== "string" || typeof operatorOpenId !== "string") {
			this.deps.log?.("warn", "feishu.transport.card_action_unparsable", {
				topKeys: Object.keys(outer).slice(0, 10),
				contextKeys: Object.keys(context).slice(0, 10),
				operatorKeys: Object.keys(operator).slice(0, 6),
				hasMessageId: typeof messageId === "string",
				hasOperator: typeof operatorOpenId === "string",
			});
			return undefined;
		}
		this.deps.log?.("debug", "feishu.transport.card_action", {
			messageId,
			hasValue: action.value !== undefined, op: (action.value as Record<string, unknown> | undefined)?.op,
		});
		const rawChatId = context.open_chat_id ?? context.chat_id ?? outer.open_chat_id;
		if (!this.deps.onCardAction) return undefined;
		const token = typeof outer.token === "string" ? outer.token : typeof context.token === "string" ? context.token : undefined;
		const work = this.deps.onCardAction({
			messageId,
			chatId: typeof rawChatId === "string" ? rawChatId : undefined,
			operatorOpenId,
			token,
			value: action.value && typeof action.value === "object" ? action.value as Record<string, unknown> : undefined,
		});
		// 飞书卡片回调 3s 内必须应答，否则用户看到"操作失败"而状态其实已经改了。
		// 超出预算先回 toast，算完后用 PATCH 把结果卡刷上去（同步回卡是首选，异步刷卡兜底）。
		const budget = this.deps.cardActionBudgetMs ?? 2_500;
		const timedOut = Symbol("timeout");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			work,
			new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), budget); timer.unref?.(); }),
		]).finally(() => { if (timer) clearTimeout(timer); });
		if (result !== timedOut) return result;
		this.deps.log?.("warn", "feishu.transport.card_action_slow", { messageId, budgetMs: budget });
		void work.then((late) => {
			const card = (late as { card?: { type?: string; data?: unknown } } | undefined)?.card;
			if (card?.type === "raw" && card.data) void this.updateCard(messageId, card.data);
		}, (error: unknown) => {
			this.deps.log?.("warn", "feishu.transport.card_action_failed", { messageId, error: error instanceof Error ? error.message : String(error) });
		});
		return { toast: { type: "info", content: "处理中…" } };
	}

	// ------------------------------------------------------------ REST ----

	private userNames = new Map<string, { name?: string; at: number }>();

	/**
	 * open_id → 姓名（contact/v3，缓存 10 分钟，失败也缓存避免反复打接口）。
	 * 应用没有通讯录权限时返回 undefined，由上层退化为 open_id 尾号。
	 */
	async resolveUserName(openId: string): Promise<string | undefined> {
		if (!openId) return undefined;
		const cached = this.userNames.get(openId);
		if (cached && this.now() - cached.at < 10 * 60_000) return cached.name;
		let name: string | undefined;
		try {
			const res = await this.authedRequest({
				url: `/open-apis/contact/v3/users/${openId}`, method: "GET", params: { user_id_type: "open_id" },
			}) as { code?: number; data?: { user?: { name?: string; nickname?: string } } };
			if (!res?.code) name = res?.data?.user?.name || res?.data?.user?.nickname || undefined;
		} catch (error) {
			this.deps.log?.("debug", "feishu.transport.user_name_failed", { error: error instanceof Error ? error.message : String(error) });
		}
		this.userNames.set(openId, { name, at: this.now() });
		if (this.userNames.size > 1_000) this.userNames.delete(this.userNames.keys().next().value!);
		return name;
	}

	/** 带 tenant token 的 REST 请求（lark SDK client.request 自动附 token）。 */
	async authedRequest(opts: { url: string; method: string; params?: unknown; data?: unknown }): Promise<unknown> {
		if (!this.client) throw new Error("transport not started");
		return this.client.request({ ...opts, method: opts.method });
	}

	/** 添加表情回应（hermes 式"处理中"指示）：POST reactions。返回 reaction_id。 */
	async addReaction(messageId: string, emoji: string): Promise<string | undefined> {
		try {
			const res = (await this.authedRequest({
				url: `/open-apis/im/v1/messages/${messageId}/reactions`,
				method: "POST",
				data: { reaction_type: { emoji_type: emoji } },
			})) as Record<string, unknown>;
			const data = (res?.data ?? res) as Record<string, unknown>;
			const reactionId = typeof data?.reaction_id === "string" ? data.reaction_id : undefined;
			return reactionId;
		} catch (err) {
			this.deps.log?.("debug", "feishu.transport.reaction_add_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	}

	/** 移除表情回应（处理完成）。 */
	async removeReaction(messageId: string, reactionId: string): Promise<boolean> {
		try {
			await this.authedRequest({
				url: `/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
				method: "DELETE",
			});
			return true;
		} catch (err) {
			this.deps.log?.("debug", "feishu.transport.reaction_remove_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/** REST 出站原语（sender 复用同一 client）。与 authedRequest 同一实现（SDK client 自动附 token）。 */
	async rawRequest(opts: { url: string; method: string; params?: unknown; data?: unknown }): Promise<unknown> {
		return this.authedRequest(opts);
	}

	/** 进度消息：编辑已发消息内容（飞书 im.v1.message.update 是 PUT——PATCH 会 400）。 */
	/**
	 * 更新已发出的交互卡片（把按钮置灰、换成终态）。
	 * 注意与文本区分：文本用 PUT，**卡片用 PATCH**（飞书 im.v1.message.patch）。
	 */
	async updateCard(messageId: string, card: unknown): Promise<boolean> {
		try {
			// 没有 client 时 `?.request` 得到 undefined，旧代码把它当成功
			if (!this.client) throw new Error("transport not started");
			const response = (await this.client.request({
				url: `/open-apis/im/v1/messages/${messageId}`,
				method: "PATCH",
				data: { content: JSON.stringify(card) },
			})) as { code?: number; msg?: string } | undefined;
			if (response && typeof response.code === "number" && response.code !== 0) {
				this.deps.log?.("warn", "feishu.transport.card_update_rejected", {
					messageId, code: response.code, msg: response.msg,
				});
				return false;
			}
			return true;
		} catch (err) {
			this.deps.log?.("warn", "feishu.transport.card_update_failed", {
				messageId, error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	async editMessage(messageId: string, text: string): Promise<boolean> {
		try {
			if (!this.client) throw new Error("transport not started");
			const response = (await this.client.request({
				url: `/open-apis/im/v1/messages/${messageId}`,
				method: "PUT",
				data: { content: JSON.stringify({ text }), msg_type: "text" },
			})) as { code?: number; msg?: string } | undefined;
			// Promise resolve 不等于业务成功——非 0 业务码必须按失败处理，
			// 否则串行写入器会把“未生效的编辑”当成成功，final 交接判断随之错误。
			if (response && typeof response.code === "number" && response.code !== 0) {
				this.deps.log?.("warn", "feishu.transport.edit_rejected", {
					messageId,
					code: response.code,
					msg: response.msg,
				});
				return false;
			}
			return true;
		} catch (err) {
			this.deps.log?.("warn", "feishu.transport.edit_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/** 进度消息：撤回消息（im.v1.message.recall）。 */
	async recallMessage(messageId: string): Promise<boolean> {
		try {
			if (!this.client) throw new Error("transport not started");
			assertApiOk(await this.client.request({
				url: `/open-apis/im/v1/messages/${messageId}`,
				method: "DELETE",
			}), "recall");
			return true;
		} catch (err) {
			this.deps.log?.("warn", "feishu.transport.recall_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/** bot 身份水合：/open-apis/bot/v3/info（带 TTL 缓存，避免高频重启打爆接口）。 */
	async hydrateBotIdentity(): Promise<BotIdentity> {
		const ttl = this.deps.probeTtlMs ?? 60_000;
		if (this.probeCache && this.now() - this.probeCache.at < ttl) return this.probeCache.identity;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const res = (await this.authedRequest({ url: "/open-apis/bot/v3/info", method: "GET" })) as Record<string, unknown>;
				const data = (res?.bot ?? res?.data ?? res) as Record<string, unknown>;
				const identity: BotIdentity = {
					openId: typeof data.open_id === "string" ? data.open_id : undefined,
					name:
						typeof data.bot_name === "string"
							? data.bot_name
							: typeof data.app_name === "string"
								? data.app_name
								: typeof data.name === "string"
									? data.name
									: undefined,
					userId: typeof data.user_id === "string" ? data.user_id : undefined,
				};
				if (identity.openId || identity.name) {
					this.probeCache = { at: this.now(), identity };
					return identity;
				}
			} catch (err) {
				this.deps.log?.("error", "feishu.transport.bot_probe_failed", {
					error: err instanceof Error ? err.message : String(err),
					attempt,
				});
				if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
			}
		}
		return {};
	}

	// ------------------------------------------------------------ 入站 ----

	private dispatchInbound(raw: unknown): void {
		const root = (raw ?? {}) as Record<string, unknown>;
		const body = (root.event ?? root) as Record<string, unknown>;
		const msg = (body.message ?? body) as Record<string, unknown>;
		const key = typeof msg.chat_id === "string" ? msg.chat_id : "";
		this.inboundInFlight += 1;
		const previous = this.inboundTails.get(key) ?? Promise.resolve();
		const next = previous.then(() => this.handleRawMessage(raw)).catch((error: unknown) => {
			this.deps.log?.("error", "feishu.transport.inbound_failed", { error: error instanceof Error ? error.message : String(error) });
		}).finally(() => {
			this.inboundInFlight -= 1;
			if (this.inboundTails.get(key) === next) this.inboundTails.delete(key);
		});
		this.inboundTails.set(key, next);
	}

	/**
	 * 事件解包：SDK 可能传 { event: {...} }，也可能直接传事件体。
	 * 消息字段在 event.message 子对象、sender 在 event 顶层。
	 */
	private async handleRawMessage(raw: unknown): Promise<void> {
		const root = (raw ?? {}) as Record<string, unknown>;
		const body = (root.event ?? root) as Record<string, unknown>;
		const msg = (body.message ?? body) as Record<string, unknown>;
		const messageId = typeof msg.message_id === "string" ? msg.message_id : undefined;
		if (!messageId) {
			this.deps.log?.("debug", "feishu.transport.drop_malformed", {
				rawType: Array.isArray(raw) ? "array" : typeof raw,
				keys: raw && typeof raw === "object" ? Object.keys(raw as Record<string, unknown>).slice(0, 12) : [],
			});
			return;
		}
		const sender = (body.sender ?? msg.sender ?? {}) as Record<string, unknown>;
		const senderIdObj = (sender.sender_id ?? {}) as Record<string, unknown>;

		// 组装 normalize 输入（保持与 normalize.ts 的纯函数约定）
		const normalized = await this.normalizeInbound({
			messageId,
			chatId: (msg.chat_id as string) ?? "",
			chatType: (msg.chat_type as string) ?? "p2p",
			messageType: (msg.message_type as string) ?? "text",
			content: (msg.content as string) ?? "",
			sender: { sender_id: senderIdObj, sender_type: sender.sender_type },
			mentions: Array.isArray(msg.mentions) ? (msg.mentions as unknown[]) : undefined,
			parentId: typeof msg.parent_id === "string" ? msg.parent_id : undefined,
			upperMessageId: typeof msg.upper_message_id === "string" ? msg.upper_message_id : undefined,
			rootId: typeof msg.root_id === "string" ? msg.root_id : undefined,
			threadId: typeof msg.thread_id === "string" ? msg.thread_id : undefined,
			bot: this.botIdentity,
		});

		if (!normalized) return;
		// 自身回声防御
		if (normalized.isBot && normalized.senderId === this.botIdentity.openId) {
			this.deps.log?.("debug", "feishu.transport.drop_self_echo", { messageId });
			return;
		}
		await this.deps.onMessage(normalized);
	}

	/** 规范化（委托给 normalize.ts 纯函数；供测试与 transport 共用）。 */
	async normalizeInbound(input: Parameters<typeof normalizeFeishuMessage>[0]): Promise<FeishuInboundMessage | undefined> {
		const out = normalizeFeishuMessage(input);
		if (!out.messageId) return undefined;
		return out;
	}
}

/**
 * Ogg Opus 时长（毫秒）= 最后一页的 granule position / 48kHz（Opus 在 Ogg 里固定 48k 时钟）。
 * 解析失败返回 undefined（不带 duration 上传，不影响发送）。
 */
export function oggOpusDurationMs(buffer: Buffer): number | undefined {
	try {
		const last = buffer.lastIndexOf("OggS");
		if (last < 0 || last + 14 > buffer.length) return undefined;
		const granule = buffer.readBigInt64LE(last + 6);
		if (granule <= 0n) return undefined;
		const ms = Number((granule * 1000n) / 48000n);
		return Number.isFinite(ms) && ms > 0 ? ms : undefined;
	} catch {
		return undefined;
	}
}
