import assert from "node:assert/strict";
import { test } from "node:test";
import { AlertMonitor, DEFAULT_ALERT_OPTIONS, type HealthSnapshot } from "../src/runtime/alerts.js";

const base = (patch: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
	now: 0, reconnectsLast5m: 0, failedFinals: 0, pendingApprovals: 0, compensationErrors: 0, ...patch,
});

test("告警：断线超过阈值告警一次，冷却期内不重复，恢复时补一条", () => {
	const monitor = new AlertMonitor();
	assert.deepEqual(monitor.evaluate(base({ now: 60_000, downSince: 0 })), []);
	const fired = monitor.evaluate(base({ now: 130_000, downSince: 0 }));
	assert.equal(fired.length, 1);
	assert.match(fired[0].text, /已断线 2 分钟/);
	assert.deepEqual(monitor.evaluate(base({ now: 600_000, downSince: 0 })), [], "冷却期内不重复");
	const recovered = monitor.evaluate(base({ now: 700_000 }));
	assert.equal(recovered.length, 1);
	assert.equal(recovered[0].recovered, true);
	assert.match(recovered[0].text, /已重新连接/);
});

test("告警：冷却期过后仍未恢复则再提醒", () => {
	const monitor = new AlertMonitor();
	monitor.evaluate(base({ now: 0, reconnectsLast5m: 12 }));
	assert.equal(monitor.evaluate(base({ now: DEFAULT_ALERT_OPTIONS.cooldownMs, reconnectsLast5m: 12 })).length, 1);
});

test("告警：累计失败只对新增告警，启动时的存量不算", () => {
	const monitor = new AlertMonitor();
	assert.deepEqual(monitor.evaluate(base({ failedFinals: 3 })), [], "存量");
	const fired = monitor.evaluate(base({ now: 1, failedFinals: 4 }));
	assert.equal(fired.length, 1);
	assert.match(fired[0].text, /1 条回复永久发送失败/);
	// 没有新增 → 恢复（累计类告过一次即视为已知）
	const next = monitor.evaluate(base({ now: 2, failedFinals: 4 }));
	assert.equal(next.length, 1);
	assert.equal(next[0].recovered, true);
});

test("告警：审批积压按条数或最长等待", () => {
	const monitor = new AlertMonitor();
	assert.equal(monitor.evaluate(base({ pendingApprovals: 1, oldestApprovalAgeMs: 200_000 })).length, 1);
	const other = new AlertMonitor();
	assert.equal(other.evaluate(base({ pendingApprovals: 5 })).length, 1);
	assert.equal(new AlertMonitor().evaluate(base({ pendingApprovals: 2, oldestApprovalAgeMs: 10_000 })).length, 0);
});
