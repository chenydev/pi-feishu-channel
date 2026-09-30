/**
 * 生命周期（runtime/lifecycle.ts）：启动顺序、重复启停、启动失败回滚、启停串行。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PsForwardingSync } from "../src/approval/ps-forwarding-sync.js";
import { CommandDispatcher } from "../src/commands/dispatch.js";
import { FeatureHost } from "../src/features/feature.js";
import { CardRouter } from "../src/interaction/card-router.js";
import { BridgeRuntime } from "../src/runtime/bridge-runtime.js";
import { BridgeLifecycle } from "../src/runtime/lifecycle.js";
import { Onboarding } from "../src/runtime/onboarding.js";
import { StatusReporter } from "../src/runtime/status-reporter.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { startHarness } from "./integration/extension-harness.js";

const T = { timeout: 10_000 };

function unit(assemble: () => Promise<void>) {
	const rt = new BridgeRuntime();
	rt.homeDir = mkdtempSync(join(tmpdir(), "lifecycle-"));
	rt.config = { ...DEFAULT_CONFIG, appId: "cli_unit", appSecret: "s" };
	const events: string[] = [];
	const push = (m: string) => { events.push(m); };
	const log = { debug: push, info: push, warn: push, error: push };
	const replier = () => ({ reply() {}, trySendCard: async () => false });
	const features = new FeatureHost([], {
		dispatcher: new CommandDispatcher({ log, isAdmin: () => false, replier, piCommands: () => [] }),
		cardRouter: new CardRouter({ log, admins: () => [] }),
		log,
	});
	const lifecycle: BridgeLifecycle = new BridgeLifecycle({
		rt, log, features,
		status: new StatusReporter({ rt, log, setUiStatus() {}, reconnects: () => ({ total: 0, last5m: 0 }), featureLines: () => [] }),
		psForwardingSync: { syncEnv() { events.push("syncEnv"); }, async syncServer() {} } as unknown as PsForwardingSync,
		featureContext: () => ({ rt, log, onboarding: new Onboarding(rt, log), replier, sendLocalFile: () => ({ ok: true }), reconnectsLast5m: () => 0 }),
		assemble,
	});
	return { rt, lifecycle, events, cleanup: async () => { await lifecycle.dispose(); rmSync(rt.homeDir, { recursive: true, force: true }); } };
}

test("生命周期：装配失败时回滚到未启动，释放单实例锁，之后可以重新启动", async () => {
	let fail = true;
	const { rt, lifecycle, events, cleanup } = unit(async () => { if (fail) throw new Error("boom"); throw new Error("second"); });
	try {
		assert.equal(await lifecycle.start(), "启动失败：boom");
		assert.equal(rt.started, false);
		assert.equal(rt.appLock, undefined, "锁已释放");
		assert.equal(rt.reportedConnState, "error");
		assert.ok(events.includes("bridge start failed"));
		assert.equal(events[0], "syncEnv", "PS 父会话声明先于一切");
		fail = false;
		assert.equal(await lifecycle.start(), "启动失败：second", "锁释放后可以再次尝试启动");
	} finally { await cleanup(); }
});

test("生命周期：启停串行执行，同时到达的请求按顺序处理", async () => {
	const order: string[] = [];
	const { lifecycle, cleanup } = unit(async () => { order.push("assemble"); throw new Error("x"); });
	try {
		const results = await Promise.all([lifecycle.start(), lifecycle.stop(), lifecycle.start()]);
		assert.deepEqual(results, ["启动失败：x", "stopped", "启动失败：x"]);
		assert.deepEqual(order, ["assemble", "assemble"]);
	} finally { await cleanup(); }
});

test("生命周期：从入口启动后重复启动返回 already；停止后可以再启动，可选能力重新登记不冲突", T, async () => {
	const h = await startHarness({ admins: ["ou_admin"], cron: { enabled: true } });
	try {
		const run = (name: string) => h.pi.commands.get(name)!.handler("", {} as never, []);
		const statusFile = join(h.home, "feishu-channel", "status.json");
		assert.ok(h.logs.findIndex((l) => l.event === "feishu.bridge.features") < h.logs.findIndex((l) => l.event === "bridge started"));
		assert.equal(await run("feishu:start"), "already");
		assert.equal(await run("feishu:stop"), "stopped");
		assert.equal(JSON.parse(readFileSync(statusFile, "utf8")).connState, "disconnected");
		const before = statSync(statusFile).mtimeMs;
		assert.equal(await run("feishu:start"), "started");
		assert.ok(statSync(statusFile).mtimeMs >= before);
		assert.equal(h.logs.filter((l) => l.event === "bridge started").length, 2);
		assert.equal(await run("feishu:restart"), "started");
		assert.match(String(await run("feishu:status")), /定时任务: 0 个启用/);
	} finally { await h.stop(); }
});
