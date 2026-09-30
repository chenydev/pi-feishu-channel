/**
 * 可选能力插件。
 *
 * 每项默认关闭的能力实现一个 `BridgeFeature`：
 * - `enabled(config)` 为 false 时不调用 `setup`，不创建任何对象、不登记任何东西；
 * - `setup` 在读完配置之后、装配核心组件之前调用，返回该能力的挂接点（`FeatureHooks`）；
 * - 能力之间不互相 import，只通过 `BridgeRuntime` 与 `FeatureContext` 通信。
 *
 * `FeatureHost` 负责按开关调用 `setup`、把命令与卡片按钮登记到分发器上，并在桥停止时注销。
 */
import type { CommandDispatcher, CommandHandler, CommandInterceptor, CommandReplier } from "../commands/dispatch.js";
import type { LifecycleEvent } from "../inbound/transport.js";
import type { CardOps, CardRouter } from "../interaction/card-router.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { BridgeLogger } from "../runtime/logger.js";
import type { BridgeConfig, FeishuInboundMessage } from "../types.js";

/** 能力可用的桥服务（由入口提供）。 */
export interface FeatureContext {
	rt: BridgeRuntime;
	log: BridgeLogger;
	/** 给某条消息回执（文本走持久化发送队列）。 */
	replier(msg: FeishuInboundMessage): CommandReplier;
	/** 近 5 分钟的重连次数。 */
	reconnectsLast5m(): number;
}

export interface FeatureHooks {
	/** 斜杠命令（命令名必须已在 commands/registry.ts 里登记）。 */
	commands?: Record<string, CommandHandler>;
	/** 先于命令解析的输入拦截（如 `!<命令>`）。 */
	commandInterceptor?: CommandInterceptor;
	/** 卡片按钮。 */
	cardOps?: CardOps;
	/** 飞书连接与发送队列就绪后调用。 */
	start?(): void | Promise<void>;
	/** 桥停止时调用。 */
	stop?(): void | Promise<void>;
	/** 平台生命周期事件（撤回、入群、评论、会议邀请等），每个能力都会收到。 */
	onLifecycleEvent?(event: LifecycleEvent): void | Promise<void>;
	/** 状态心跳（默认每 30 秒，刷新 status.json 之后）。 */
	onHeartbeat?(): void | Promise<void>;
	/** `/feishu status` 里追加的行。 */
	statusLines?(): string[];
}

export interface BridgeFeature {
	/** 能力名：出现在 `status.json` 的 `features` 与启动日志里，是对外契约。 */
	readonly name: string;
	enabled(config: BridgeConfig): boolean;
	setup(ctx: FeatureContext): FeatureHooks | Promise<FeatureHooks>;
	/** 关闭时仍要回应的命令（告诉用户该能力未开启），与迁移前关闭时的行为保持一致。 */
	disabledCommands?: Record<string, CommandHandler>;
}

export class FeatureHost {
	private active: Array<{ name: string; hooks: FeatureHooks }> = [];
	private owners: string[] = [];

	constructor(
		private readonly features: readonly BridgeFeature[],
		private readonly opts: { dispatcher: CommandDispatcher; cardRouter: CardRouter; log: BridgeLogger },
	) {}

	/** 按当前配置装配能力；重复调用前必须先 `stop()`。 */
	async setup(ctx: FeatureContext): Promise<void> {
		for (const feature of this.features) {
			const owner = `feature:${feature.name}`;
			if (!feature.enabled(ctx.rt.config)) {
				if (feature.disabledCommands) {
					this.opts.dispatcher.register(owner, feature.disabledCommands);
					this.owners.push(owner);
				}
				continue;
			}
			const hooks = await feature.setup(ctx);
			this.owners.push(owner);
			if (hooks.commands) this.opts.dispatcher.register(owner, hooks.commands);
			if (hooks.commandInterceptor) this.opts.dispatcher.intercept(owner, hooks.commandInterceptor);
			if (hooks.cardOps) this.opts.cardRouter.register(owner, hooks.cardOps);
			this.active.push({ name: feature.name, hooks });
		}
	}

	/** 已装配的能力名（按登记顺序）。 */
	names(): string[] {
		return this.active.map((feature) => feature.name);
	}

	/** 取第一个提供了某个挂接点的能力的实现。 */
	first<K extends keyof FeatureHooks>(key: K): FeatureHooks[K] | undefined {
		return this.active.find((feature) => feature.hooks[key] !== undefined)?.hooks[key];
	}

	async start(): Promise<void> {
		for (const { name, hooks } of this.active) {
			try {
				await hooks.start?.();
			} catch (error) {
				this.opts.log.warn("feishu.feature.start_failed", { feature: name, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	async onLifecycleEvent(event: LifecycleEvent): Promise<void> {
		for (const { hooks } of this.active) await hooks.onLifecycleEvent?.(event);
	}

	async heartbeat(): Promise<void> {
		for (const { name, hooks } of this.active) {
			try {
				await hooks.onHeartbeat?.();
			} catch (error) {
				this.opts.log.warn("feishu.feature.heartbeat_failed", { feature: name, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	statusLines(): string[] {
		return this.active.flatMap(({ hooks }) => hooks.statusLines?.() ?? []);
	}

	/** 停止全部能力并注销它们登记的命令与按钮。 */
	async stop(): Promise<void> {
		for (const { name, hooks } of this.active.reverse()) {
			try {
				await hooks.stop?.();
			} catch (error) {
				this.opts.log.warn("feishu.feature.stop_failed", { feature: name, error: error instanceof Error ? error.message : String(error) });
			}
		}
		for (const owner of this.owners) {
			this.opts.dispatcher.unregister(owner);
			this.opts.cardRouter.unregister(owner);
		}
		this.active = [];
		this.owners = [];
	}
}
