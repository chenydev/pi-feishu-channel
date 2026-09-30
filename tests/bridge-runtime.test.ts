/**
 * BridgeRuntime：桥实例的全部可变状态集中在一个对象里，初始值与未启动时的行为一致。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeRuntime, initialStatus } from "../src/runtime/bridge-runtime.js";
import { DEFAULT_CONFIG } from "../src/types.js";

test("BridgeRuntime：初始状态为未启动、未连接、没有任何组件", () => {
	const rt = new BridgeRuntime();
	assert.equal(rt.started, false);
	assert.equal(rt.stopping, false);
	assert.equal(rt.config, DEFAULT_CONFIG);
	assert.equal(rt.homeDir, "");
	assert.equal(rt.reportedConnState, "disconnected");
	for (const key of ["transport", "pipeline", "convManager", "sender", "outbox", "permissionBridge", "psForwarding", "accessRequests"] as const) {
		assert.equal(rt[key], undefined, `${key} 未启动时应为 undefined`);
	}
	assert.deepEqual(rt.status, initialStatus());
	assert.equal(rt.status.connState, "disconnected");
});

test("BridgeRuntime：不同实例互不共享状态", () => {
	const a = new BridgeRuntime();
	const b = new BridgeRuntime();
	a.status.messageTotal = 5;
	a.compensatedMessages = 3;
	assert.equal(b.status.messageTotal, 0);
	assert.equal(b.compensatedMessages, 0);
	assert.notEqual(initialStatus(), initialStatus(), "每次返回新对象");
});
