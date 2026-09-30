/**
 * 桥的生命周期：启动、停止、状态心跳、断线补收与受控重连。
 *
 * 启动顺序（任何一步失败都回滚到未启动状态）：
 * 1. 声明 PS 父会话环境变量 → 拿单实例锁；
 * 2. 装配可选能力 → 装配核心组件 → 连上飞书、启动发送队列；
 * 3. 起 PS 转发应答方（失败不阻塞）→ 空闲会话回收 → 收紧会话文件权限 → 状态心跳 → 启动可选能力；
 * 4. 查询应用归属人与协作者 → 日志 `feishu.bridge.features`、`bridge started`。
 *
 * 启动与停止串行执行（`/feishu:restart`、SIGTERM 与 session_shutdown 可能同时到达）。
 */
import type { PsForwardingSync } from "../approval/ps-forwarding-sync.js";
import { resolveAppLockFile, resolvePaths } from "../config.js";
import type { FeatureContext, FeatureHost } from "../features/feature.js";
import { enabledFeatures } from "../features/switches.js";
import { AppLock } from "./app-lock.js";
import { loadAppAdmins } from "./app-admins.js";
import type { BridgeRuntime } from "./bridge-runtime.js";
import { compensateKnownChats } from "./history-compensation.js";
import type { BridgeLogger } from "./logger.js";
import { ReconnectSupervisor } from "./reconnect-supervisor.js";
import { tightenSessionPermissions } from "./retention.js";
import type { StatusReporter } from "./status-reporter.js";

export interface LifecycleDeps {
	rt: BridgeRuntime;
	log: BridgeLogger;
	status: StatusReporter;
	features: FeatureHost;
	psForwardingSync: PsForwardingSync;
	/** 可选能力的上下文。 */
	featureContext(): FeatureContext;
	/** 装配核心组件（见 assemble.ts）。 */
	assemble(): Promise<void>;
}

export class BridgeLifecycle {
	private readonly supervisor: ReconnectSupervisor;
	private readonly watchdog: ReturnType<typeof setInterval>;

	constructor(private readonly deps: LifecycleDeps) {
		const { rt, log, status } = deps;
		// 受控重连（指数退避 + 抖动，1s → 60s）；watchdog 每秒巡检，握手宽限期 15s。
		// 细节与 2026-09 重连风暴的根因见 runtime/reconnect-supervisor.ts。
		this.supervisor = new ReconnectSupervisor({
			isActive: () => rt.started && !rt.stopping,
			target: () => rt.transport,
			// getter：supervisor 在 session_start 加载配置之前就构造了
			get selfHealMaxMs() { return rt.config.transport?.selfHealMaxMs; },
			onScheduled: (attempt, delay) => {
				status.setUi("conn", `飞书桥重连中（第 ${attempt} 次）`);
				log.warn("transport reconnect scheduled", { attempts: attempt, delay: Math.round(delay) });
			},
			onError: (err) => {
				rt.lastError = err instanceof Error ? err.message : String(err);
				rt.reportedConnState = "error";
				rt.downSince ??= Date.now();
				log.error("reconnect failed", { error: rt.lastError });
				status.update();
			},
		});
		this.watchdog = setInterval(() => this.supervisor.tick(), 1_000);
		this.watchdog.unref?.();
	}

	/** 重连计数（累计 / 近 5 分钟）。 */
	reconnects(): { total: number; last5m: number } {
		return { total: this.supervisor.totalReconnects, last5m: this.supervisor.reconnectsInWindow() };
	}

