/**
 * PS 父会话转发的起停（approval/ps-forwarding-sync.ts）：环境变量声明/撤回与应答方起停。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PsForwardingSync } from "../src/approval/ps-forwarding-sync.js";
import { PS_FORWARDING_PARENT_ENV_KEYS } from "../src/approval/ps-forwarding.js";
import type { PermissionBridge } from "../src/approval/permission-bridge.js";
import { BridgeRuntime } from "../src/runtime/bridge-runtime.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../src/types.js";

function setup(approval: Partial<BridgeConfig["approval"]>, psInstalled = true) {
	const dir = mkdtempSync(join(tmpdir(), "ps-sync-"));
	const rt = new BridgeRuntime();
	rt.homeDir = dir;
	rt.config = { ...DEFAULT_CONFIG, approval: { ...DEFAULT_CONFIG.approval, ...approval } };
	const logs: string[] = [];
	const push = (m: string) => { logs.push(m); };
	const sync = new PsForwardingSync({ rt, log: { debug: push, info: push, warn: push, error: push }, psInstalled: () => psInstalled, agentDir: () => dir });
	const cleanup = () => {
		for (const key of PS_FORWARDING_PARENT_ENV_KEYS) delete process.env[key];
		rmSync(dir, { recursive: true, force: true });
	};
	return { rt, sync, logs, cleanup };
}

const PS = { policyEngine: "pi-permission-system" as const, forwarding: { enabled: true, parentSessionId: "parent-x" } };

test("PS 转发：开启时声明父会话环境变量，关闭时只撤回自己声明的值", async () => {
	const { rt, sync, logs, cleanup } = setup(PS);
	try {
		sync.syncEnv();
		for (const key of PS_FORWARDING_PARENT_ENV_KEYS) assert.equal(process.env[key], "parent-x");
		assert.ok(logs.includes("feishu.approval.ps_forwarding_env"));
		rt.config = { ...rt.config, approval: { ...rt.config.approval, forwarding: { enabled: false } } };
		sync.syncEnv();
		for (const key of PS_FORWARDING_PARENT_ENV_KEYS) assert.equal(process.env[key], undefined);
	} finally { cleanup(); }
});

test("PS 转发：引擎不是 PS 时不生效并告警；PS 未安装时报错且不声明", () => {
	const blocked = setup({ forwarding: { enabled: true } });
	try {
		blocked.sync.syncEnv();
		assert.ok(blocked.logs.includes("feishu.approval.ps_forwarding_inactive"));
		for (const key of PS_FORWARDING_PARENT_ENV_KEYS) assert.equal(process.env[key], undefined);
	} finally { blocked.cleanup(); }
	const missing = setup(PS, false);
	try {
		missing.sync.syncEnv();
		assert.ok(missing.logs.includes("feishu.approval.ps_forwarding_unavailable"));
		for (const key of PS_FORWARDING_PARENT_ENV_KEYS) assert.equal(process.env[key], undefined);
	} finally { missing.cleanup(); }
});

test("PS 转发：应答方在审批组件就位后才起，父会话 id 不变时复用，关闭后停止", async () => {
	const { rt, sync, cleanup } = setup(PS);
	try {
		await sync.syncServer();
		assert.equal(rt.psForwarding, undefined, "没有 PermissionBridge 时不起");
		rt.permissionBridge = {} as PermissionBridge;
		await sync.syncServer();
		const first = rt.psForwarding;
		assert.ok(first);
		assert.equal(rt.psForwardingParentId, "parent-x");
		assert.ok(rt.alwaysApproved, "默认开启「始终批准」规则表");
		await sync.syncServer();
		assert.equal(rt.psForwarding, first, "父会话 id 不变时复用");
		rt.config = { ...rt.config, approval: { ...rt.config.approval, forwarding: { enabled: false } } };
		await sync.syncServer();
		assert.equal(rt.psForwarding, undefined);
		assert.equal(rt.psForwardingParentId, undefined);
	} finally { cleanup(); }
});
