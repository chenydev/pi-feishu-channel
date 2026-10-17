/**
 * `/healthz` + `/metrics`：给外部探活与监控用的 HTTP 端点（默认关闭）。
 *
 * 为什么要它：`status.json` 只有本机读得到，Kubernetes 探针、Prometheus、巡检脚本都拿不到它。
 * 这里的两个端点直接复用它已经算好的数据 —— 不新增统计口径，避免「面板和 status.json 对不上」。
 *
 * 默认只绑 `127.0.0.1`（容器里要暴露就配 `metrics.host: "0.0.0.0"`）：这是没有任何鉴权的端点，
 * 绑到公网等于把内部状态公开。端点只输出计数与枚举，不含消息内容、open_id、token。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BridgeFeature } from "./feature.js";

/** 探活判据：status.json 的更新时间超过这个值就算「心跳停了」。 */
const STALE_FACTOR = 3;

export interface ProbePayload {
	ok: boolean;
	connState: string;
	uptimeMs: number;
	statusAgeMs?: number;
	heartbeatMs: number;
	reconnectsLast5m: number;
	outboxDepth: number;
	pendingApprovals: number;
}

/**
 * 探活结果。`ok` 为 false 时端点返回 503 —— 探针只看状态码就能工作。
 *
 * 判据只挑「真的不能用」的情形：断线、心跳停了（进程卡住/单实例锁被抢）。
 * 发送队列积压和待审批多属于「慢」不是「坏」，放进 payload 供人看，不参与 ok。
 */
export function evaluateProbe(input: {
	connState: string;
	now: number;
	updatedAt?: number;
	heartbeatMs: number;
	uptimeMs: number;
	reconnectsLast5m: number;
	outboxDepth: number;
	pendingApprovals: number;
}): ProbePayload {
	const statusAgeMs = input.updatedAt === undefined ? undefined : Math.max(0, input.now - input.updatedAt);
	const stale = statusAgeMs !== undefined && statusAgeMs > input.heartbeatMs * STALE_FACTOR;
	return {
		ok: input.connState === "connected" && !stale,
		connState: input.connState,
		uptimeMs: input.uptimeMs,
		...(statusAgeMs === undefined ? {} : { statusAgeMs }),
		heartbeatMs: input.heartbeatMs,
		reconnectsLast5m: input.reconnectsLast5m,
		outboxDepth: input.outboxDepth,
		pendingApprovals: input.pendingApprovals,
	};
}

/** Prometheus 文本格式（只输出计数/枚举；标签值里的特殊字符要转义）。 */
export function renderMetrics(payload: ProbePayload, extra: { messageTotal: number; messageDropped: number; conversations: number; unhandledRejections: number; outboxFailed: number }): string {
	const escapeLabel = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const lines = [
		"# HELP feishu_bridge_up 桥是否可用（1 = 连接正常且心跳未过期）",
		"# TYPE feishu_bridge_up gauge",
		`feishu_bridge_up ${payload.ok ? 1 : 0}`,
		"# HELP feishu_bridge_conn_state 连接状态（标签值：connected/connecting/disconnected/error）",
		"# TYPE feishu_bridge_conn_state gauge",
		`feishu_bridge_conn_state{state="${escapeLabel(payload.connState)}"} 1`,
		"# HELP feishu_bridge_uptime_seconds 进程运行时长",
		"# TYPE feishu_bridge_uptime_seconds gauge",
		`feishu_bridge_uptime_seconds ${(payload.uptimeMs / 1000).toFixed(1)}`,
		"# HELP feishu_bridge_status_age_seconds status.json 距今多久（心跳停了会一直涨）",
		"# TYPE feishu_bridge_status_age_seconds gauge",
		`feishu_bridge_status_age_seconds ${((payload.statusAgeMs ?? 0) / 1000).toFixed(1)}`,
		"# HELP feishu_bridge_reconnects_5m 近 5 分钟重连次数",
		"# TYPE feishu_bridge_reconnects_5m gauge",
		`feishu_bridge_reconnects_5m ${payload.reconnectsLast5m}`,
		"# HELP feishu_bridge_outbox_pending 待投递条数",
		"# TYPE feishu_bridge_outbox_pending gauge",
		`feishu_bridge_outbox_pending ${payload.outboxDepth}`,
		"# HELP feishu_bridge_outbox_failed 永久失败的投递条数",
		"# TYPE feishu_bridge_outbox_failed gauge",
		`feishu_bridge_outbox_failed ${extra.outboxFailed}`,
		"# HELP feishu_bridge_pending_approvals 未决审批数",
		"# TYPE feishu_bridge_pending_approvals gauge",
		`feishu_bridge_pending_approvals ${payload.pendingApprovals}`,
		"# HELP feishu_bridge_conversations 活跃会话数",
		"# TYPE feishu_bridge_conversations gauge",
		`feishu_bridge_conversations ${extra.conversations}`,
		"# HELP feishu_bridge_messages_total 收到的消息总数",
		"# TYPE feishu_bridge_messages_total counter",
		`feishu_bridge_messages_total ${extra.messageTotal}`,
		"# HELP feishu_bridge_messages_dropped 被准入丢弃的消息数",
		"# TYPE feishu_bridge_messages_dropped counter",
		`feishu_bridge_messages_dropped ${extra.messageDropped}`,
		"# HELP feishu_bridge_unhandled_rejections 进程级兜底拦下的未处理 rejection 数",
		"# TYPE feishu_bridge_unhandled_rejections counter",
		`feishu_bridge_unhandled_rejections ${extra.unhandledRejections}`,
	];
	return `${lines.join("\n")}\n`;
}

