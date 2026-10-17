/**
 * pi-feishu-channel 扩展入口：把各部分接起来，向 pi 注册命令与事件。
 *
 * - 运行期状态：runtime/bridge-runtime.ts（BridgeRuntime）
 * - 启停、心跳、断线补收、重连：runtime/lifecycle.ts；组件装配：runtime/assemble.ts
 * - 斜杠命令：commands/dispatch.ts + commands/handlers/；TUI 命令：commands/tui.ts
 * - 卡片按钮：interaction/card-router.ts + interaction/card-ops.ts；平台事件：interaction/platform-events.ts
 * - 工具调用审批：approval/gate.ts；pi-permission-system 的「询问」转审批卡：approval/ps-authorizer.ts
 * - 可选能力（默认关闭）：features/
 */
import { dirname, join } from "node:path";
import { createToolGate } from "./approval/gate.js";
import { redactParams } from "./approval/permission-bridge.js";
import { setReportedAgentDir } from "./approval/pi-permission-system.js";
import { createPsAuthorizer } from "./approval/ps-authorizer.js";
import { CommandDispatcher, createCommandReplier } from "./commands/dispatch.js";
import { adminCommands } from "./commands/handlers/admin.js";
import type { CommandServices } from "./commands/handlers/services.js";
import { infoCommands } from "./commands/handlers/info.js";
import { modelCommands } from "./commands/handlers/model.js";
import { sessionCommands } from "./commands/handlers/session.js";
import { registerTuiCommands } from "./commands/tui.js";
import { loadConfig, resolvePaths } from "./config.js";
import { FeatureHost } from "./features/feature.js";
import { FEATURES } from "./features/index.js";
import { effectiveAdmins } from "./inbound/admit.js";
import type { LarkSdkLike } from "./inbound/transport.js";
import { approvalCardOps, clarifyCardOps, commandCardOps, modelCardOps } from "./interaction/card-ops.js";
import { CardRouter } from "./interaction/card-router.js";
import { PlatformEvents } from "./interaction/platform-events.js";
import { stageArtifact, validateLocalArtifact } from "./outbound/artifact.js";
import { createUsageProvider, type UsageProvider } from "./outbound/usage-provider.js";
import type { ExtensionAPI, ExtensionUI } from "./pi-types.js";
import { loadPiAgentDir } from "./runtime/agent-dir.js";
import { autoStartBlocker } from "./runtime/autostart.js";
import { assembleBridge } from "./runtime/assemble.js";
import { BridgeRuntime } from "./runtime/bridge-runtime.js";
import { BridgeLifecycle } from "./runtime/lifecycle.js";
import { createConsoleLogger } from "./runtime/logger.js";
import { Onboarding } from "./runtime/onboarding.js";
import { StatusReporter } from "./runtime/status-reporter.js";
import type { ConversationManagerDeps } from "./session/conversation-manager.js";
import { channelEnv, prepareRuntimeDir, RUNTIME_DIR_NAME } from "./runtime/identity.js";
import { bashCommandOf } from "./session/pi-bridge-hooks.js";
import type { BridgeConfig, FeishuInboundMessage, SessionBackend } from "./types.js";

export type { BridgeLogger } from "./runtime/logger.js";

/**
 * 扩展入口的可选注入项。pi 加载扩展时只传 `pi` 一个参数，所以生产环境下这里总是空的；
 * 测试用它换掉飞书 SDK，从入口把真实的 transport / 流水线 / 命令 / 卡片处理整条跑起来。
 */
export interface BridgeDeps {
	/** 替代 `@larksuiteoapi/node-sdk`（默认按需动态导入真实 SDK）。 */
	larkSdk?: LarkSdkLike;
	/** 替代 pi 会话后端（默认为每个会话创建真实的 pi 子会话）。 */
	sessionBackend?: SessionBackend;
}

