/**
 * 桥侧 hook 的内联扩展工厂。
 *
 * 背景：`PiSessionBackend.createSession()` 通过 `createAgentSession` 独立创建子会话，
 * 每个子会话会新建自己的 ExtensionRunner —— outer session 上注册的 `tool_call`
 * 与工具**不会**自动转发进来；而让完整桥扩展在子会话里重载又会重复启动飞书 WS、
 * 创建一组空状态并争抢 app 锁。
 *
 * 因此这里只注入「无网关生命周期」的桥侧能力，并共享 outer 的桥状态：
 *   1. `tool_call` → outer PermissionBridge.gate（危险工具审批，含 deny/超时阻断）
 *   2. `feishu_send_local_file` → outer conversation/outbox
 * 子会话的扩展发现结果另由 `stripGatewayExtensions()` 剔除网关扩展自身。
 */
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionRuntimeContext, ExtensionToolResult } from "../pi-types.js";

export interface BridgeRoute {
	conversationKey: string;
	chatId: string;
	threadId?: string;
	sourceMessageId?: string;
	/** 发起人 open_id（审批免审判定用；从会话活跃消息带下来，不解析 conversationKey）。 */
	senderId?: string;
	runId?: string;
	/** 会话类型（agent 卡片按钮回调要据此重建会话 key）。 */
	chatType?: "p2p" | "group" | "topic";
}

export interface BridgeGateInput {
	conversationKey: string;
	sessionId: string;
	runId: string;
	toolCallId: string;
	toolName: string;
	paramsText: string;
	/** bash 工具的原始命令（未打码、未截断），只用于命令分级，不展示也不落盘。 */
	command?: string;
	/** 需要审批的理由（命令级策略判定结果，用于审批卡展示）。 */
	reason?: string;
	chatId: string;
	threadId?: string;
	sourceMessageId?: string;
	/**
	 * 发起人 open_id（审批免审判定用）。
	 * 由会话的活跃消息带下来，**不要**从 conversationKey 解析 ——
	 * 后者只在「群聊+按人隔离」形态下含用户 ID，话题（`oc:t:th`）与私聊（裸 `oc`）都取不到。
	 */
	senderId?: string;
	allowedOperatorIds: string[];
}

export interface BridgeHookContext {
	/** 子会话工具调用准入；返回 { block, reason } 表示阻断执行。 */
	gateToolCall(input: BridgeGateInput): Promise<{ block?: boolean; reason?: string } | undefined>;
	/** 工具边界标记（pending ledger 的 replayPolicy=manual）。 */
	markToolBoundary(sessionId: string): void;
	/** sessionId → 飞书路由。 */
	routeForSessionId(sessionId: string): BridgeRoute | undefined;
	/** 把工作区文件送到当前飞书会话。 */
	sendLocalFile(input: {
		toolCallId: string;
		path: string;
		caption?: string;
		cwd: string;
		route: BridgeRoute | undefined;
	}): Promise<ExtensionToolResult>;
	/** 审批允许的操作者（管理员集合快照）。 */
	allowedOperatorIds(): string[];
	/** 是否给子会话注册 feishu_card（会话创建时判定）。 */
	cardTool?(): boolean;
	/** 发 agent 自定义卡片（只发到当前活动会话）。 */
	sendCard?(input: { toolCallId: string; params: Record<string, unknown>; route: BridgeRoute | undefined }): Promise<ExtensionToolResult>;
	/** 是否给子会话注册 feishu_doc_read（会话创建时判定）。 */
	docTool?(): boolean;
	/** 读取云文档纯文本。 */
	readDoc?(ref: string): Promise<ExtensionToolResult>;
	/** 工具参数脱敏后的摘要。 */
	/** 工具参数脱敏摘要。toolName 用于选择展示形态（bash 显示命令原文而非 JSON）。 */
	redactParams(input: Record<string, unknown> | undefined, toolName?: string): string;
	/**
	 * 在当前活动会话内提出澄清问题并等待选择。
	 * 返回选中项（answered）、超时（timeout）、取消（cancelled）或无法提问（unavailable）。
	 * 注意：选择只是回答内容，**不会**授予任何工具权限。
	 */
	askChoice?(input: {
		toolCallId: string;
		question: string;
		options: string[];
		route: { conversationKey: string; chatId: string; threadId?: string; sourceMessageId?: string; runId?: string };
	}): Promise<
		| { status: "answered"; choice: string }
		| { status: "timeout" }
		| { status: "cancelled"; reason: string }
		| { status: "unavailable"; detail: string }
	>;

