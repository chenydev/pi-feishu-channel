/**
 * 卡片回调路由：按按钮值里的 `op` 查表分发。
 *
 * 各模块用 `register(owner, ops)` 登记自己处理的 op；两个模块登记同一个 op 时直接抛错
 * （日志 `feishu.card.op_conflict`），让冲突在启动时暴露，而不是在用户点按钮时静默走错分支。
 *
 * 分发前统一做两件事：
 * - 回调 token 去重（飞书重投同一次点击时不重复执行）；
 * - 标记为 `sessionScoped` 的 op 走会话类按钮的授权（见 `authorizeSessionCardAction`）。
 */
import type { CardAction } from "../inbound/transport.js";
import { CardTokenDedupe, authorizeSessionCardAction } from "./card-actions.js";

export type CardOpHandler = (action: CardAction, value: Record<string, unknown>) => unknown | Promise<unknown>;

export interface CardOpSpec {
	run: CardOpHandler;
	/** 会改会话状态的按钮：只允许卡片发起人或管理员，且点击所在的群要与卡片所属会话一致。 */
	sessionScoped?: boolean;
}

export type CardOps = Record<string, CardOpHandler | CardOpSpec>;

export interface CardRouterLog {
	info(msg: string, meta?: unknown): void;
	warn(msg: string, meta?: unknown): void;
	error(msg: string, meta?: unknown): void;
}

export class CardOpConflictError extends Error {
	constructor(readonly op: string, readonly owners: [string, string]) {
		super(`卡片 op "${op}" 被重复登记：${owners.join(" 与 ")}`);
	}
}

export class CardRouter {
	private readonly routes = new Map<string, { owner: string; spec: CardOpSpec }>();
	private readonly tokens: CardTokenDedupe;

	constructor(private readonly opts: { log: CardRouterLog; admins: () => readonly string[]; tokens?: CardTokenDedupe }) {
		this.tokens = opts.tokens ?? new CardTokenDedupe();
	}

	/** 登记一组 op。与已登记的 op 重名时抛 `CardOpConflictError`，本组一个都不登记。 */
	register(owner: string, ops: CardOps): this {
		for (const op of Object.keys(ops)) {
			const existing = this.routes.get(op);
			if (existing) {
				this.opts.log.error("feishu.card.op_conflict", { op, owners: [existing.owner, owner] });
				throw new CardOpConflictError(op, [existing.owner, owner]);
			}
		}
		for (const [op, handler] of Object.entries(ops)) {
			this.routes.set(op, { owner, spec: typeof handler === "function" ? { run: handler } : handler });
		}
		return this;
	}

	/** 已登记的 op 及其所属模块（诊断与测试用）。 */
	ops(): Record<string, string> {
		return Object.fromEntries([...this.routes].map(([op, route]) => [op, route.owner]));
	}

	/** 处理一次卡片回调；返回给飞书的应答（toast / 新卡片），不处理时返回 undefined。 */
	async handle(action: CardAction): Promise<unknown> {
		const value = action.value ?? {};
		const op = typeof value.op === "string" ? value.op : null;
		this.opts.log.info("feishu.card.action", {
			messageId: action.messageId, op, operator: action.operatorOpenId, hasValue: action.value !== undefined,
		});
		if (!this.tokens.accept(action.token)) {
			this.opts.log.info("feishu.card.duplicate_token", { messageId: action.messageId });
			return undefined;
		}
		const route = op ? this.routes.get(op) : undefined;
		if (!route) return undefined;
		if (route.spec.sessionScoped) {
			const denied = authorizeSessionCardAction(action, value, this.opts.admins());
			if (denied) {
				this.opts.log.warn("feishu.card.unauthorized", { op, operator: action.operatorOpenId, reason: denied });
				return { toast: { type: "warning", content: denied } };
			}
		}
		return route.spec.run(action, value);
	}
}
