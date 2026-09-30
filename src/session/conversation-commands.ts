/**
 * 会话级命令 —— 从 ConversationManager 拆出的模型 / 思考等级 / 历史会话 / 工作区命令。
 *
 * 这些命令都是"读写某个会话的设置"，不参与调度与执行；通过 `CommandsHost` 访问会话表和指针存储。
 * ConversationManager 保留同名公开方法（一行委托），调用方（index.ts、测试）不受影响。
 */
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LiveChannel } from "../outbound/live-channel.js";
import type { FeishuInboundMessage } from "../types.js";
import { buildConversationKey } from "./conversation-key.js";
import type { AgentHandle, BridgeSession, ConversationManagerDeps } from "./conversation-manager.js";
import type { ConversationStore } from "./conversation-store.js";
import { ModelUsageStore } from "../runtime/model-usage-store.js";
import { formatRelative, matchModels, modelLabel, sessionUsageStats } from "./model-utils.js";

/** 命令需要的管理器能力（ConversationManager 构造时提供）。 */
export interface CommandsHost {
	readonly sessions: Map<string, BridgeSession>;
	readonly conversationStore?: ConversationStore;
	readonly liveChannel?: LiveChannel;
	readonly nextSessionSuffix: Map<string, string>;
	readonly workspaceAliasByKey: Map<string, string>;
	now(): number;
	getOrCreateSession(msg: FeishuInboundMessage, key: string): BridgeSession;
	ensureAgentSession(session: BridgeSession): Promise<AgentHandle>;
	pendingWork(key: string): number;
}

export class ConversationCommands {
	/** 模型切换历史（最近使用 + 衰减频率；持久化，重启不丢）。 */
	private readonly modelUsage: ModelUsageStore;

	constructor(private readonly deps: ConversationManagerDeps, private readonly host: CommandsHost) {
		this.modelUsage = new ModelUsageStore({ file: deps.modelUsageFile, now: () => host.now() });
	}

	/**
	 * 解析工作区别名 → realpath。
	 * 只接受配置中登记的别名；拒绝绝对路径、`..`、白名单外目录与不存在的路径。
	 */
	resolveWorkspace(alias: string): { ok: true; path: string } | { ok: false; reason: string } {
		const aliases = this.deps.config.workspaces?.aliases ?? {};
		if (!alias) return { ok: false, reason: "缺少工作区别名" };
		if (alias.includes("/") || alias.includes("\\") || alias.includes("..")) {
			return { ok: false, reason: "只接受配置中的别名（不接受路径）" };
		}
		const configured = aliases[alias];
		if (!configured) return { ok: false, reason: `未登记的工作区别名：${alias}` };
		let real: string;
		try {
			real = realpathSync(configured);
			if (!statSync(real).isDirectory()) return { ok: false, reason: `工作区不是目录：${alias}` };
		} catch {
			return { ok: false, reason: `工作区不可访问：${alias}` };
		}
		return { ok: true, path: real };
	}

	/** 查看当前会话工作区（只显示别名与是否启用，不泄露绝对路径）。 */
	workspaceInfo(msg: FeishuInboundMessage): string {
		const aliases = Object.keys(this.deps.config.workspaces?.aliases ?? {});
		if (aliases.length === 0) return "未配置受控工作区（如需启用，请在 config.json 的 workspaces.aliases 登记别名）";
		const key = buildConversationKey(msg, this.deps.config);
		const pointer = this.host.conversationStore?.get(key);
		const current = this.host.workspaceAliasByKey.get(key) ?? pointer?.workspace ?? this.host.sessions.get(key)?.workspaceAlias;
		return `当前工作区：${current ?? "默认工作区"}\n可用别名：${aliases.join(" / ")}`;
	}