	/** 飞书长连接状态变化：恢复连接时补收断线期间的消息。 */
	onConnState(connState: string): void {
		const { rt, status } = this.deps;
		const outageStartedAt = rt.downSince;
		rt.reportedConnState = connState === "connected" ? "connected" : connState === "error" ? "error" : "connecting";
		if (rt.reportedConnState === "connected") {
			rt.downSince = undefined;
			rt.lastError = undefined;
			if (outageStartedAt) void this.compensateMissed(outageStartedAt);
		} else {
			// error（SDK 终态）与 reconnecting（SDK 自动重连中）都算断线：补收窗口从第一次掉线算起
			rt.downSince ??= Date.now();
		}
		status.setUi("conn", connState === "connected" ? "飞书桥已连接" : connState === "reconnecting" ? "飞书桥重连中（SDK）" : `飞书桥 ${connState}`);
		status.update();
	}

	start(): Promise<string> {
		return this.serialize(() => this.startUnlocked());
	}

	stop(): Promise<string> {
		return this.serialize(() => this.stopUnlocked());
	}

	/** pi 会话结束：停止重连巡检并停桥。 */
	async dispose(): Promise<void> {
		this.deps.rt.stopping = true;
		this.supervisor.cancel();
		clearInterval(this.watchdog);
		await this.stop();
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const { rt } = this.deps;
		const run = rt.lifecycleTail.then(operation, operation);
		rt.lifecycleTail = run.then(() => undefined, () => undefined);
		return run;
	}

