/**
 * pi 会话后端：每个 chat 一个 createAgentSession（会话隔离）。
 * 只使用 pi SDK 官方导出的 API。
 */
import { join } from "node:path";
import type { PiImageContent, PiSessionStats, SessionBackend } from "../types.js";
import { GATEWAY_EXTENSION_MARKERS, stripGatewayExtensions, type ExtensionDiscoveryResult, type InlineBridgeExtension } from "./pi-bridge-hooks.js";

interface PiSdk {
	getAgentDir(): string;
	SessionManager: {
		open(file: string, opts?: unknown, cwd?: string): unknown;
	
		list(cwd: string, sessionDir?: string): Promise<PiSessionListInfo[]>;
	};
	DefaultResourceLoader: new (options: {
		cwd: string;
		agentDir: string;
		extensionFactories?: InlineBridgeExtension[];
		extensionsOverride?: (base: unknown) => unknown;
	}) => { reload(options?: unknown): Promise<void> };
	createAgentSession(opts: {
		session?: unknown;
		sessionManager?: unknown;
		cwd: string;
		modelId?: string;
		resourceLoader?: unknown;
		customTools?: unknown[];
	}): Promise<{ session: PiAgentSession }>;
}

interface PiSessionListInfo {
	path: string;
	id: string;
	name?: string;
	modified: Date | string | number;
	messageCount?: number;
}

interface PiAgentSession {
	sessionId: string;
	model: { id: string };
	prompt(text: string, opts?: { images?: PiImageContent[] }): Promise<unknown>;
	steer(text: string, images?: PiImageContent[]): Promise<void>;
	followUp(text: string, images?: PiImageContent[]): Promise<void>;
	subscribe(fn: (event: unknown) => void): () => void;
	abort(): Promise<void>;
	dispose(): void;
	compact(instructions?: string): Promise<{ summary?: string; tokens?: number }>;
	setModel(model: { id: string; provider?: string }): Promise<void>;
	modelRuntime: { getAvailable(providerId?: string): Promise<ReadonlyArray<{ id: string; provider?: string }>> };
	/** 思考等级（可选，老版本 SDK 可能没有）。 */
	thinkingLevel?: string;
	setThinkingLevel?(level: string): void;
	getAvailableThinkingLevels?(): string[];
	/** 会话名称（Pi transcript 中的 session_info）。 */
	sessionName?: string;
	setSessionName?(name: string): void;
	/** 会话统计（含 tokens/cost/contextUsage）；老 SDK 可能没有。 */
	getSessionStats?(): PiSessionStats;
	// ---- pi 0.86 的会话能力（全部可选：老版本 SDK 缺失时上层提示"不支持"）----
	getActiveToolNames?(): string[];
	getAllTools?(): Array<{ name: string }>;
	setActiveToolsByName?(names: string[]): void;
	clearQueue?(): { steering: string[]; followUp: string[] };
	executeBash?(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<PiBashResult>;
	abortBash?(): void;
	getUserMessagesForForking?(): Array<{ entryId: string; text: string }>;
	navigateTree?(targetId: string, options?: { summarize?: boolean }): Promise<{ editorText?: string; cancelled: boolean }>;
	exportToHtml?(outputPath?: string): Promise<string>;
	exportToJsonl?(outputPath?: string): string;
	getLastAssistantText?(): string | undefined;
	summarizeForBugReport?(options: { hint?: string; signal: AbortSignal }): Promise<string>;
	sessionManager?: {
		createBranchedSession?(leafId: string): string | undefined;
		getSessionFile?(): string | undefined;
		getLeafId?(): string | null;
		getEntry?(id: string): { parentId?: string | null } | undefined;
	};
}

export interface PiBashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

export interface PiSessionBackendDeps {
	/** 会话文件目录（默认 config.sessionDir 由桥层传入）。 */
	sessionDir: string;
	modelId?: string;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	/**
	 * 注入到每个子会话的桥侧内联扩展（tool_call 审批 gate + 文件工具）。
	 * 不设时子会话不会挂载桥的审批/工具（outer session 的 hook 不会转发进子会话）。
	 */
	bridgeExtensionFactory?: InlineBridgeExtension;
	/** 子会话扩展发现时剔除网关扩展（默认启用，防止每个子会话重复启动飞书 WS）。 */
	filterGatewayExtensions?: boolean;
	/** 网关扩展识别特征（默认 GATEWAY_EXTENSION_MARKERS，包根目录识别不到时兜底）。 */
	gatewayExtensionMarkers?: string[];
	/** 网关扩展的包根目录（默认本扩展的包根目录）。 */
	gatewayPackageRoots?: string[];
	/** agent 配置目录；默认用 sdk.getAgentDir()。 */
	agentDir?: string;
}

export class PiSessionBackend implements SessionBackend {
	private sdk: PiSdk | undefined;