	/**
	 * 在当前活动会话内发送文本通知（不接收任意 chat_id）。
	 * 返回投递状态：queued = 已可靠排队；delivered = 已投递；rejected = 被拒（无活动路由等）。
	 */
	notifyText?(input: {
		toolCallId: string;
		text: string;
		route?: { conversationKey: string; chatId: string; threadId?: string; sourceMessageId?: string; runId?: string };
	}): Promise<{ status: "queued" | "delivered" | "rejected"; detail?: string }>;
	/**
	 * 上下文压缩开始/结束的提示。
	 * 长会话触发压缩时 Pi 会静默暂停一段时间，用户侧只看到"莫名卡住"，
	 * 需要显式告知；压缩失败同样要说明，否则失败后继续跑会让人摸不着头脑。
	 */
	notifyCompaction?(input: {
		sessionId: string;
		phase: "start" | "end" | "failed";
		detail?: string;
	}): void;
	/**
	 * Pi 确认本次运行彻底结束（不会再有 auto-retry / auto-compact / follow-up）。
	 * 官方文档：agent_end 之后 Pi 仍可能继续，只有 agent_settled 是最终信号。
	 * 用于把「本轮结束」认定得比 turn_end/agent_end 更准确。
	 */
	markSettled?(sessionId: string): void;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

/** pi 的 InlineExtension 工厂签名（DefaultResourceLoader.extensionFactories 元素）。 */
export type InlineBridgeExtension = (pi: ExtensionAPI) => void;

/**
 * 构造注入到每个子会话的内联桥扩展。
 * 注意：工厂会被每个子会话调用一次，因此实现必须是纯注册、无副作用、无长驻资源。
 */
export function createBridgeInlineExtension(ctx: BridgeHookContext): InlineBridgeExtension {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "feishu_send_local_file",
			label: "发送文件到飞书",
			description: "将当前工作区内的本地图片或文件发送到触发本轮的飞书会话",
			promptSnippet: "生成用户需要的文件后，使用 feishu_send_local_file 发送；path 可为当前工作区内的相对或绝对路径。",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "当前工作区内的文件路径" },
					caption: { type: "string", description: "可选的文件说明" },
				},
				required: ["path"],
			},
			execute: async (toolCallId, params, _signal, _onUpdate, runtimeCtx: ExtensionRuntimeContext) => {
				const sessionId = runtimeCtx.sessionManager.getSessionId();
				return ctx.sendLocalFile({
					toolCallId,
					path: String(params.path ?? ""),
					caption: typeof params.caption === "string" ? params.caption : undefined,
					cwd: runtimeCtx.cwd,
					route: ctx.routeForSessionId(sessionId),
				});
			},
		});

		// agent 自定义卡片（按钮点击以「[卡片点击] 按钮名」回到会话）
		if (ctx.cardTool?.() && ctx.sendCard) {
			const sendCard = ctx.sendCard;
			pi.registerTool({
				name: "feishu_card",
				label: "发送飞书卡片",
				description: "向触发本轮的飞书会话发送一张带按钮的卡片（让用户在几个选项里点选）。用户点击后，你会收到一条「[卡片点击] 按钮名」的新消息。",
				promptSnippet: "需要用户在几个明确选项中选择、且不必等待结果时，可以用 feishu_card 发一张带按钮的卡片。",
				parameters: {
					type: "object",
					properties: {
						title: { type: "string", description: "卡片标题（可选）" },
						content: { type: "string", description: "卡片正文（markdown）" },
						buttons: { type: "array", items: { type: "string" }, description: "按钮文字（1–6 个，每个不超过 20 字）" },
					},
					required: ["content", "buttons"],
				},
				execute: async (toolCallId, params, _signal, _onUpdate, runtimeCtx: ExtensionRuntimeContext) =>
					sendCard({ toolCallId, params, route: ctx.routeForSessionId(runtimeCtx.sessionManager.getSessionId()) }),
			});
		}

		// 读取云文档（docx）纯文本
		if (ctx.docTool?.() && ctx.readDoc) {
			const readDoc = ctx.readDoc;
			pi.registerTool({
				name: "feishu_doc_read",
				label: "读取飞书文档",
				description: "读取飞书云文档（docx，含知识库里的 docx）的纯文本内容。参数可以是文档链接或文档 token。",
				promptSnippet: "用户给了飞书文档链接、或需要评论所在文档的全文时，用 feishu_doc_read 读取。",
				parameters: {
					type: "object",
					properties: { doc: { type: "string", description: "文档链接（…/docx/xxx 或 …/wiki/xxx）或文档 token" } },
					required: ["doc"],
				},
				execute: async (_toolCallId, params) => readDoc(String((params as { doc?: unknown }).doc ?? "")),
			});
		}

		// 当前会话内的主动文本通知（不接受任意目标；无活动路由时拒绝）
		pi.registerTool({
			name: "feishu_notify",
			label: "发送进度通知到飞书",
			description: "在当前触发本轮的飞书会话内发送一条纯文本进度通知（长任务中途汇报）",
			promptSnippet: "需要在中途告知用户进展时，用 feishu_notify 发送一条简短文本；不要用它发送最终答复。",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "要发送的通知文本（简短，<=2000 字）" },
				},
				required: ["text"],
			},
			execute: async (toolCallId, params, _signal, _onUpdate, runtimeCtx: ExtensionRuntimeContext) => {
				if (!ctx.notifyText) {
					return { content: [{ type: "text", text: "当前桥版本不支持主动通知" }], isError: true } as ExtensionToolResult;
				}
				const raw = typeof params.text === "string" ? params.text.trim() : "";
				if (!raw) {
					return { content: [{ type: "text", text: "通知内容不能为空" }], isError: true } as ExtensionToolResult;
				}
				const sessionId = runtimeCtx.sessionManager.getSessionId();
				const route = ctx.routeForSessionId(sessionId);
				if (!route) {
					return {
						content: [{ type: "text", text: "当前没有活动的飞书会话，通知未发送（不会转发到其他会话）" }],
						isError: true,
					} as ExtensionToolResult;
				}
				const result = await ctx.notifyText({
					toolCallId,
					text: raw.slice(0, 2_000),
					route,
				});
				const feedback = result.status === "queued"
					? "通知已可靠排队（将由 outbox 保证投递）"
					: result.status === "delivered"
						? "通知已投递"
						: `通知未发送：${result.detail ?? "被拒绝"}`;
				return {
					content: [{ type: "text", text: feedback }],
					...(result.status === "rejected" ? { isError: true } : {}),
				} as ExtensionToolResult;
			},
		});

		// 澄清提问（选项卡片；无卡权限时自动退化为文本选项）
		pi.registerTool({
			name: "feishu_ask",
			label: "向用户提出选择题",
			description: "在飞书会话中提出 2-4 个选项的澄清问题，等待用户点击或回复后继续；不授予任何工具权限",
			promptSnippet: "需要用户在几个方案中选择时，用 feishu_ask 提问，并把返回的选择作为后续依据；不要用它请求工具授权。",
			parameters: {
				type: "object",
				properties: {
					question: { type: "string", description: "要确认的问题" },
					options: { type: "array", items: { type: "string" }, description: "2-4 个互斥选项" },
				},
				required: ["question", "options"],
			},
			execute: async (toolCallId, params, _signal, _onUpdate, runtimeCtx: ExtensionRuntimeContext) => {
				if (!ctx.askChoice) {
					return { content: [{ type: "text", text: "当前桥版本不支持交互提问，请直接用文字说明你的选择" }], isError: true } as ExtensionToolResult;
				}
				const question = typeof params.question === "string" ? params.question.trim() : "";
				const options = Array.isArray(params.options) ? params.options.map((option) => String(option).trim()).filter(Boolean) : [];
				if (!question) return { content: [{ type: "text", text: "问题不能为空" }], isError: true } as ExtensionToolResult;
				if (options.length < 2 || options.length > 4) {
					return { content: [{ type: "text", text: "选项数量必须是 2-4 个" }], isError: true } as ExtensionToolResult;
				}
				const sessionId = runtimeCtx.sessionManager.getSessionId();
				const route = ctx.routeForSessionId(sessionId);
				if (!route) return { content: [{ type: "text", text: "当前没有活动的飞书会话，无法提问" }], isError: true } as ExtensionToolResult;
				const result = await ctx.askChoice({ toolCallId, question, options, route });
				if (result.status === "answered") {
					return { content: [{ type: "text", text: `用户选择：${result.choice}` }] } as ExtensionToolResult;
				}
				if (result.status === "timeout") {
					return { content: [{ type: "text", text: "用户未在时限内作答（超时）。你可以自行选择合理默认值并说明。" }] } as ExtensionToolResult;
				}
				if (result.status === "cancelled") {
					return { content: [{ type: "text", text: `提问已被取消（${result.reason}），请基于已有信息继续或改用文字说明。` }] } as ExtensionToolResult;
				}
				return { content: [{ type: "text", text: `无法提问：${result.detail}` }], isError: true } as ExtensionToolResult;
			},
		});

		// 上下文压缩：显式告知用户，避免"莫名卡住"
		pi.on("session_before_compact", async (_event: unknown, runtimeCtx: ExtensionRuntimeContext) => {
			try {
				ctx.notifyCompaction?.({ sessionId: runtimeCtx.sessionManager.getSessionId(), phase: "start" });
			} catch (error) {
				ctx.log?.("warn", "feishu.bridge.compaction_hook_failed", { error: String(error) });
			}
		});
		pi.on("session_compact", async (_event: unknown, runtimeCtx: ExtensionRuntimeContext) => {
			try {
				ctx.notifyCompaction?.({ sessionId: runtimeCtx.sessionManager.getSessionId(), phase: "end" });
			} catch (error) {
				ctx.log?.("warn", "feishu.bridge.compaction_hook_failed", { error: String(error) });
			}
		});
		pi.on("session_compact_failed", async (event: unknown, runtimeCtx: ExtensionRuntimeContext) => {
			try {
				const reason = (event as { reason?: string })?.reason;
				ctx.notifyCompaction?.({
					sessionId: runtimeCtx.sessionManager.getSessionId(),
					phase: "failed",
					detail: typeof reason === "string" ? reason : undefined,
				});
			} catch (error) {
				ctx.log?.("warn", "feishu.bridge.compaction_hook_failed", { error: String(error) });
			}
		});

		// agent_settled：Pi 确认不会再有 retry/compaction/follow-up —— 比 agent_end 更终局
		pi.on("agent_settled", async (_event: unknown, runtimeCtx: ExtensionRuntimeContext) => {
			try {
				ctx.markSettled?.(runtimeCtx.sessionManager.getSessionId());
			} catch (error) {
				ctx.log?.("warn", "feishu.bridge.settled_hook_failed", { error: String(error) });
			}
		});

		pi.on("tool_call", async (event: unknown, runtimeCtx: ExtensionRuntimeContext) => {
			const input = event as { toolCallId?: string; toolName?: string; input?: Record<string, unknown> };
			if (!input.toolCallId || !input.toolName) return undefined;
			const sessionId = runtimeCtx.sessionManager.getSessionId();
			const route = ctx.routeForSessionId(sessionId);
			// 路由缺失时不拦截：本 hook 只负责本桥管理的会话（无法归属的工具调用不在此列）。
			if (!route) return undefined;
			ctx.markToolBoundary(sessionId);
			return ctx.gateToolCall({
				conversationKey: route.conversationKey,
				sessionId,
				runId: route.runId ?? input.toolCallId,
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				paramsText: ctx.redactParams(input.input, input.toolName),
				command: bashCommandOf(input.toolName, input.input),
				chatId: route.chatId,
				threadId: route.threadId,
				sourceMessageId: route.sourceMessageId,
				// 真正执行工具的是子会话，这里不传 senderId，adminSkipApproval 在真实路径上永远不生效
				senderId: route.senderId,
				allowedOperatorIds: ctx.allowedOperatorIds(),
			});
		});
	};
}

