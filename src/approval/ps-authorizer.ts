/**
 * pi-permission-system（下称 PS）授权链上的飞书环节：把 PS 的「询问」变成飞书审批卡。
 *
 * PS 对每个工具调用给出 allow / deny / ask。ask 交给它的授权链：按配置 `authorizerChain` 的顺序
 * 问每个已注册的环节，环节回 allow / deny / defer，全部 defer 时落到终端 —— 飞书会话没有界面，
 * 终端是直接拒绝。本扩展在每个桥会话里注册名为 `feishu-channel` 的环节（PS_LINK_NAME），
 * 运维把它写进 `authorizerChain` 才生效（PS 侧的显式开启）。
 *
 * 环节的判定：
 *   1. 会话不归本桥管、或该会话的审批模式不是 pi-permission-system → defer（PS 照旧拒绝）；
 *   2. 工作目录外 / 路径类请求（`path`、`external_directory`）→ defer：PS 规定环节对这两类的 allow
 *      一律降成 defer，弹了卡也批不下来，不如不弹。需要时在 PS 配置里放行；
 *   3. 管理员免审（`approval.adminSkipApproval`）→ allow；
 *   4. 命中「始终批准」或本会话已批准的规则 → allow；
 *   5. 其余弹审批卡，按管理员的选择 allow / deny。
 *
 * 环节的 allow 只放行这一次（PS 不替环节记会话级授权），所以「本会话批准」「始终批准」由这里自己记，
 * 键是 PS 给出的规则名（matchedPattern）。bash 复合命令里有多段要询问时，每段的规则都已批准才放行。
 *
 * 版本要求见 pi-permission-system.ts 的 PS_MIN_VERSION。
 */
import { randomUUID } from "node:crypto";
import { effectiveAdmins } from "../inbound/admit.js";
import type { ExtensionAPI } from "../pi-types.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import type { BridgeRoute } from "../session/pi-bridge-hooks.js";
import { isWildcardPattern, type AlwaysApprovedStore } from "./always-approved-store.js";
import { type ApprovalMode, effectiveApprovalMode, globalApprovalMode } from "./mode.js";
import type { ApprovalChoice, ApprovalVerdict, PendingApprovalInput } from "./permission-bridge.js";
import { redactParams } from "./permission-bridge.js";
import {
	PS_LINK_NAME,
	PS_MIN_VERSION,
	type PsAskDetails,
	type PsAuthorizerLog,
	type PsQuery,
	type PsService,
	type PsVerdict,
	psLinkStatus,
	psServiceFor,
} from "./pi-permission-system.js";

/** PS 的就绪广播：每个会话至少一次，可能重复（27.0.0 起）。 */
export const PS_READY_CHANNEL = "permissions:ready";

const DEFER: PsVerdict = { kind: "defer" };
const ALLOW: PsVerdict = { kind: "allow" };

/** 审批卡的选项：有「始终批准」规则表时四档，否则三档。 */
export const PS_CHOICES: ApprovalChoice[] = ["once", "session", "deny"];
export const PS_CHOICES_WITH_ALWAYS: ApprovalChoice[] = ["once", "session", "always", "deny"];

// ------------------------------------------------------------ 请求解读 ----

/** 这次询问是在哪个判定面上触发的（PS 的 gate surface）。 */
export function askSurface(details: PsAskDetails): string | undefined {
	return details.accessIntent?.surface ?? details.surface ?? details.payload?.request?.surface ?? undefined;
}

/**
 * PS 不允许环节放行的判定面：`path`、`external_directory` 及其带方向的成员（`path_read` 等）。
 * 判定面未知时也按受限处理 —— PS 自己就是这么判的。
 */
export function isCappedSurface(surface: string | undefined): boolean {
	return surface === undefined || /^(?:path|external_directory)(?:_read|_write)?$/.test(surface);
}