	/**
	 * 切换工作区（仅管理员；忙碌拒绝）。
	 * 先校验别名 → 新建该工作区会话 → 落盘指针 → 处置旧句柄 → 旧审批/澄清失效。
	 * 失败时保留当前工作区；**绝不修改进程 cwd**。
	 */
	async switchWorkspace(msg: FeishuInboundMessage, alias?: string, options: { isAdmin?: boolean } = {}): Promise<string> {
		if (!alias) return this.workspaceInfo(msg);
		if (!options.isAdmin) return "仅管理员可切换工作区";
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.host.sessions.get(key);
		const busy = this.host.pendingWork(key) + (session?.activeRun ? 1 : 0);
		if (busy > 0) return "当前会话仍在执行或有排队任务，请先 /stop 再切换工作区";

		const resolved = this.resolveWorkspace(alias);
		if (!resolved.ok) return resolved.reason;
		const current = this.host.workspaceAliasByKey.get(key) ?? session?.workspaceAlias;
		if (current === alias) return `当前已经是工作区 ${alias}`;

		// ① 先落盘指针（失败则不切换）。切换工作区 = 在新工作区新建会话，
		// 旧会话进入 history（可 /resume 回去）；没有指针时也要落盘，否则重启就丢了工作区。
		if (this.host.conversationStore) {
			try {
				const previous = this.host.conversationStore.get(key);
				const base = key.replace(/[^a-zA-Z0-9_-]/g, "_");
				this.host.conversationStore.set({
					conversationKey: key,
					sessionFile: join(this.deps.sessionDir, `${base}-${randomUUID()}.jsonl`),
					generation: (previous?.generation ?? 0) + 1,
					workspace: alias,
				});
			} catch {
				return "工作区指针写入失败，已保留当前工作区";
			}
		} else {
			this.host.nextSessionSuffix.set(key, `-${randomUUID()}`);
		}
		this.host.workspaceAliasByKey.set(key, alias);
		// ② 处置旧句柄与会话状态（下一条消息在新工作区懒建会话）
		this.host.sessions.delete(key);
		this.host.liveChannel?.discard(key);
		const previous = session?.agent;
		if (previous) {
			try { await previous.dispose(); } catch { /* best effort */ }
		}
		// ③ 旧审批/澄清一律失效（旧卡片不得影响新工作区）
		this.deps.onApprovalInvalidate?.({ conversationKey: key, reason: "reset" });
		this.deps.log?.("info", "feishu.conv.workspace_switched", { conversationKey: key, alias });
		return `已切换到工作区 ${alias}；下一条消息将在该工作区新建会话（进程 cwd 未改变）`;
	}

	/** 本会话可访问的历史会话（选择 id 形如 #N，最近在前）。 */
	async listSessionsFor(msg: FeishuInboundMessage, page = 0): Promise<string> {
		const data = await this.sessionsPage(msg, page);
		if (typeof data === "string") return data;
		const lines = data.entries.map((entry) => `${entry.selector} · ${entry.name}（${entry.when}，${entry.count}）${entry.isCurrent ? " · 当前" : ""}`);
		return `本会话历史\n${lines.join("\n")}\n\n${data.footer}`;
	}

	/** 会话列表数据（文本与卡片共用）；字符串 = 不可用的原因。 */
	async sessionsPage(msg: FeishuInboundMessage, page = 0): Promise<string | {
		entries: Array<{ selector: string; name: string; when: string; count: string; isCurrent: boolean }>;
		footer: string;
	}> {
		const key = buildConversationKey(msg, this.deps.config);
		const pointer = this.host.conversationStore?.get(key);
		if (!pointer) return "当前会话尚无历史记录（/new 之后会保留上一段会话）";
		const session = this.host.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try {
			agent = await this.host.ensureAgentSession(session);
		} catch {
			return "会话列表获取失败，请稍后重试";
		}
		if (!agent.listSessions) return "当前 Pi 版本不支持列出会话";
		let infos: Array<{ path: string; name?: string; modified: number; messageCount: number }>;
		try {
			infos = await agent.listSessions();
		} catch (error) {
			this.deps.log?.("warn", "feishu.conv.list_sessions_failed", {
				conversationKey: key, error: error instanceof Error ? error.message : String(error),
			});
			return "会话列表获取失败，请稍后重试";
		}
		// 归属过滤：只显示本会话指针索引内的文件，绝不列出会话目录里的其他会话
		const ordered = [pointer.sessionFile, ...(pointer.history ?? []).map((entry) => entry.sessionFile)];
		const byPath = new Map(infos.map((info) => [info.path, info]));
		const all = ordered.map((file, index) => ({ selector: `#${index + 1}`, info: byPath.get(file), isCurrent: file === pointer.sessionFile }));
		const pageSize = 10;
		const pages = Math.max(1, Math.ceil(all.length / pageSize));
		const current = Math.min(Math.max(0, page), pages - 1);
		const entries = all.slice(current * pageSize, current * pageSize + pageSize).map((entry) => ({
			selector: entry.selector,
			name: entry.info?.name?.trim() || "未命名会话",
			when: entry.info ? formatRelative(entry.info.modified, this.host.now()) : "未知时间",
			count: entry.info ? `${entry.info.messageCount} 条` : "文件缺失",
			isCurrent: entry.isCurrent,
		}));
		const footer = [
			`共 ${all.length} 段`,
			pages > 1 ? `第 ${current + 1}/${pages} 页` : "",
			current + 1 < pages ? `下一页：/sessions ${current + 2}` : "",
			"用 /resume <选择 id> 恢复；/name <名称> 命名当前会话",
		].filter(Boolean).join("　");
		return { entries, footer };
	}

