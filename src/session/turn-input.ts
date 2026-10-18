/**
 * 一轮对话交给模型的输入是怎么拼出来的：资源、被回复原文、发言人/提及/群设定、崩溃恢复提示。
 *
 * 从 `ConversationManager` 搬出来（原本夹在路由与会话表之间，读改一次要同时理解三件事）。
 * 这里只做「拼文本」，不碰会话表、不发消息 —— 输入相关的行为可以单独读、单独测。
 */
import type { BridgeConfig, PiImageContent } from "../types.js";
import type { ResolvedTurnResources, ResourceResolver } from "../inbound/resource-resolver.js";
import type { LastSentCache } from "../inbound/admit.js";
import { groupSessionsPerUser } from "./conversation-key.js";
import { stripFooterFromQuote } from "../outbound/run-metrics.js";
import type { QueuedMessage } from "./conversation-manager.js";

/** 拼输入需要的外部能力（全部显式传入：这个模块不认识会话表）。 */
export interface TurnInputDeps {
	config: BridgeConfig;
	resourceResolver?: Pick<ResourceResolver, "resolve">;
	/** 只需要「这条消息是不是我发的」这一个判定。 */
	lastSent?: Pick<LastSentCache, "has">;
	resolveUserName?: (openId: string) => Promise<string | undefined>;
	/** 已经发过的页脚原文（引用自己的消息时用来剔除元信息）。 */
	sentFooters: readonly string[];
}

/** 会话上会被拼输入影响的字段（`promptInjected` 只在首轮注入一次）。 */
export interface TurnInputSession {
	promptInjected?: string;
}

export interface TurnInputResult {
	text: string;
	images?: PiImageContent[];
	resources?: ResolvedTurnResources;
	/** 需要写回会话的字段（群设定提示已经注入过）。 */
	promptInjected?: string;
}

export async function buildTurnInput(input: {
	item: QueuedMessage;
	conversationKey: string;
	deps: TurnInputDeps;
	session?: TurnInputSession;
	/** 崩溃恢复的一次性提示（调用方取走后自行删除）。 */
	recoveryNote?: string;
}): Promise<TurnInputResult> {
	const { item, conversationKey, deps } = input;
	let text = item.text;
	let resources: ResolvedTurnResources | undefined;
	if (item.resources.length > 0 && deps.resourceResolver) {
		resources = await deps.resourceResolver.resolve(item.resources);
		text += resources.promptSuffix;
	}
	if (item.replyToMessageId && item.replyToText) {
		// 先剔掉桥自己加的页脚块：那是给人看的元信息，不该每轮花 token 喂回模型。
		// 先按注册表精确匹配我们发过的原文，再按行形态兜底（保证一定删干净）。
		const strippedQuote = stripFooterFromQuote(item.replyToText, deps.sentFooters as string[]);
		// 整条都是页脚（引用了一条纯元信息消息）：注入占位提示，别塞空引用
		const quote = (strippedQuote.trim() || "[无法获取被回复消息原文]").slice(0, 500).replace(/@_user_\w+/g, "@").replace(/\n/g, " ");
		const replyingToSelf = Boolean(deps.lastSent?.has(item.replyToMessageId));
		text = replyingToSelf
			? `[你正在回复自己上一条消息，原文："${quote}"]\n\n${text}`
			: `[正在回复的消息原文："${quote}"]\n\n${text}`;
	}
	const context = await contextLines(item, conversationKey, deps, input.session);
	const promptInjected = context.promptInjected;
	if (context.lines.length > 0) text = `${context.lines.join("\n")}\n\n${text}`;
	// 恢复提示：一次性注入。注意必须放在 replyTo 分支之外 ——
	// 崩溃恢复后用户重发的消息通常不带回复引用，若写在分支内就永远不会生效。
	if (input.recoveryNote) text = `${input.recoveryNote}\n\n${text}`;
	return { text, images: resources?.images, resources, promptInjected };
}

/**
 * 发言人、提及对象、群设定。
 * - 发言人只在多人共用的会话里加（话题、不按人隔离的群；`agentContext.sender=always` 时群聊都加）——
 *   否则模型分不清"谁在说话"；按人隔离的会话里永远是同一个人，加了只是浪费 token；
 * - 提及：让 agent 知道"帮我通知他"的"他"是谁，并拿到 open_id 能 @ 回去；
 * - 群设定（groupRules.<chatId>.prompt）：会话创建后的首轮注入一次，之后在会话历史里。
 */
async function contextLines(
	item: QueuedMessage,
	conversationKey: string,
	deps: TurnInputDeps,
	session: TurnInputSession | undefined,
): Promise<{ lines: string[]; promptInjected?: string }> {
	const lines: string[] = [];
	const options = deps.config.agentContext ?? {};
	let promptInjected: string | undefined;
	// 群里用本群设定；私聊用发起人的个人偏好（/feishu prompt set）
	const personal = item.chatType === "p2p";
	const groupPrompt = (personal
		? (item.senderId ? deps.config.userPrompts?.[item.senderId] : undefined)
		: deps.config.groupRules?.[item.chatId]?.prompt)?.trim();
	if (groupPrompt && session && session.promptInjected !== groupPrompt) {
		lines.push(personal
			? `[用户偏好（本人设置）：${groupPrompt.slice(0, 2_000)}]`
			: `[本群设定（管理员配置，优先遵守）：${groupPrompt.slice(0, 2_000)}]`);
		promptInjected = groupPrompt;
	}
	const senderMode = options.sender ?? "shared";
	const shared = conversationKey.includes(":t:") || (item.chatType === "group" && !groupSessionsPerUser(deps.config, item.chatId));
	if (item.senderId && item.chatType !== "p2p" && (senderMode === "always" || (senderMode === "shared" && shared))) {
		const name = item.senderName ?? await deps.resolveUserName?.(item.senderId).catch(() => undefined);
		lines.push(`[发言人：${name ?? `用户…${item.senderId.slice(-4)}`}（open_id=${item.senderId}）]`);
	}
	if (options.mentions !== false && ((item.mentions?.length ?? 0) > 0 || item.atAll)) {
		const people = (item.mentions ?? []).map((m) => `${m.name ?? "?"}${m.openId ? `(open_id=${m.openId})` : ""}`);
		if (item.atAll) people.push("@所有人");
		lines.push(`[提及：${people.join("、")}]`);
	}
	return { lines, promptInjected };
}