	private async startUnlocked(): Promise<string> {
		const { rt, log, status, features, psForwardingSync } = this.deps;
		if (rt.started) return "already";
		// 父子声明要在任何桥会话创建之前落地（PS 每次工具调用时实时读进程环境）
		psForwardingSync.syncEnv();
		try {
			rt.appLock = AppLock.acquire(resolveAppLockFile(rt.homeDir, rt.config.appId), rt.config.appId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			rt.lastError = message;
			rt.reportedConnState = "error";
			// 锁由其他实例持有时不能覆盖 owner 的共享 status.json。
			status.setUi("bridge", `飞书桥启动失败: ${message.slice(0, 60)}`);
			return `启动失败：${message}`;
		}
		rt.started = true;
		rt.stopping = false;
		rt.reportedConnState = "connecting";
		rt.lastError = undefined;
		rt.status.startedAt = Date.now();
		status.update();
		try {
			await features.setup(this.deps.featureContext());
			await this.deps.assemble();
			await rt.transport!.start();
			rt.outbox!.start();
			// 转发应答方要等 transport/outbox 就绪（弹卡要发得出去）。失败不阻塞桥启动：
			// 转发只是审批的升级路径，没起来退化成 PS 自己的判定（无人应答 → 拒绝）。
			try {
				await psForwardingSync.syncServer();
			} catch (error) {
				log.warn("feishu.approval.ps_forwarding_start_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			// 空闲会话回收巡检（无 active run/排队/审批且超 TTL 才回收句柄）
			rt.convManager?.startLifecycle();
			// 会话文件权限；status 心跳（含可选能力的心跳挂接点，如告警）
			this.tightenSessions();
			this.startHeartbeat();
			// 可选能力（定时任务等）在连接与发送队列就绪后启动
			await features.start();
			await loadAppAdmins(rt, log);
			status.setUi("conn", "飞书桥启动中…");
			status.setUi("bridge", "飞书桥已启动");
			log.info("feishu.bridge.features", { enabled: enabledFeatures(rt.config) });
			log.info("bridge started", { bot: rt.transport?.getBotIdentity() });
			status.update();
			return "started";
		} catch (err) {
			rt.started = false;
			await features.stop().catch(() => undefined);
			const msg = err instanceof Error ? err.message : String(err);
			rt.lastError = msg;
			rt.reportedConnState = "error";
			rt.appLock?.release();
			rt.appLock = undefined;
			log.error("bridge start failed", { error: msg });
			status.setUi("bridge", `飞书桥启动失败: ${msg.slice(0, 60)}`);
			status.update();
			return `启动失败：${msg}`;
		}
	}

	private async stopUnlocked(): Promise<string> {
		const { rt, log, status, features } = this.deps;
		rt.stopping = true;
		this.supervisor.cancel();
		this.stopHeartbeat();
		await features.stop();
		try {
			rt.permissionBridge?.shutdown();
			// 先停应答方：未决的转发请求已被 shutdown() 判拒绝，等它们把响应写完再撤心跳，
			// 否则子会话要等满 10 分钟才知道没人服务。
			await rt.psForwarding?.stop();
			// 入站在后台处理，先给在途消息一个有时限的收尾窗口（写进待处理记录后重启可恢复）
			try {
				await Promise.race([rt.transport?.drainInbound(), new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
			} catch { /* best effort */ }
			try { await rt.pipeline?.stop(); } catch { /* best effort */ }
			// 先停空闲回收巡检，避免关闭过程中回收句柄
			rt.convManager?.stopLifecycle();
			// 未决提问全部失效（不假装重启后能恢复）
			const clarifyCancelled = rt.clarificationStore?.shutdown() ?? 0;
			if (clarifyCancelled > 0) log.info("feishu.clarify.shutdown", { cancelled: clarifyCancelled });
			try { await rt.convManager?.shutdown(); } catch { /* best effort */ }
			try { await rt.outbox?.stop(); } catch { /* best effort */ }
			try {
				await rt.transport?.stop();
			} catch {
				/* ignore */
			}
		} finally {
			rt.started = false;
			rt.reportedConnState = "disconnected";
			rt.downSince = undefined;
			rt.appLock?.release();
			rt.appLock = undefined;
			status.update();
			status.setUi("bridge", "飞书桥已停止");
		}
		return "stopped";
	}

	/** 断线恢复后补收断线期间的消息（同一时刻只跑一轮）。 */
	private async compensateMissed(outageStartedAt: number): Promise<void> {
		const { rt, log, status } = this.deps;
		if (rt.compensationPromise) return rt.compensationPromise;
		rt.compensationPromise = (async () => {
			const endTime = Date.now();
			const result = await compensateKnownChats({
				chatIds: rt.knownChats?.values() ?? [],
				outageStartedAt,
				now: endTime,
				maxWindowMs: 5 * 60_000,
				maxPerChat: 50,
				list: (chatId, startTime, finishTime, limit) => rt.transport?.listChatHistory(chatId, startTime, finishTime, limit) ?? Promise.resolve([]),
				handle: (message) => rt.pipeline?.handle(message) ?? Promise.resolve(),
				onError: (chatId, error) => log.warn("history compensation failed", { chatId, error: error instanceof Error ? error.message : String(error) }),
			});
			rt.compensatedMessages += result.recovered;
			rt.compensationErrors += result.errors;
			rt.compensationTruncated += result.truncatedChats + (result.windowTruncated ? 1 : 0);
			status.update();
		})();
		try {
			await rt.compensationPromise;
		} finally {
			rt.compensationPromise = undefined;
		}
	}

	/** 心跳 —— 定期刷新 status.json（健康但空闲的桥 mtime 也不会停），再调用可选能力的心跳挂接点。 */
	private startHeartbeat(): void {
		const { rt, status, features } = this.deps;
		const interval = rt.config.statusHeartbeatMs ?? 30_000;
		if (rt.heartbeatTimer || interval <= 0) return;
		rt.heartbeatTimer = setInterval(() => {
			status.update();
			void features.heartbeat();
		}, interval);
		rt.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		const { rt } = this.deps;
		if (rt.heartbeatTimer) clearInterval(rt.heartbeatTimer);
		rt.heartbeatTimer = undefined;
	}

	/** 启动时收紧会话文件权限（历史会话的归档由可选能力 retention 负责）。 */
	private tightenSessions(): void {
		const { rt, log } = this.deps;
		try {
			const tightened = tightenSessionPermissions(resolvePaths(rt.homeDir).sessionDir);
			if (tightened > 0) log.info("feishu.retention", { tightened, archived: 0 });
		} catch (error) {
			log.warn("feishu.retention_failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}
}