	/** 重命名当前会话（写入 Pi transcript 的 session_info）。 */
	async renameConversation(msg: FeishuInboundMessage, rawName?: string): Promise<string> {
		const name = (rawName ?? "").trim();
		if (!name) return "用法：/name <名称>（最多 60 字）";
		if (name.length > 60) return "名称过长（最多 60 字）";
		// 去掉控制字符，避免落进 transcript 造成渲染/解析问题
		const cleaned = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
		if (!cleaned) return "名称不合法（仅含控制字符）";
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.host.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try {
			agent = await this.host.ensureAgentSession(session);
		} catch {
			return "会话初始化失败，请稍后重试";
		}
		if (!agent.setSessionName) return "当前 Pi 版本不支持重命名会话";
		try {
			agent.setSessionName(cleaned);
		} catch (error) {
			return `重命名失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
		}
		return `已将会话命名为：${cleaned}`;
	}

	/**
	 * 恢复历史会话。只接受本会话列表内的选择 id（不接受任意路径），
	 * 忙碌/有排队时拒绝；先落盘指针再切运行态，失败保留当前会话。
	 */
	async resumeConversation(msg: FeishuInboundMessage, rawSelector?: string): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		if (!this.host.conversationStore) return "当前部署未启用会话索引，无法恢复";
		const pointer = this.host.conversationStore.get(key);
		if (!pointer) return "当前会话尚无历史记录，无法恢复";
		const session = this.host.sessions.get(key);
		const pending = this.host.pendingWork(key);
		if (session?.activeRun || pending > 0) return "当前会话仍在执行或有排队任务，请先 /stop 或处理队列后再恢复";

		const match = /^#(\d+)$/.exec((rawSelector ?? "").trim());
		if (!match) return "用法：/resume <选择 id>（先用 /sessions 查看）";
		const index = Number.parseInt(match[1], 10);
		const ordered = [pointer.sessionFile, ...(pointer.history ?? []).map((entry) => entry.sessionFile)];
		const target = ordered[index - 1];
		if (!target) return `选择 id 无效：${rawSelector}（先用 /sessions 查看）`;
		if (target === pointer.sessionFile) return "该会话已经是当前会话";
		if (!existsSync(target)) return "目标会话文件不存在，已保留当前会话";

		// ① 先原子落盘指针：失败则不切换（避免重启后状态不一致）
		try {
			this.host.conversationStore.set({ conversationKey: key, sessionFile: target, generation: pointer.generation + 1 });
		} catch {
			return "会话指针写入失败，已保留当前会话";
		}
		// ② 处置旧 handle 与易失状态（Pi 历史、pending、outbox 不动）
		this.host.sessions.delete(key);
		this.host.liveChannel?.discard(key);
		const old = session?.agent;
		if (old) {
			try { await old.dispose(); } catch { /* best effort */ }
		}
		// ③ 旧审批卡一律失效（不携带 runId → 按会话全量撤销）
		this.deps.onApprovalInvalidate?.({ conversationKey: key, reason: "reset" });
		this.deps.log?.("info", "feishu.conv.session_resumed", { conversationKey: key, selector: rawSelector });
		return `已恢复会话 ${rawSelector}；下一条消息将在该会话继续`;
	}

	/**
	 * 列出已认证模型（provider 用于区分同名模型）。
	 * 首次调用会懒初始化会话，避免"当前会话尚未建立"。
	 */
	/**
	 * 供 /models 卡片使用的数据快照：模型清单 + 当前模型 + 会话 key。
	 * 返回 null 表示无法获取（调用方回退到文本版 listModels）。
	 */
	async modelsCardData(msg: FeishuInboundMessage): Promise<{
		models: Array<{ id: string; provider?: string }>; currentId: string; conversationKey: string;
	} | null> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.host.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try {
			agent = await this.host.ensureAgentSession(session);
		} catch (error) {
			this.deps.log?.("error", "feishu.conv.models_init_failed", {
				conversationKey: key, error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		if (!agent.listModels) return null;
		try {
			const models = await agent.listModels();
			if (models.length === 0) return null;
			return { models, currentId: agent.modelId, conversationKey: key };
		} catch {
			return null;
		}
	}

	/**
	 * 列出已认证模型（provider 用于区分同名模型）。
	 * 首次调用会懒初始化会话，避免"当前会话尚未建立"。
	 */
	async listModels(msg: FeishuInboundMessage, page = 0): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.host.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try {
			agent = await this.host.ensureAgentSession(session);
		} catch (error) {
			this.deps.log?.("error", "feishu.conv.models_init_failed", {
				conversationKey: key, error: error instanceof Error ? error.message : String(error),
			});
			return "模型列表获取失败，请稍后重试";
		}
		if (!agent.listModels) return "当前 Pi 版本不支持远程列出模型";
		let models: Array<{ id: string; provider?: string }>;
		try {
			models = await agent.listModels();
		} catch (error) {
			return `模型列表获取失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
		}
		if (models.length === 0) return "没有已认证的模型";

		const pageSize = 20;
		const pages = Math.max(1, Math.ceil(models.length / pageSize));
		const current = Math.min(Math.max(0, page), pages - 1);
		const slice = models.slice(current * pageSize, current * pageSize + pageSize);
		const lines = slice.map((model) => {
			const label = model.provider ? `${model.provider}/${model.id}` : model.id;
			return model.id === agent.modelId ? `· ${label}（当前）` : `· ${label}`;
		});
		// 每页都标出页码（最后一页也可见"第 N/N 页"），并给出下一页指令
		const footer = [
			pages > 1 ? `第 ${current + 1}/${pages} 页` : "",
			current + 1 < pages ? `下一页：/models ${current + 2}` : "",
		].filter(Boolean).join("　");
		return `可用模型（${models.length}）\n${lines.join("\n")}${footer ? `\n\n${footer}` : ""}`;
	}

