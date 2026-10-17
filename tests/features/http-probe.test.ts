/**
 * 探活与指标端点：Kubernetes 探针只看状态码；Prometheus 只认文本格式。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateProbe, renderMetrics, startProbeServer } from "../../src/features/http-probe.js";

const base = {
	connState: "connected", now: 1_000, updatedAt: 900, heartbeatMs: 30_000,
	uptimeMs: 5_000, reconnectsLast5m: 0, outboxDepth: 2, pendingApprovals: 1,
};

test("探活：连接正常且心跳新鲜 → ok；断线或心跳过期 → 不 ok", () => {
	assert.equal(evaluateProbe(base).ok, true);
	assert.equal(evaluateProbe({ ...base, connState: "disconnected" }).ok, false);
	// 心跳 30s，超过 3 倍（90s）判过期
	assert.equal(evaluateProbe({ ...base, now: 900 + 89_000 }).ok, true);
	assert.equal(evaluateProbe({ ...base, now: 900 + 91_000 }).ok, false, "心跳停了要判不健康（进程卡住/锁被抢）");
	// 积压和待审批只是「慢」，不参与 ok
	assert.equal(evaluateProbe({ ...base, outboxDepth: 999, pendingApprovals: 99 }).ok, true);
});

test("指标：Prometheus 文本格式合法（每行 name value），无样本时不编 0", () => {
	const payload = evaluateProbe(base);
	const text = renderMetrics(payload, { messageTotal: 12, messageDropped: 3, conversations: 2, unhandledRejections: 1, outboxFailed: 0 });
	const dataLines = text.split("\n").filter((line) => line && !line.startsWith("#"));
	assert.ok(dataLines.length >= 8);
	for (const line of dataLines) assert.match(line, /^[a-z_]+\{?[^}]*\}? -?\d+(\.\d+)?$/, `格式不对：${line}`);
	assert.match(text, /^feishu_bridge_up 1$/m);
	assert.match(text, /^feishu_bridge_messages_dropped 3$/m);
	assert.match(text, /^feishu_bridge_unhandled_rejections 1$/m);
	// 连接状态作为标签；标签值要能安全放进引号
	assert.match(text, /feishu_bridge_conn_state\{state="connected"\} 1/);
});

test("指标：标签值里的引号与反斜杠要转义（不会把文本格式写坏）", () => {
	const text = renderMetrics(evaluateProbe({ ...base, connState: 'we"ird\\state' as never }), { messageTotal: 0, messageDropped: 0, conversations: 0, unhandledRejections: 0, outboxFailed: 0 });
	assert.match(text, /state="we\\"ird\\\\state"/);
});

test("端点：/healthz 用状态码表达健康、/metrics 返回文本、其它路径 404", async () => {
	const logs: string[] = [];
	const handle = startProbeServer({
		host: "127.0.0.1", port: 0, log: { info: (msg) => { logs.push(msg); }, warn: (msg) => { logs.push(msg); } },
		snapshot: () => ({
			probe: evaluateProbe(base),
			metrics: { messageTotal: 1, messageDropped: 0, conversations: 1, unhandledRejections: 0, outboxFailed: 0 },
		}),
	});
	try {
		await handle.listening;
		const address = handle.server?.address();
		assert.ok(address && typeof address === "object", "要能拿到监听端口");
		const origin = `http://127.0.0.1:${address.port}`;
		const health = await fetch(`${origin}/healthz`);
		assert.equal(health.status, 200);
		assert.equal((await health.json() as { ok: boolean }).ok, true);

		const metrics = await fetch(`${origin}/metrics`);
		assert.equal(metrics.status, 200);
		assert.match(await metrics.text(), /feishu_bridge_up 1/);

		assert.equal((await fetch(`${origin}/nope`)).status, 404);
		assert.equal((await fetch(`${origin}/healthz`, { method: "POST" })).status, 405);
	} finally {
		await handle.close();
	}
});