/**
 * 这次询问涉及的规则名。bash 复合命令里有多段在询问时，逐段向 PS 查规则名
 * （`askingUnits`，PS 只把胜出的那段写进 matchedPattern）；任一段查不到规则名就返回 undefined ——
 * 没有判定依据的请求不能被「始终批准」「本会话批准」自动放行。
 */
export function askPatterns(details: PsAskDetails, query: PsQuery): string[] | undefined {
	const units = details.accessIntent?.askingUnits;
	if (units && units.length > 0) {
		const patterns: string[] = [];
		for (const unit of units) {
			let pattern = unit.floor;
			if (!pattern && unit.command) {
				try {
					pattern = query.checkPermission("bash", unit.command).matchedPattern;
				} catch {
					pattern = undefined;
				}
			}
			if (!pattern) return undefined;
			if (!patterns.includes(pattern)) patterns.push(pattern);
		}
		return patterns;
	}
	const pattern = details.payload?.request?.matchedPattern;
	return pattern ? [pattern] : undefined;
}

/** 审批卡上显示的内容。 */
export interface PsAskView {
	surface: string;
	toolName: string;
	/** 审批人真正要看的东西：bash 是完整命令，路径类是路径。 */
	paramsText: string;
	/** 为什么弹这张卡（命中规则、规则匹配的部分等）。 */
	reason: string;
}

export function describeAsk(details: PsAskDetails, patterns: string[] | undefined): PsAskView {
	const facts = details.payload?.request;
	const surface = askSurface(details) ?? "unknown";
	const toolName = facts?.toolName ?? details.toolName ?? (surface === "bash" ? "bash" : surface);
	const value = facts?.value ?? details.value ?? details.command ?? details.path ?? "";
	// 规则只匹配命令的一部分时（重定向、管道、`&&` 连接的命令），value 只是被匹配的那一段；
	// 审批人必须看到实际要执行的完整命令，否则 `echo x > ~/.bashrc` 在卡片上只显示成 `echo x`。
	const fullCommand = details.payload?.evidence?.find((item) => item.label === "full command")?.text ?? details.command;

	const reasons = ["pi-permission-system 的规则要求询问"];
	const shown = patterns ?? (facts?.matchedPattern ? [facts.matchedPattern] : []);
	if (shown.length > 0) reasons.push(`命中规则：${shown.join("、")}`);
	const showFullCommand = toolName === "bash" && !!fullCommand?.trim() && fullCommand !== value;
	if (showFullCommand && value) reasons.push(`规则匹配的部分：${redactParams({ command: value }, "bash")}`);
	if (facts?.executedUnit && facts.executedUnit !== value) reasons.push(`实际执行：${facts.executedUnit}`);
	if (typeof facts?.commandContext === "string" && facts.commandContext.trim()) reasons.push(`命令位置：${facts.commandContext}`);

	// 都过 redactParams：卡片是发到飞书群里的，命令里的凭据不该跟着走。
	let paramsText: string;
	if (toolName === "bash" && (showFullCommand || value)) {
		paramsText = redactParams({ command: showFullCommand ? fullCommand : value }, "bash");
	} else if (!value) {
		paramsText = `(${surface} 请求，未附带具体值)`;
	} else if (isCappedSurface(surface)) {
		paramsText = redactParams({ path: value });
	} else {
		paramsText = redactParams({ [toolName]: value });
	}
	return { surface, toolName, paramsText, reason: reasons.join("；") };
}

// ------------------------------------------------------------ 环节 ----