	/** 查看或设置思考等级（仅接受当前模型可用等级；忙碌时拒绝变更）。 */
	async thinkingConversation(msg: FeishuInboundMessage, level?: string): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.host.getOrCreateSession(msg, key);
		if (!level && session.agent) {
			const levels = session.agent.availableThinkingLevels?.() ?? [];
			if (levels.length === 0) return "当前模型不支持思考等级";
			return `当前思考等级：${session.agent.thinkingLevel?.() || "未知"}\n可用：${levels.join(" / ")}`;
		}
		let agent: AgentHandle;
		try {
			agent = await this.host.ensureAgentSession(session);
		} catch (_error) {
			return "思考等级会话初始化失败，请稍后重试";
		}
		const levels = agent.availableThinkingLevels?.() ?? [];
		if (levels.length === 0) return "当前模型不支持思考等级";
		if (!level) return `当前思考等级：${agent.thinkingLevel?.() || "未知"}\n可用：${levels.join(" / ")}`;
		if (session.activeRun) return "当前会话仍在执行，请稍后调整思考等级";
		if (!agent.setThinkingLevel) return "当前 Pi 版本不支持远程调整思考等级";
		if (!levels.includes(level)) return `不支持的等级：${level}\n可用：${levels.join(" / ")}`;
		agent.setThinkingLevel(level);
		// 回显实际等级（provider 会按模型能力 clamp）
		return `已设置思考等级：${agent.thinkingLevel?.() || level}`;
	}

	async modelConversation(msg: FeishuInboundMessage, modelId?: string): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.host.getOrCreateSession(msg, key);
		if (session.activeRun && !session.agent) return "当前会话正在初始化模型，请稍后重试";
		// 不带参数 = 展示型查询（对齐 hermes /model）：给出当前模型、可用候选与切换语法，
		// 而不是只回一行「当前模型：x」让用户不知道下一步该输什么。
		if (!modelId && session.agent) return await this.describeModel(session.agent);
		if (session.activeRun) return "当前会话仍在执行，请稍后切换模型";
		let agent: AgentHandle;
		try {
			agent = await this.host.ensureAgentSession(session);
		} catch (error) {
			this.deps.log?.("error", "feishu.conv.model_session_init_failed", {
				conversationKey: key,
				error: error instanceof Error ? error.message : String(error),
			});
			return "模型会话初始化失败，请稍后重试";
		}
		if (!modelId) return await this.describeModel(agent);
		return (await this.switchModel(agent, modelId)).text;
	}

	/**
	 * 构造 /model 的展示文本：当前模型 + 可用候选 + 切换语法。
	 * 候选有上限（默认 10），超出时指向 /models 分页查看 —— 模型多时避免刷屏。
	 * 列模型时一律带 provider 前缀，因为同名 id 可能来自不同 provider
	 * （例如自建网关与官方 API 都可能有同名模型）。
	 */
	private async describeModel(agent: AgentHandle, limit = 10): Promise<string> {
		const current = agent.modelId;
		const lines: string[] = [`当前模型：${current}`];
		const thinking = agent.thinkingLevel?.();
		if (thinking) lines[0] += `　思考等级：${thinking}`;

		let all: Array<{ id: string; provider?: string }> = [];
		try {
			all = (await agent.listModels?.()) ?? [];
		} catch {
			// 列出候选失败不影响展示当前模型（例如 provider 暂时不可达）
		}
		const candidates = all.filter((entry) => entry.id !== current);
		if (candidates.length > 0) {
			const shown = candidates.slice(0, limit);
			lines.push("", `可切换（${candidates.length}）`);
			for (const entry of shown) {
				const label = entry.provider ? `${entry.provider}/${entry.id}` : entry.id;
				lines.push(`· ${label}`);
			}
			if (candidates.length > shown.length) lines.push(`· …其余 ${candidates.length - shown.length} 个`);
		}
		lines.push("", "切换：/model <模型>　查看全部：/models　思考等级：/thinking");
		return lines.join("\n");
	}

	/**
	 * 状态卡的数据源（/model 无参）。
	 *
	 * 当前模型要尽量带上 provider 前缀：`agent.modelId` 是**裸 id**，而 /models
	 * 表格里是 `provider/id` —— 两边不一致会让人以为不是一个模型，而且带前缀
	 * 才能直接复制进 `/model` 命令。
	 *
	 * 反查有歧义时**返回裸 id 而不猜**：猜错会让人复制一个错误的模型名去切换，
	 * 比不显示前缀更糟。
	 */
	async modelStatusCardData(msg: FeishuInboundMessage): Promise<Awaited<ReturnType<ConversationCommands["modelStatusCardDataByKey"]>>> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.host.getOrCreateSession(msg, key);
		try {
			await this.host.ensureAgentSession(session);
		} catch (error) {
			this.deps.log?.("error", "feishu.conv.model_status_init_failed", {
				conversationKey: key, error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		return this.modelStatusCardDataByKey(key);
	}

	/** 按钮回调用：按 key 取状态卡数据（回调里没有 inbound 消息，拿不到 chatId）。 */
	async modelStatusCardDataByKey(conversationKey: string): Promise<{
		currentLabel: string;
		thinkingLevel?: string;
		availableLevels: string[];
		conversationKey: string;
		models: Array<{ id: string; provider?: string }>;
		recentModels: string[];
		frequentModels: string[];
		contextInfo?: string;
	} | null> {
		const session = this.host.sessions.get(conversationKey);
		if (!session?.agent) return null;
		const agent = session.agent;

		let currentLabel = agent.modelId;
		let models: Array<{ id: string; provider?: string }> = [];
		try {
			models = (await agent.listModels?.()) ?? [];
			const matches = models.filter((entry) => entry.id === agent.modelId);
			const only = matches.length === 1 ? matches[0] : undefined;
			if (only?.provider) currentLabel = `${only.provider}/${only.id}`;
		} catch {
			// 反查失败就用裸 id（不猜 provider）
		}
		const thinkingLevel = agent.thinkingLevel?.();
		// 上下文窗口与占用（与页脚同源：SDK 会话统计）
		const context = sessionUsageStats(agent)?.contextUsage;
		const windowLabel = context?.contextWindow ? `${Math.round(context.contextWindow / 1000)}k` : undefined;
		const contextInfo = windowLabel
			? `上下文窗口 ${windowLabel}${typeof context?.percent === "number" ? ` · 当前已用 ${Math.round(context.percent)}%` : ""}`
			: undefined;
		return {
			currentLabel,
			...(thinkingLevel ? { thinkingLevel } : {}),
			availableLevels: agent.availableThinkingLevels?.() ?? [],
			conversationKey,
			models,
			recentModels: this.recentModelLabels(),
			frequentModels: this.modelUsage.frequent(12),
			...(contextInfo ? { contextInfo } : {}),
		};
	}

	/** 按钮回调：按会话 key 切换思考等级（等价于 /thinking <level>）。 */
	async setThinkingByKey(conversationKey: string, level: string): Promise<{ ok: boolean; reason?: string }> {
		const session = this.host.sessions.get(conversationKey);
		if (!session?.agent) return { ok: false, reason: "会话已失效，请重新发送 /model" };
		const available = session.agent.availableThinkingLevels?.() ?? [];
		if (available.length > 0 && !available.includes(level)) {
			return { ok: false, reason: `当前模型不支持档位 ${level}` };
		}
		try {
			session.agent.setThinkingLevel?.(level);
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message.slice(0, 80) : "切换失败" };
		}
	}

	/** 最近用过的模型（全进程，最近在前，最多 3 个）。 */
	recentModelLabels(): string[] {
		return this.modelUsage.recent(3);
	}

	private rememberModel(label: string): void {
		this.modelUsage.record(label);
	}

	/**
	 * 模糊匹配后切换。唯一命中才切；多个命中列出候选（不猜）。
	 * 返回 `{ ok, text }`，卡片按钮与命令共用。
	 */
	private async switchModel(agent: AgentHandle, query: string): Promise<{ ok: boolean; text: string }> {
		if (!agent.setModel) return { ok: false, text: "当前 Pi 版本不支持远程切换模型" };
		let target = query;
		let models: Array<{ id: string; provider?: string }> = [];
		try { models = (await agent.listModels?.()) ?? []; } catch { /* 列表拿不到就按原文切换 */ }
		if (models.length > 0) {
			const matches = matchModels(models, query);
			if (matches.length > 1) {
				const shown = matches.slice(0, 8).map((model) => `· ${modelLabel(model)}`);
				if (matches.length > shown.length) shown.push(`· …其余 ${matches.length - shown.length} 个`);
				return { ok: false, text: [`「${query}」匹配到 ${matches.length} 个模型，请写得更具体：`, ...shown, "", `例如：/model ${modelLabel(matches[0])}`].join("\n") };
			}
			if (matches.length === 1) target = modelLabel(matches[0]);
		}
		if (!await agent.setModel(target)) return { ok: false, text: `找不到已认证模型：${query}（/models 查看全部）` };
		this.rememberModel(target);
		return { ok: true, text: target === query ? `已切换模型：${target}` : `已切换模型：${target}（按「${query}」匹配）` };
	}

	/** 卡片按钮切换模型（按会话 key）。 */
	async setModelByKey(conversationKey: string, label: string): Promise<{ ok: boolean; reason?: string }> {
		const session = this.host.sessions.get(conversationKey);
		if (!session?.agent) return { ok: false, reason: "会话已失效，请重新发送 /model" };
		if (session.activeRun) return { ok: false, reason: "当前会话仍在执行，请稍后切换模型" };
		const result = await this.switchModel(session.agent, label);
		return result.ok ? { ok: true } : { ok: false, reason: result.text.split("\n")[0] };
	}
}
