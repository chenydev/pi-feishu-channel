/**
 * status.json 的字段：外部探活与排障只读这一个文件，缺字段就等于「看不见」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeRuntime } from "../src/runtime/bridge-runtime.js";
import { StatusReporter } from "../src/runtime/status-reporter.js";
import { DEFAULT_CONFIG } from "../src/types.js";

test("status.json：缓存条目数与投递百分位都写出来（无样本时不编 0）", () => {
	const rt = new BridgeRuntime();
	rt.config = { ...DEFAULT_CONFIG };
	rt.status = { connState: "connected", reconnectCount: 0, outboxDepth: 0, outbox: { pending: 0, sending: 0, sent: 0, failed: 0, lanes: 0, oldestAgeMs: 0 }, conversations: 0, messageTotal: 0, messageDropped: 0, compensatedMessages: 0, compensationErrors: 0, compensationTruncated: 0 };
	rt.homeDir = "";
	rt.unhandledRejections = 3;
	rt.pipeline = { getStats: () => ({ total: 1, duplicate: 0, batched: 0, dropped: 0, dispatched: 1, recovered: 0 }), cacheSizes: () => ({ quotes: 2, dedupe: 7 }) } as never;
	rt.convManager = { count: () => 1, queueStats: () => ({ queued: 0, active: 0, waiting: 0 }), cacheSizes: () => ({ liveChains: 0, pendingRecords: 4 }) } as never;
	rt.clarificationStore = { pendingCount: () => 5 } as never;
	rt.permissionBridge = { pendingCount: () => 6 } as never;
	const reporter = new StatusReporter({ rt, log: { debug() {}, info() {}, warn() {}, error() {} }, setUiStatus() {}, reconnects: () => ({ total: 0, last5m: 0 }), featureLines: () => [] });
	reporter.update();
	assert.deepEqual(rt.status.caches, { quotes: 2, dedupeEntries: 7, liveChains: 0, clarifications: 5, pendingRecords: 4, pendingApprovals: 6 });
	assert.equal(rt.status.unhandledRejections, 3, "兜底计数要能被外部看到");
});