export interface ProbeServerOptions {
	host: string;
	port: number;
	/** 每次请求现算（不要缓存：探针问的就是「现在」）。 */
	snapshot(): { probe: ProbePayload; metrics?: { messageTotal: number; messageDropped: number; conversations: number; unhandledRejections: number; outboxFailed: number } };
	log: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

/** 起一个只读 HTTP 服务；端口占用等失败只记日志，不影响桥本身。 */
export function startProbeServer(options: ProbeServerOptions): { server: Server; listening: Promise<void>; close(): Promise<void> } {
	const respond = (req: IncomingMessage, res: ServerResponse): void => {
		const url = (req.url ?? "/").split("?")[0];
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }).end("method not allowed\n");
			return;
		}
		if (url === "/healthz") {
			const { probe } = options.snapshot();
			res.writeHead(probe.ok ? 200 : 503, { "content-type": "application/json; charset=utf-8" }).end(`${JSON.stringify(probe)}\n`);
			return;
		}
		if (url === "/metrics") {
			const { probe, metrics } = options.snapshot();
			const text = renderMetrics(probe, metrics ?? { messageTotal: 0, messageDropped: 0, conversations: 0, unhandledRejections: 0, outboxFailed: 0 });
			res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(text);
			return;
		}
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
	};

	const server = createServer((req, res) => {
		try {
			respond(req, res);
		} catch (error) {
			// 端点自身的失败不能让桥崩：回 500 并记一条
			options.log.warn("feishu.metrics.render_failed", { error: error instanceof Error ? error.message : String(error) });
			try { res.writeHead(500).end("error\n"); } catch { /* 连接已断 */ }
		}
	});
	server.on("error", (error) => {
		options.log.warn("feishu.metrics.listen_failed", { host: options.host, port: options.port, error: error.message });
	});
	const listening = new Promise<void>((resolve) => {
		server.listen(options.port, options.host, () => {
			const address = server.address();
			options.log.info("feishu.metrics.listening", {
				host: options.host,
				port: typeof address === "object" && address ? address.port : options.port,
				endpoints: ["/healthz", "/metrics"],
			});
			resolve();
		});
	});
	server.unref?.();
	return {
		server,
		listening,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

export const httpProbeFeature: BridgeFeature = {
	name: "httpProbe",
	enabled: (config) => config.metrics?.enabled === true,
	setup({ rt, log, reconnectsLast5m }) {
		let handle: ReturnType<typeof startProbeServer> | undefined;
		const snapshot = (): { probe: ProbePayload } => {
			// 直接用最近一次心跳写入的状态：探针问的是「现在还能不能用」，
			// 自己再 update 一次会把 updatedAt 刷新，反而看不出心跳停过
			const status = rt.status;
			return {
				probe: evaluateProbe({
					connState: status.connState,
					now: Date.now(),
					updatedAt: status.updatedAt,
					heartbeatMs: rt.config.statusHeartbeatMs ?? 30_000,
					uptimeMs: Math.round(process.uptime() * 1_000),
					reconnectsLast5m: reconnectsLast5m(),
					outboxDepth: status.outboxDepth,
					pendingApprovals: status.pendingApprovals ?? 0,
				}),
			};
		};
		return {
			start() {
				handle = startProbeServer({
					host: rt.config.metrics?.host ?? "127.0.0.1",
					port: rt.config.metrics?.port ?? 8787,
					log,
					snapshot: () => {
						const { probe } = snapshot();
						const status = rt.status;
						return {
							probe,
							metrics: {
								messageTotal: status.messageTotal,
								messageDropped: status.messageDropped,
								conversations: status.conversations,
								unhandledRejections: rt.unhandledRejections,
								outboxFailed: status.outbox.failed,
							},
						};
					},
				});
			},
			async stop() {
				await handle?.close();
				handle = undefined;
			},
		};
	},
};
