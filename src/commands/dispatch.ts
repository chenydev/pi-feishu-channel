/**
 * 命令分发：按注册表（registry.ts）解析出规范名，再查表交给登记的处理函数。
 *
 * - 处理函数按组登记（`register(owner, handlers)`）；登记注册表里没有的命令名，
 *   或两个组登记同一个命令，都在启动时抛错（日志 `feishu.command.handler_conflict`）。
 * - `intercept` 用于不属于斜杠命令表的输入（如 `!<命令>` 直接执行），先于命令解析。
 * - 看起来像打错的桥命令时给出纠错提示，而不是默默交给模型。
 */
import { buildConversationKey } from "../session/conversation-key.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import type { FeishuInboundMessage } from "../types.js";
import { COMMANDS, resolveCommand, suggestCommand } from "./registry.js";

export interface CommandReplier {
	/** 文本回执：走持久化发送队列（合成消息按 dedupeNonce 区分，卡片按钮可以点很多次）。 */
	reply(text: string, suffix?: string): void;
	/** 卡片优先；发送失败（无权限/业务码非 0）返回 false，调用方退回文本回执。 */
	trySendCard(card: unknown, what: string): Promise<boolean>;
}

export interface CommandContext extends CommandReplier {
	msg: FeishuInboundMessage;
	/** 命令名之后按空白切开的参数。 */
	args: string[];
	/** 命令名之后的原文（保留空白）。 */
	rest: string;
	isAdmin: boolean;
	/** 卡片按钮的上下文（会话形态与发起人）。 */
	buttonCtx: { chatType: FeishuInboundMessage["chatType"]; threadId?: string; ownerOpenId: string };
}

export type CommandHandler = (ctx: CommandContext) => unknown | Promise<unknown>;
export type CommandInterceptor = (msg: FeishuInboundMessage) => boolean | Promise<boolean>;

export interface PiCommandInfo { name: string; description?: string; source?: string }

export class CommandConflictError extends Error {
	constructor(readonly command: string, readonly owners: [string, string]) {
		super(`命令 ${command} 被重复登记：${owners.join(" 与 ")}`);
	}
}

export function createCommandReplier(rt: BridgeRuntime, log: BridgeLogger): (msg: FeishuInboundMessage) => CommandReplier {
	return (msg) => {
		const replyTo = msg.replyTarget === null ? undefined : msg.replyTarget ?? msg.messageId;
		return {
			reply(text, suffix = "command") {
				if (!rt.outbox) throw new Error("outbox unavailable");
				rt.outbox.enqueue(msg.chatId, text, { replyTo, threadId: msg.threadId }, {
					dedupeKey: `${msg.messageId}${msg.dedupeNonce ?? ""}:${suffix}`, laneKey: buildConversationKey(msg, rt.config), kind: "notify",
				});
			},
			async trySendCard(card, what) {
				if (!rt.transport) return false;
				try {
					await rt.transport.sendCard(msg.chatId, card, { replyTo, threadId: msg.threadId });
					return true;
				} catch (error) {
					log.warn("feishu.command.card_failed", { command: what, error: error instanceof Error ? error.message : String(error) });
					return false;
				}
			},
		};
	};
}

export class CommandDispatcher {
	private readonly handlers = new Map<string, { owner: string; run: CommandHandler }>();
	private readonly interceptors: Array<{ owner: string; run: CommandInterceptor }> = [];
	private readonly known = new Set(COMMANDS.map((spec) => spec.name));

	constructor(private readonly opts: {
		log: BridgeLogger;
		isAdmin: (msg: FeishuInboundMessage) => boolean;
		replier: (msg: FeishuInboundMessage) => CommandReplier;
		/** pi 侧的命令/模板/技能（纠错时不误伤）。 */
		piCommands: () => PiCommandInfo[];
	}) {}

	register(owner: string, handlers: Record<string, CommandHandler>): this {
		for (const name of Object.keys(handlers)) {
			if (!this.known.has(name)) throw new Error(`命令 ${name} 不在注册表里（commands/registry.ts）`);
			const existing = this.handlers.get(name);
			if (existing) {
				this.opts.log.error("feishu.command.handler_conflict", { command: name, owners: [existing.owner, owner] });
				throw new CommandConflictError(name, [existing.owner, owner]);
			}
		}
		for (const [name, run] of Object.entries(handlers)) this.handlers.set(name, { owner, run });
		return this;
	}

	/** 登记一个先于命令解析的拦截器；返回 true 表示已处理。 */
	intercept(owner: string, run: CommandInterceptor): this {
		this.interceptors.push({ owner, run });
		return this;
	}

	/** 已登记的命令及其所属组（诊断与测试用）。 */
	commands(): Record<string, string> {
		return Object.fromEntries([...this.handlers].map(([name, handler]) => [name, handler.owner]));
	}

	/** 处理一条消息；返回 false 表示不是桥的命令（交给会话）。 */
	async dispatch(msg: FeishuInboundMessage): Promise<boolean> {
		for (const interceptor of this.interceptors) if (await interceptor.run(msg)) return true;
		const raw = msg.text.trim();
		const resolved = resolveCommand(raw);
		if (!resolved) {
			// 像是打错的桥命令（且不是 pi 的命令/模板/技能）→ 提示，而不是默默交给模型
			if (raw.startsWith("/")) {
				const known = new Set(this.opts.piCommands().map((command) => `/${command.name.toLowerCase()}`));
				const suggestion = suggestCommand(raw, known);
				if (suggestion) {
					this.opts.replier(msg).reply(`未知命令 ${raw.split(/\s+/)[0]}，是否想用 ${suggestion}？（/help 查看全部命令）`);
					return true;
				}
			}
			return false;
		}
		const { spec, args, rest } = resolved;
		const handler = this.handlers.get(spec.name);
		if (!handler) return false;
		this.opts.log.info("feishu.command", { command: spec.name, chatId: msg.chatId, operator: msg.senderId, synthetic: Boolean(msg.synthetic) });
		await handler.run({
			msg, args, rest,
			isAdmin: this.opts.isAdmin(msg),
			...this.opts.replier(msg),
			buttonCtx: { chatType: msg.chatType, threadId: msg.threadId, ownerOpenId: msg.senderId },
		});
		return true;
	}
}
