/**
 * FeatureHost：按开关装配能力、登记与注销命令和按钮、启动失败不影响其他能力。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandDispatcher } from "../../src/commands/dispatch.js";
import { FeatureHost, type BridgeFeature } from "../../src/features/feature.js";
import { CardRouter } from "../../src/interaction/card-router.js";
import { BridgeRuntime } from "../../src/runtime/bridge-runtime.js";
import { Onboarding } from "../../src/runtime/onboarding.js";

function setup(features: BridgeFeature[]) {
	const logs: string[] = [];
	const push = (m: string) => { logs.push(m); };
	const log = { debug: push, info: push, warn: push, error: push };
	const dispatcher = new CommandDispatcher({ log, isAdmin: () => false, replier: () => ({ reply() {}, trySendCard: async () => false }), piCommands: () => [] });
	const cardRouter = new CardRouter({ log, admins: () => [] });
	const host = new FeatureHost(features, { dispatcher, cardRouter, log });
	const rt = new BridgeRuntime();
	return { host, dispatcher, cardRouter, rt, logs, ctx: { rt, log, replier: () => ({ reply() {}, trySendCard: async () => false }), reconnectsLast5m: () => 0, onboarding: new Onboarding(rt, log), sendLocalFile: () => ({ ok: true }) } };
}

test("FeatureHost：关闭的能力不调用 setup，只登记 disabledCommands", async () => {
	let setupCalls = 0;
	const { host, dispatcher, cardRouter, ctx } = setup([{
		name: "cron", enabled: () => false,
		setup: () => { setupCalls += 1; return { cardOps: { x: () => 1 } }; },
		disabledCommands: { "/cron": () => undefined },
	}]);
	await host.setup(ctx);
	assert.equal(setupCalls, 0);
	assert.deepEqual(host.names(), []);
	assert.deepEqual(dispatcher.commands(), { "/cron": "feature:cron" });
	assert.deepEqual(cardRouter.ops(), {});
	await host.stop();
	assert.deepEqual(dispatcher.commands(), {}, "停止后注销");
});

test("FeatureHost：打开的能力登记命令、按钮与拦截器；停止时调用 stop 并全部注销，可再次装配", async () => {
	const events: string[] = [];
	const feature: BridgeFeature = {
		name: "cron", enabled: () => true,
		setup: () => ({
			commands: { "/cron": () => undefined },
			cardOps: { "cron.x": () => 1 },
			commandInterceptor: () => false,
			start: () => { events.push("start"); },
			stop: () => { events.push("stop"); },
			statusLines: () => ["定时任务: 0 个启用"],
		}),
	};
	const { host, dispatcher, cardRouter, ctx } = setup([feature]);
	await host.setup(ctx);
	await host.start();
	assert.deepEqual(host.names(), ["cron"]);
	assert.deepEqual(dispatcher.commands(), { "/cron": "feature:cron" });
	assert.deepEqual(cardRouter.ops(), { "cron.x": "feature:cron" });
	assert.deepEqual(host.statusLines(), ["定时任务: 0 个启用"]);
	await host.stop();
	assert.deepEqual(events, ["start", "stop"]);
	assert.deepEqual(dispatcher.commands(), {});
	assert.deepEqual(cardRouter.ops(), {});
	await host.setup(ctx);
	assert.deepEqual(host.names(), ["cron"], "停止后可以重新装配（重启桥）");
});

test("FeatureHost：某个能力启动失败只记日志，不影响其他能力", async () => {
	const started: string[] = [];
	const { host, logs, ctx } = setup([
		{ name: "a", enabled: () => true, setup: () => ({ start: () => { throw new Error("boom"); } }) },
		{ name: "b", enabled: () => true, setup: () => ({ start: () => { started.push("b"); } }) },
	]);
	await host.setup(ctx);
	await host.start();
	assert.deepEqual(started, ["b"]);
	assert.ok(logs.includes("feishu.feature.start_failed"));
});
