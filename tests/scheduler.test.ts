import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionScheduler } from "../src/session/scheduler.js";

interface S { conversationKey: string; queue: string[]; activeRun: boolean }

function session(key: string, items: string[]): S {
	return { conversationKey: key, queue: [...items], activeRun: true };
}

async function drain(scheduler: SessionScheduler<S, string>): Promise<void> {
	while (scheduler.runningPumps().length > 0) await Promise.allSettled(scheduler.runningPumps());
}

test("SessionScheduler：并发上限内按会话串行执行，超出排队", async () => {
	const order: string[] = [];
	const scheduler = new SessionScheduler<S, string>({
		maxActive: () => 1,
		isShuttingDown: () => false,
		runTurn: async (_s, item) => { order.push(item); await new Promise((r) => setTimeout(r, 1)); },
	});
	const a = session("a", ["a1", "a2"]);
	const b = session("b", ["b1"]);
	scheduler.schedule(a);
	scheduler.schedule(b);
	assert.equal(scheduler.active, 1);
	assert.equal(scheduler.waiting.length, 1);
	await drain(scheduler);
	assert.deepEqual(order, ["a1", "a2", "b1"]);
	assert.equal(a.activeRun, false);
	assert.equal(scheduler.active, 0);
});

test("SessionScheduler：跑满 turnBatch 且有人等待时让出执行槽", async () => {
	const order: string[] = [];
	const scheduler = new SessionScheduler<S, string>({
		maxActive: () => 1,
		isShuttingDown: () => false,
		runTurn: async (_s, item) => { order.push(item); await new Promise((r) => setTimeout(r, 1)); },
	});
	scheduler.turnBatch = 2;
	const hot = session("hot", ["h1", "h2", "h3", "h4"]);
	const cold = session("cold", ["c1"]);
	scheduler.schedule(hot);
	scheduler.schedule(cold);
	await drain(scheduler);
	assert.deepEqual(order, ["h1", "h2", "c1", "h3", "h4"]);
});

test("SessionScheduler：关闭后不再消费，activeItems 在 turn 结束后清理", async () => {
	let shutting = false;
	const seen: string[] = [];
	const scheduler: SessionScheduler<S, string> = new SessionScheduler<S, string>({
		maxActive: () => 2,
		isShuttingDown: () => shutting,
		runTurn: async (s, item) => {
			seen.push(item);
			assert.equal(scheduler.activeItems.get(s.conversationKey), item);
			shutting = true;
		},
	});
	const a = session("a", ["a1", "a2"]);
	scheduler.schedule(a);
	await drain(scheduler);
	assert.deepEqual(seen, ["a1"]);
	assert.equal(scheduler.activeItems.size, 0);
	scheduler.schedule(session("b", ["b1"]));
	assert.equal(scheduler.active, 0, "关闭中不接新 pump");
});

test("SessionScheduler：runTurn 抛错不中断队列，也不留下未处理的 rejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => { unhandled.push(error); };
	process.on("unhandledRejection", onUnhandled);
	const logs: string[] = [];
	const seen: string[] = [];
	try {
		const scheduler = new SessionScheduler<S, string>({
			maxActive: () => 4,
			isShuttingDown: () => false,
			runTurn: async (_s, item) => {
				if (item === "a1") throw new Error("收尾清理失败");
				seen.push(item);
			},
			log: (_level, event) => logs.push(event),
		});
		const a = session("a", ["a1", "a2", "a3"]);
		scheduler.schedule(a);
		await drain(scheduler);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(seen, ["a2", "a3"], "一条失败不应让队列滞留");
		assert.deepEqual(a.queue, []);
		assert.equal(a.activeRun, false);
		assert.ok(logs.includes("feishu.conv.pump_failed"));
		assert.deepEqual(unhandled, [], "不得产生未处理的 rejection（会让进程退出）");
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