export default function feishuBridgeExtension(pi: ExtensionAPI, deps: BridgeDeps = {}) {
	const rt = new BridgeRuntime();
	const log = createConsoleLogger();
	const onboarding = new Onboarding(rt, log);
	const admins = () => effectiveAdmins(rt.config);
	/** pi 状态栏；界面只在事件 ctx 上，session_start 时记下。 */
	let ui: ExtensionUI | undefined;

	// ---- 卡片按钮与斜杠命令 ----
	const cardOpsContext = { rt, log, admins, runCommand: (msg: FeishuInboundMessage) => commandDispatcher.dispatch(msg) };
	const cardRouter = new CardRouter({
		log, admins,
		// 表单提交不回传按钮 value：按「这张卡是不是某个还没答的提问」认领
		fallbackOp: (action) => (action.formValue && rt.clarificationStore?.findByMessage(action.messageId) ? "clarify_submit" : undefined),
	})
		.register("model", modelCardOps(cardOpsContext))
		.register("command", commandCardOps(cardOpsContext))
		.register("clarify", clarifyCardOps(cardOpsContext))
		.register("approval", approvalCardOps(cardOpsContext));

	/**
	 * 账户用量提供方（懒建；余额失败降级为 unavailable，不抛异常）。
	 *
	 * 只在 `/feishu usage` 里查余额，不打任何周期性外部请求；快照文件由
	 * `usage.snapshots` 控制（关掉就只查余额、不估速率）。`usage.provider: "none"` 完全不接厂商。
	 */
	function usageProviderFor(cfg: BridgeConfig): UsageProvider {
		rt.usageProvider ??= createUsageProvider({
			provider: cfg.usage?.provider,
			apiKey: process.env.DEEPSEEK_API_KEY,
			balanceTtlMs: cfg.usage?.balanceTtlMs,
			snapshotPath: cfg.usage?.snapshots === false ? undefined : resolvePaths(rt.homeDir).balanceSnapshotsFile,
			log: (level, message, meta) => log[level](message, meta),
		});
		return rt.usageProvider;
	}

	/** pi 侧的命令/模板/技能（纠错时不误伤、帮助里列出）。 */
	function piCommandList(): Array<{ name: string; description?: string; source?: string }> {
		try { return pi.getCommands?.() ?? []; } catch { return []; }
	}

	const replierFor = createCommandReplier(rt, log);
	const commandServices: CommandServices = {
		rt, log,
		piCommands: () => piCommandList(),
		statusText: () => status.text(),
		diagnosticsContext: () => status.diagnosticsContext(),
		usageProvider: () => usageProviderFor(rt.config),
	};
	const commandDispatcher: CommandDispatcher = new CommandDispatcher({ log, isAdmin: (msg) => admins().includes(msg.senderId), replier: replierFor, piCommands: () => piCommandList() })
		.register("info", infoCommands(commandServices))
		.register("admin", adminCommands(commandServices))
		.register("session", sessionCommands(commandServices))
		.register("model", modelCommands(commandServices));

	// ---- 可选能力、平台事件、审批 ----
	/** 可选能力（默认全部关闭；每次启动按配置装配，停止时注销）。 */
	const featureHost: FeatureHost = new FeatureHost(FEATURES, { dispatcher: commandDispatcher, cardRouter, log });
	const platformEvents = new PlatformEvents(rt, log, onboarding, featureHost);
	cardRouter.register("onboarding", platformEvents.cardOps());
	/** 工具调用审批（外层 tool_call 与子会话内联扩展共用）。 */
	const gateToolCall = createToolGate({ rt, log });
	/** pi-permission-system 授权链环节（进程内一个，子会话的内联扩展挂上它）。 */
	rt.psAuthorizer = createPsAuthorizer({ rt, log });

	/** 把本地文件经持久发送队列发到会话（导出、超长回答附件共用）。 */
	const sendLocalFileToChat: NonNullable<ConversationManagerDeps["sendLocalFile"]> = (chatId, path, opts, meta) => {
		if (!rt.outbox) return { ok: false, error: "outbox 不可用" };
		try {
			const staged = stageArtifact(validateLocalArtifact(path, dirname(path)), join(rt.homeDir, RUNTIME_DIR_NAME, "media-outbox"));
			rt.outbox.enqueueMedia(chatId, staged, opts, { ...meta, kind: "media" });
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message.slice(0, 120) : String(error) };
		}
	};


	// ---- 状态与生命周期 ----
	const status: StatusReporter = new StatusReporter({
		rt, log,
		setUiStatus: (key, text) => ui?.setStatus(key, text),
		reconnects: () => lifecycle.reconnects(),
		featureLines: () => featureHost.statusLines(),
	});
	const lifecycle: BridgeLifecycle = new BridgeLifecycle({
		rt, log, status, features: featureHost,
		featureContext: () => ({
			rt, log, onboarding, replier: replierFor, sendLocalFile: sendLocalFileToChat,
			reconnectsLast5m: () => lifecycle.reconnects().last5m,
		}),
		assemble: () => assembleBridge({
			rt, log, features: featureHost,
			larkSdk: deps.larkSdk, sessionBackend: deps.sessionBackend,
			onConnState: (connState) => lifecycle.onConnState(connState),
			onCardAction: (action) => cardRouter.handle(action),
			onLifecycleEvent: (event) => platformEvents.handle(event),
			gateToolCall,
			dispatchCommand: (msg) => commandDispatcher.dispatch(msg),
			onAdmissionDrop: (msg, reason, mentioned) => platformEvents.onAdmissionDrop(msg, reason, mentioned),
			updateStatus: () => status.update(),
			usageProvider: () => usageProviderFor(rt.config),
			sendLocalFile: sendLocalFileToChat,
		}),
	});

	registerTuiCommands(pi, { rt, log, statusText: () => status.text(), start: () => lifecycle.start(), stop: () => lifecycle.stop() });

	// ---- pi 事件 ----
	pi.on("tool_call", async (event, ctx) => {
		const input = event as { toolCallId?: string; toolName?: string; input?: Record<string, unknown> };
		const sessionId = ctx.sessionManager.getSessionId();
		const route = rt.convManager?.routeForSessionId(sessionId);
		if (!route || !input.toolCallId || !input.toolName) return undefined;
		rt.convManager?.markPendingToolBoundary(sessionId);
		return gateToolCall({
			conversationKey: route.conversationKey,
			sessionId,
			runId: route.runId ?? input.toolCallId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			paramsText: redactParams(input.input, input.toolName),
			command: bashCommandOf(input.toolName, input.input),
			chatId: route.chatId,
			threadId: route.threadId,
			sourceMessageId: route.sourceMessageId,
			senderId: route.senderId,
			allowedOperatorIds: effectiveAdmins(rt.config),
		});
	});

	// 工具执行进度（方案 A）：tool_execution_start/end → 进度消息更新
	// （daemon-host 架构下主进程可收到子进程 agent 的工具事件，pi-feishu-link 同款用法）
	pi.on("tool_execution_start", (event, ctx) => {
		const sessionId = (ctx as { sessionManager?: { getSessionId(): string } })?.sessionManager?.getSessionId() ?? "";
		const ev = event as { toolName?: string; args?: unknown };
		const toolName = ev.toolName ?? "tool";
		const toolCallId = typeof (ev as { toolCallId?: unknown }).toolCallId === "string" ? (ev as { toolCallId: string }).toolCallId : undefined;
		rt.convManager?.onToolEvent(sessionId, toolName, "start", (ev.args ?? {}) as Record<string, unknown>, toolCallId);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const sessionId = (ctx as { sessionManager?: { getSessionId(): string } })?.sessionManager?.getSessionId() ?? "";
		const toolName = (event as { toolName?: string })?.toolName ?? "tool";
		const endToolCallId = typeof (event as { toolCallId?: unknown }).toolCallId === "string" ? (event as { toolCallId: string }).toolCallId : undefined;
		rt.convManager?.onToolEvent(sessionId, toolName, "end", undefined, endToolCallId);
	});


	pi.on("session_start", async (_event, ctx) => {
		ui = ctx?.ui;
		const agentDir = await loadPiAgentDir();
		setReportedAgentDir(agentDir);
		rt.homeDir = channelEnv(process.env, "HOME") ?? agentDir;
		if (!prepareRuntimeDir(rt.homeDir, process.env, log)) return;
		// 桥已经在跑就不再换配置对象。各组件（Sender / Pipeline / ConversationManager）持有的是启动时
		// 那个引用，换掉之后 `/feishu config reload` 改的是新对象而运行中的组件永远读旧值（回执却说已生效）；
		// 而且 implicitAdmins / appOwnerId 这类只在启动时查询、从不落盘的字段换掉就丢了，
		// 后果是所有管理命令和审批卡都回「仅管理员」。改配置走 `/feishu config reload`。
		if (!rt.started) rt.config = loadConfig(rt.homeDir);
		// 只有设了 FEISHU_CHANNEL_ENABLED 的 RPC 进程自动启动，其余进程连上会和部署的实例抢同一个应用的长连接（见 runtime/autostart.ts）。
		// 配置照样读进来，/feishu:start 手动启动时要用。
		const blocker = autoStartBlocker(ctx?.mode, process.env);
		if (blocker) {
			if (rt.started) return;
			log.info("feishu.bridge.autostart_skipped", { reason: blocker, mode: ctx?.mode });
			status.setUi("bridge", "飞书桥未启动（/feishu:start 手动启动）");
			return;
		}
		if (!rt.config.appId || !rt.config.appSecret) {
			log.warn("FEISHU_APP_ID/SECRET 未配置，桥未启动。请配置后运行 /feishu:start。");
			return;
		}
		handleSigterm();
		await lifecycle.start();
		// 网关重启恢复：重发上次中断的未完成消息（hermes resume_pending）
		const recovered = await rt.convManager?.recoverPending() ?? 0;
		if (recovered > 0) log.warn("bridge recovered pending messages", { count: recovered });
	});


	// 优雅关闭：docker stop/restart 时撤回进行中的进度消息与 Typing 表情，
	// 避免残留"🤖 正在处理…"消息和敲键盘表情（kill -9 时由 recoverPending 兜底重发）。
	// 关闭预算 8s（Docker 默认 10s 后 SIGKILL）。旧的 3s 比 shutdown 内部几段 2s 等待之和还短，
	// outbox 在途请求会被截断；8s 给处理完入站消息、收尾进度、等在途发送留足时间，又不至于被 SIGKILL。
	// 只在自动启动时挂上：TUI 自己处理 SIGTERM（先发 session_shutdown 让扩展收尾，再恢复终端），
	// 这里抢先 exit 会让终端来不及恢复。TUI 里手动 /feishu:start 的桥由 session_shutdown 收尾。
	let sigtermHandled = false;
	function handleSigterm(): void {
		if (sigtermHandled) return;
		sigtermHandled = true;
		process.on("SIGTERM", onSigterm);
	}
	function onSigterm(): void {
		const budgetMs = Number(process.env.FEISHU_SHUTDOWN_BUDGET_MS) || 8_000;
		const started = Date.now();
		setTimeout(() => {
			log.warn("feishu.shutdown.budget_exceeded", { budgetMs });
			process.exit(0);
		}, budgetMs).unref();
		void lifecycle.stop().finally(() => {
			log.info("feishu.shutdown.done", { ms: Date.now() - started });
			process.exit(0);
		});
	}

	pi.on("session_shutdown", async () => {
		await lifecycle.dispose();
	});
}