export type PsAuthorizerLogFn = (level: "debug" | "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;

export interface PsAuthorizerDeps {
	/** pi 会话 id → 飞书路由；取不到 = 不是本桥的会话。 */
	routeForSessionId(sessionId: string): BridgeRoute | undefined;
	/** 该飞书会话实际生效的审批模式（会话覆盖优先）。 */
	approvalMode(conversationKey: string): ApprovalMode;
	/** 发起人是否免审（`approval.adminSkipApproval` 打开且是管理员）。 */
	adminSkip(senderId: string | undefined): boolean;
	/** 「始终批准」规则表；关闭时为 undefined（卡片上没有「始终批准」）。 */
	alwaysApproved(): AlwaysApprovedStore | undefined;
	allowedOperatorIds(): string[];
	/** 弹审批卡并等管理员选择（PermissionBridge.requestExternal）。 */
	requestDecision(input: PendingApprovalInput): Promise<{ verdict: ApprovalVerdict; choice?: ApprovalChoice; operatorId?: string }>;
	log: PsAuthorizerLogFn;
	/** 按会话取 PS 服务（测试可替换）。 */
	service?(sessionId: string): PsService | undefined;
}

export class PsAuthorizer {
	/** 已注册的会话：记下注册时的服务实例，PS `/reload` 换了实例要重新注册。 */
	private readonly links = new Map<string, { service: PsService; dispose: () => void }>();
	/** 「本会话批准」过的规则名，按 pi 会话 id（/new 换了会话 id 自然失效）。 */
	private readonly sessionGrants = new Map<string, Set<string>>();
	private warnedUnavailable = false;
	private readonly service: (sessionId: string) => PsService | undefined;

	constructor(private readonly deps: PsAuthorizerDeps) {
		this.service = deps.service ?? ((sessionId) => psServiceFor(sessionId));
	}

	/** 挂到一个桥会话上（子会话的内联扩展调用）：PS 就绪时注册环节，会话关闭时注销。 */
	attach(pi: Pick<ExtensionAPI, "events" | "on">): void {
		pi.events.on(PS_READY_CHANNEL, (data) => this.onReady(data));
		pi.on("session_shutdown", (_event, ctx) => {
			this.release(ctx.sessionManager.getSessionId());
		});
	}

	/** 处理 `permissions:ready`：同一会话、同一服务实例只注册一次。 */
	onReady(data: unknown): void {
		const sessionId = (data as { sessionId?: unknown } | undefined)?.sessionId;
		if (typeof sessionId !== "string" || !sessionId) return;
		const service = this.service(sessionId);
		if (!service) {
			if (!this.warnedUnavailable) {
				this.warnedUnavailable = true;
				this.deps.log("warn", "feishu.approval.ps_link_unavailable", {
					sessionId,
					hint: "pi-permission-system 已就绪但取不到它的服务，可能版本过低（需要 27.0.0 及以上）",
				});
			}
			return;
		}
		const current = this.links.get(sessionId);
		if (current?.service === service) return;
		this.disposeLink(sessionId);
		try {
			const dispose = service.registerAuthorizer(PS_LINK_NAME, (details, query, log) => this.authorize(sessionId, details, query, log));
			this.links.set(sessionId, { service, dispose });
			this.deps.log("debug", "feishu.approval.ps_link_registered", { sessionId });
		} catch (error) {
			this.deps.log("warn", "feishu.approval.ps_link_register_failed", {
				sessionId, error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** 会话结束：注销环节、丢掉本会话的授权。 */
	release(sessionId: string): void {
		this.disposeLink(sessionId);
		this.sessionGrants.delete(sessionId);
	}

	/** 已注册环节的会话数（状态展示用）。 */
	registeredCount(): number {
		return this.links.size;
	}

	async authorize(sessionId: string, details: PsAskDetails, query: PsQuery, reviewLog?: PsAuthorizerLog): Promise<PsVerdict> {
		const requestId = details.requestId;
		const route = this.deps.routeForSessionId(sessionId);
		if (!route) {
			this.deps.log("warn", "feishu.approval.ps_link_no_route", { sessionId, requestId });
			return DEFER;
		}
		const mode = this.deps.approvalMode(route.conversationKey);
		if (mode !== "pi-permission-system") {
			// 本会话被临时切到别的模式：不替 PS 应答，ask 照旧被 PS 拒绝
			this.deps.log("info", "feishu.approval.ps_link_mode_skip", { conversationKey: route.conversationKey, mode, requestId });
			return DEFER;
		}
		const surface = askSurface(details);
		if (isCappedSurface(surface)) {
			this.deps.log("warn", "feishu.approval.ps_link_capped", {
				conversationKey: route.conversationKey,
				requestId,
				surface: surface ?? null,
				value: details.payload?.request?.value ?? details.path ?? null,
				hint: "pi-permission-system 不允许授权链放行路径类请求；需要时在它的配置里放行",
			});
			reviewLog?.review("feishu_channel.capped_surface", { surface: surface ?? null });
			return DEFER;
		}
		if (this.deps.adminSkip(route.senderId)) {
			this.deps.log("info", "feishu.approval.admin_skip", { toolName: details.toolName, conversationKey: route.conversationKey, requestId });
			return ALLOW;
		}

		const patterns = askPatterns(details, query);
		const store = this.deps.alwaysApproved();
		if (patterns && store && patterns.every((pattern) => store.has(pattern))) {
			this.deps.log("info", "feishu.approval.ps_always_approved", { conversationKey: route.conversationKey, requestId, patterns });
			return ALLOW;
		}
		const granted = this.sessionGrants.get(sessionId);
		if (patterns && granted && patterns.every((pattern) => granted.has(pattern))) {
			this.deps.log("info", "feishu.approval.ps_session_approved", { conversationKey: route.conversationKey, requestId, patterns });
			return ALLOW;
		}

		const view = describeAsk(details, patterns);
		const decision = await this.deps.requestDecision({
			conversationKey: route.conversationKey,
			sessionId,
			runId: route.runId ?? requestId ?? randomUUID(),
			toolCallId: details.toolCallId ?? requestId ?? randomUUID(),
			toolName: view.toolName,
			paramsText: view.paramsText,
			reason: view.reason,
			chatId: route.chatId,
			threadId: route.threadId,
			sourceMessageId: route.sourceMessageId,
			allowedOperatorIds: this.deps.allowedOperatorIds(),
			choices: store ? [...PS_CHOICES_WITH_ALWAYS] : [...PS_CHOICES],
		});
		this.deps.log("info", "feishu.approval.ps_link_decision", {
			conversationKey: route.conversationKey,
			requestId,
			verdict: decision.verdict,
			choice: decision.choice ?? null,
			patterns: patterns ?? null,
		});
		if (decision.verdict !== "approved") {
			return { kind: "deny", reason: decision.verdict === "timeout" ? "飞书审批超时，已拒绝" : "飞书审批已拒绝" };
		}
		if (decision.choice === "always") this.rememberAlways(route, patterns, decision.operatorId, sessionId);
		else if (decision.choice === "session") this.rememberSession(sessionId, patterns);
		return ALLOW;
	}

	/**
	 * 「始终批准」：把规则名写进规则表。没有规则名时不记（没有依据就「永久放行」等于把审批整个放开），
	 * 退化为本会话批准；写入失败时这一次照样放行（管理员已经批了），只是下次还会问。
	 */
	private rememberAlways(route: BridgeRoute, patterns: string[] | undefined, operatorId: string | undefined, sessionId: string): void {
		const store = this.deps.alwaysApproved();
		if (!patterns || !store) {
			this.deps.log("warn", "feishu.approval.ps_always_degraded", {
				conversationKey: route.conversationKey,
				reason: store ? "请求没有规则名（matchedPattern）" : "「始终批准」未启用",
			});
			this.rememberSession(sessionId, patterns);
			return;
		}
		// 通配规则名（PS 配置里的 "*"）不能永久化：它匹配任何值，落盘后任何会话、任何工具都直接放行。
		// 退化为本会话批准 —— 管理员这一次的选择仍然有效，/new 之后重新询问。
		const wildcard = patterns.filter(isWildcardPattern);
		const persistable = patterns.filter((pattern) => !isWildcardPattern(pattern));
		if (wildcard.length > 0) {
			this.deps.log("warn", "feishu.approval.ps_always_degraded", {
				conversationKey: route.conversationKey,
				reason: "规则名是通配符，永久放行会跳过全部审批",
				patterns: wildcard,
			});
			this.rememberSession(sessionId, wildcard);
		}
		if (persistable.length === 0) return;
		try {
			for (const pattern of persistable) store.add({ pattern, approvedBy: operatorId, conversationKey: route.conversationKey });
			this.deps.log("info", "feishu.approval.ps_always_recorded", { conversationKey: route.conversationKey, patterns: persistable, approvedBy: operatorId ?? null });
		} catch (error) {
			this.deps.log("error", "feishu.approval.always_persist_failed", {
				patterns: persistable, error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private rememberSession(sessionId: string, patterns: string[] | undefined): void {
		if (!patterns) return;
		const granted = this.sessionGrants.get(sessionId) ?? new Set<string>();
		for (const pattern of patterns) granted.add(pattern);
		this.sessionGrants.set(sessionId, granted);
	}

	private disposeLink(sessionId: string): void {
		const link = this.links.get(sessionId);
		if (!link) return;
		this.links.delete(sessionId);
		try {
			link.dispose();
		} catch {
			// PS 已经卸载时注销会失败，忽略
		}
	}
}

/**
 * 按桥的运行期状态装配环节。环节在进程内只建一次、跨 `/feishu:restart` 保留（子会话可能比一次启动活得久），
 * 所以这里的依赖全部在判定时现取。
 */
export function createPsAuthorizer({ rt, log }: { rt: BridgeRuntime; log: BridgeLogger }): PsAuthorizer {
	return new PsAuthorizer({
		// 桥没在运行时没人能点卡：当作不是本桥的会话，交还 PS
		routeForSessionId: (sessionId) => (rt.started && rt.permissionBridge ? rt.convManager?.routeForSessionId(sessionId) : undefined),
		approvalMode: (conversationKey) => effectiveApprovalMode(rt.config, rt.approvalModeOverrides, conversationKey).mode,
		adminSkip: (senderId) => Boolean(rt.config.approval.adminSkipApproval && senderId && effectiveAdmins(rt.config).includes(senderId)),
		alwaysApproved: () => rt.alwaysApproved,
		allowedOperatorIds: () => effectiveAdmins(rt.config),
		requestDecision: async (input) => {
			if (!rt.permissionBridge) return { verdict: "denied" };
			const { verdict, choice, operatorId } = await rt.permissionBridge.requestExternal(input, { auditDecision: "ps_ask" });
			return { verdict, choice, operatorId };
		},
		log: (level, msg, meta) => log[level](msg, meta),
	});
}

/**
 * 启动时检查环节能不能生效（全局模式为 pi-permission-system 时）：版本过低、`authorizerChain` 里没写上本扩展，
 * 都会让 PS 的「询问」一律被拒绝，而桥这边看不到任何调用 —— 只能在启动日志里提前说清。
 * 没装 PS 不在这里报：审批检查每次调用都会记 `feishu.approval.plugin_unavailable` 并退回内置审批。
 */
export function checkPiPermissionSystem(rt: Pick<BridgeRuntime, "config">, log: BridgeLogger, status: () => ReturnType<typeof psLinkStatus> = psLinkStatus): void {
	if (globalApprovalMode(rt.config).mode !== "pi-permission-system") return;
	const link = status();
	if (!link.installed) return;
	log.info("feishu.approval.ps_link", { version: link.version, minVersion: PS_MIN_VERSION, chain: link.chain ?? null, inChain: link.inChain });
	if (!link.versionOk) {
		log.error("feishu.approval.ps_version_unsupported", {
			version: link.version, minVersion: PS_MIN_VERSION,
			hint: `pi-permission-system 需要 ${PS_MIN_VERSION} 及以上，否则它的「询问」不会变成审批卡`,
		});
	}
	if (!link.inChain) {
		log.warn("feishu.approval.ps_link_not_in_chain", {
			chain: link.chain ?? null,
			hint: `在 pi-permission-system 配置里加上 "authorizerChain": ["${PS_LINK_NAME}"]，否则它的「询问」一律被拒绝`,
		});
	}
}