/**
 * 本扩展的包根目录（本文件在 `<包根>/src/session/` 下）。子会话按它识别并剔除桥自身，
 * 与安装目录叫什么名字无关。
 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 按名字识别网关扩展的兜底特征：包根目录识别不到时（例如扩展被复制到别处加载）才用。
 * 保留旧名，兼容仍按旧路径安装的部署。
 */
export const GATEWAY_EXTENSION_MARKERS = ["pi-feishu-channel", "pi-feishu-bridge"];

/** 扩展发现结果的最小结构（pi LoadExtensionsResult 的子集）。 */
export interface ExtensionDiscoveryResult<T = { path?: string; resolvedPath?: string }> {
	extensions: T[];
}

function realpathOrSelf(path: string): string {
	try { return realpathSync(path); } catch { return path; }
}

/** `path` 是否在 `root` 目录之内（按真实路径比较，软链接安装也能识别）。 */
function isInside(path: string, root: string): boolean {
	const target = realpathOrSelf(path);
	return target === root || target.startsWith(`${root}${sep}`);
}

/**
 * 从子会话扩展发现结果中剔除网关扩展（默认桥自身）：
 * 否则每个子会话都会重新执行桥扩展工厂 —— 重复启动飞书 WS、创建空状态并争抢 app 锁。
 *
 * 先按包根目录识别，再按名字特征兜底。
 */
export function stripGatewayExtensions<T extends { path?: string; resolvedPath?: string }>(
	result: ExtensionDiscoveryResult<T>,
	markers: string[] = GATEWAY_EXTENSION_MARKERS,
	packageRoots: string[] = [PACKAGE_ROOT],
): ExtensionDiscoveryResult<T> {
	const roots = packageRoots.map(realpathOrSelf);
	const extensions = result.extensions.filter((extension) => {
		const paths = [extension.path, extension.resolvedPath].filter((path): path is string => Boolean(path));
		if (paths.some((path) => roots.some((root) => isInside(path, root)))) return false;
		const haystack = paths.join("\u0000");
		return !markers.some((marker) => haystack.includes(marker));
	});
	if (extensions.length === result.extensions.length) return result;
	return { ...result, extensions };
}

/** 取 bash 工具调用的原始命令；其他工具或参数不合法时返回 undefined。 */
export function bashCommandOf(toolName: string, params: Record<string, unknown> | undefined): string | undefined {
	return toolName === "bash" && typeof params?.command === "string" ? params.command : undefined;
}