	constructor(private deps: PiSessionBackendDeps) {}

	private async ensureSdk(): Promise<PiSdk> {
		if (this.sdk) return this.sdk;
		const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as PiSdk;
		this.sdk = sdk;
		return sdk;
	}

	/**
	 * 为子会话构造 ResourceLoader —— 注入桥侧 hook，并从扩展发现中剔除网关扩展。
	 * 返回 undefined 表示既不注入也不过滤（保持 SDK 默认行为）。
	 * 失败时抛出：注入失败不能静默降级成“子会话无审批”。
	 */
	private async buildResourceLoader(sdk: PiSdk, cwd: string): Promise<unknown | undefined> {
		const factory = this.deps.bridgeExtensionFactory;
		const filter = this.deps.filterGatewayExtensions !== false;
		if (!factory && !filter) return undefined;
		const agentDir = this.deps.agentDir ?? sdk.getAgentDir();
		const markers = this.deps.gatewayExtensionMarkers ?? GATEWAY_EXTENSION_MARKERS;
		const options: Record<string, unknown> = {
			cwd,
			agentDir,
			extensionFactories: factory ? [factory] : [],
		};
		// 被剔除的网关扩展数：正常为 1（桥自身）；0 说明子会话会再启动一个飞书长连接
		let strippedGateways = 0;
		if (filter) {
			options.extensionsOverride = (base: unknown) => {
				const discovered = base as ExtensionDiscoveryResult;
				const result = stripGatewayExtensions(discovered, markers, this.deps.gatewayPackageRoots);
				strippedGateways = discovered.extensions.length - result.extensions.length;
				return result;
			};
		}
		try {
			const loader = new sdk.DefaultResourceLoader(options as never);
			await loader.reload();
			this.deps.log?.("info", "feishu.session.resource_loader_ready", {
				cwd, agentDir, injected: Boolean(factory), filtered: filter, strippedGateways,
			});
			return loader;
		} catch (error) {
			this.deps.log?.("error", "feishu.session.resource_loader_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async createSession(opts: { chatId: string; conversationKey: string; sessionFile?: string; cwd?: string }): ReturnType<SessionBackend["createSession"]> {
		const createStartedAt = Date.now();
		const sdk = await this.ensureSdk();
		// 按会话传入的 cwd（默认进程 cwd）；不修改 process.cwd()
		const cwd = opts.cwd ?? process.cwd();
		const sessionDir = this.deps.sessionDir;
		const sessionFile = opts.sessionFile ?? join(sessionDir, `${opts.chatId}.jsonl`);

		let sessionManager: unknown;
		try {
			sessionManager = sdk.SessionManager.open(sessionFile, undefined, cwd);
		} catch (err) {
			this.deps.log?.("error", "feishu.session.open_failed", { sessionFile, error: err instanceof Error ? err.message : String(err) });
			throw err;
		}

		// 把桥侧 hook 注入子会话（并剔除会重复启动网关的扩展）。
		const loaderStartedAt = Date.now();
		const resourceLoader = await this.buildResourceLoader(sdk, cwd);
		const loaderMs = Date.now() - loaderStartedAt;

		const { session: createdSession } = await sdk.createAgentSession({
			session: sessionManager,
			sessionManager,
			cwd,
			modelId: this.deps.modelId,
			...(resourceLoader ? { resourceLoader } : {}),
		});
		const agentSession = createdSession as PiAgentSession;
		// 埋点 —— 先量出扩展发现（ResourceLoader.reload）占多少，再决定要不要按 cwd 缓存
		this.deps.log?.("info", "feishu.session.created", {
			chatId: opts.chatId, sessionId: agentSession.sessionId, sessionFile,
			durationMs: Date.now() - createStartedAt, resourceLoaderMs: loaderMs,
		});

		return {
			sessionId: agentSession.sessionId,
				async prompt(text, images) {
					return agentSession.prompt(text, { images });
				},
				async steer(text, images) {
					await agentSession.steer(text, images);
				},
				async followUp(text, images) {
					await agentSession.followUp(text, images);
				},
			subscribe(fn) {
				return agentSession.subscribe(fn);
			},
			async abort() {
				await agentSession.abort();
			},
			async dispose() {
				agentSession.dispose();
			},
			get modelId() { return agentSession.model?.id ?? "default"; },
			async compact(instructions) {
				const result = await agentSession.compact(instructions);
				return result.summary ? `会话已压缩：${result.summary.slice(0, 200)}` : "会话已压缩";
			},
			async setModel(modelId) {
				const slash = modelId.indexOf("/");
				const provider = slash > 0 ? modelId.slice(0, slash) : undefined;
				const id = slash > 0 ? modelId.slice(slash + 1) : modelId;
				const available = await agentSession.modelRuntime.getAvailable(provider);
				const found = available.find((model) => model.id === id && (!provider || model.provider === provider));
				if (!found) return false;
				await agentSession.setModel(found);
				return true;
			},
			// 模型候选与思考等级（能力缺失时给空值，由上层提示"不支持"）
			async listModels() {
				const available = await agentSession.modelRuntime.getAvailable();
				return available.map((model) => ({ id: model.id, provider: model.provider }));
			},
			availableThinkingLevels() {
				try { return agentSession.getAvailableThinkingLevels?.() ?? []; } catch { return []; }
			},
			thinkingLevel() {
				try { return agentSession.thinkingLevel ?? ""; } catch { return ""; }
			},
			setThinkingLevel(level) {
				// 会话级变更不持久化到全局默认（persist 省略 = false）
				agentSession.setThinkingLevel?.(level);
			},
			// 会话清单（浏览用）与命名
			async listSessions() {
				const sessions = await sdk.SessionManager.list(cwd, sessionDir);
				return sessions.map((info) => ({
					path: info.path,
					id: info.id,
					name: info.name,
					modified: info.modified instanceof Date ? info.modified.getTime() : new Date(info.modified).getTime(),
					messageCount: info.messageCount ?? 0,
				}));
			},
			sessionName() {
				try { return agentSession.sessionName; } catch { return undefined; }
			},
			setSessionName(name) {
				agentSession.setSessionName?.(name);
			},
			// 会话累计统计（token/费用/上下文占用）。
			// 每次调用都是一次全量扫描，但只在 run 结束与用户主动查用量时发生，频率极低。
			getSessionStats() {
				try { return agentSession.getSessionStats?.(); } catch { return undefined; }
			},
			// 按群限制工具
			activeToolNames() {
				try { return agentSession.getActiveToolNames?.() ?? []; } catch { return []; }
			},
			allToolNames() {
				try { return (agentSession.getAllTools?.() ?? []).map((tool) => tool.name); } catch { return []; }
			},
			...(agentSession.setActiveToolsByName ? { setActiveTools(names: string[]) { agentSession.setActiveToolsByName!(names); } } : {}),
			// 清空 pi 侧排队（steer/followUp）
			...(agentSession.clearQueue ? { clearQueue() { return agentSession.clearQueue!(); } } : {}),
			// 直接执行命令（结果记入会话，模型后续能看到）
			...(agentSession.executeBash ? {
				async executeBash(command: string, onChunk?: (chunk: string) => void) { return agentSession.executeBash!(command, onChunk); },
				abortBash() { agentSession.abortBash?.(); },
			} : {}),
			// 重试/回退/分叉
			...(agentSession.getUserMessagesForForking ? { userMessages() { return agentSession.getUserMessagesForForking!(); } } : {}),
			...(agentSession.navigateTree ? { async navigateTo(entryId: string) { return agentSession.navigateTree!(entryId, { summarize: false }); } } : {}),
			...(agentSession.sessionManager?.createBranchedSession ? { branchedSessionFile(leafId: string) { return agentSession.sessionManager!.createBranchedSession!(leafId); } } : {}),
			leafId() {
				try { return agentSession.sessionManager?.getLeafId?.() ?? undefined; } catch { return undefined; }
			},
			entryParentId(entryId: string) {
				try {
					const entry = agentSession.sessionManager?.getEntry?.(entryId);
					return entry ? (entry.parentId ?? null) : undefined;
				} catch { return undefined; }
			},
			// 导出
			...(agentSession.exportToHtml ? { async exportHtml(outputPath: string) { return agentSession.exportToHtml!(outputPath); } } : {}),
			...(agentSession.exportToJsonl ? { exportJsonl(outputPath: string) { return agentSession.exportToJsonl!(outputPath); } } : {}),
			...(agentSession.summarizeForBugReport ? {
				async summarizeForBugReport(hint?: string) {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), 120_000);
					timer.unref?.();
					try { return await agentSession.summarizeForBugReport!({ hint, signal: controller.signal }); } finally { clearTimeout(timer); }
				},
			} : {}),
			lastAssistantText() {
				try { return agentSession.getLastAssistantText?.(); } catch { return undefined; }
			},
		};
	}
}
