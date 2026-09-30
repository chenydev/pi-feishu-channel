import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CronScheduler, nextFire, parseCron, parseCronAdd } from "../src/runtime/cron.js";

const at = (iso: string) => Date.parse(iso);

test("定时任务：5 段表达式解析与非法值报错", () => {
	assert.throws(() => parseCron("* * *"), /5 段/);
	assert.throws(() => parseCron("61 * * * *"), /超出范围/);
	assert.throws(() => parseCron("*/0 * * * *"), /步长/);
	const fields = parseCron("*/15 9-18 * * 1-5");
	assert.deepEqual([...fields.minute], [0, 15, 30, 45]);
	assert.equal(fields.hour.has(9) && fields.hour.has(18) && !fields.hour.has(19), true);
	assert.equal(parseCron("0 0 * * 7").dow.has(0), true, "7 = 周日");
});

test("定时任务：按时区计算下一次触发", () => {
	// 上海 09:00 工作日 = UTC 01:00
	const fields = parseCron("0 9 * * 1-5");
	assert.equal(nextFire(fields, at("2026-09-28T00:30:00Z"), "Asia/Shanghai"), at("2026-09-28T01:00:00Z"));
	// 周五 09:00 之后 → 下周一
	assert.equal(nextFire(fields, at("2026-10-02T01:00:00Z"), "Asia/Shanghai"), at("2026-10-05T01:00:00Z"));
	assert.equal(nextFire(parseCron("@hourly"), at("2026-09-28T00:30:00Z"), "UTC"), at("2026-09-28T01:00:00Z"));
	// 日与周都受限时取"或"
	const either = parseCron("0 0 1 * 1");
	assert.equal(nextFire(either, at("2026-09-28T00:00:00Z"), "UTC"), at("2026-10-01T00:00:00Z"), "10-01 是 1 号");
});

test("定时任务：/cron add 参数解析", () => {
	assert.deepEqual(parseCronAdd('"0 9 * * 1-5" 汇总昨天的告警'), { expression: "0 9 * * 1-5", text: "汇总昨天的告警" });
	assert.deepEqual(parseCronAdd("@daily 检查磁盘"), { expression: "@daily", text: "检查磁盘" });
	assert.deepEqual(parseCronAdd("*/5 * * * * ping"), { expression: "*/5 * * * *", text: "ping" });
	assert.equal(parseCronAdd("随便"), undefined);
});

test("定时任务：每分钟任务连续 10 分钟恰好触发 10 次；重启不重复；删除后不再触发", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cron-"));
	try {
		const file = join(dir, "jobs.json");
		let now = at("2026-09-28T00:00:10Z");
		const fired: number[] = [];
		const make = () => new CronScheduler({ file, now: () => now, timeZone: () => "UTC", onFire: async (fire) => { fired.push(fire.plannedAt); } });
		let scheduler = make();
		const job = scheduler.add({ expression: "* * * * *", text: "ping", chatId: "oc", chatType: "group", creatorId: "ou" });
		for (let i = 0; i < 10; i++) {
			now += 60_000;
			await scheduler.tick();
			await scheduler.tick(); // 同一分钟内重复巡检不重复触发
		}
		assert.equal(fired.length, 10);
		// 重启：从文件恢复，同一分钟不再触发
		scheduler = make();
		await scheduler.tick();
		assert.equal(fired.length, 10);
		assert.equal(scheduler.remove(job.id), true);
		now += 60_000;
		await scheduler.tick();
		assert.equal(fired.length, 10);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("定时任务：停机错过的触发默认跳过，并在下一次执行时说明错过次数", async () => {
	let now = at("2026-09-28T00:00:00Z");
	const fires: Array<{ missed: number }> = [];
	const scheduler = new CronScheduler({ now: () => now, timeZone: () => "UTC", onFire: async (fire) => { fires.push({ missed: fire.missed }); } });
	scheduler.add({ expression: "0 * * * *", text: "hourly", chatId: "oc", chatType: "group", creatorId: "ou" });
	now = at("2026-09-28T03:30:00Z"); // 停机 3.5 小时：01、02、03 点都错过
	assert.equal(await scheduler.tick(), 0);
	now = at("2026-09-28T04:00:30Z");
	assert.equal(await scheduler.tick(), 1);
	assert.deepEqual(fires, [{ missed: 3 }]);
});

test("定时任务：catchUp=once 时补跑一次", async () => {
	let now = at("2026-09-28T00:00:00Z");
	const fires: Array<{ missed: number }> = [];
	const scheduler = new CronScheduler({ now: () => now, timeZone: () => "UTC", catchUp: () => "once", onFire: async (fire) => { fires.push({ missed: fire.missed }); } });
	scheduler.add({ expression: "0 * * * *", text: "hourly", chatId: "oc", chatType: "group", creatorId: "ou" });
	now = at("2026-09-28T03:30:00Z");
	assert.equal(await scheduler.tick(), 1);
	assert.deepEqual(fires, [{ missed: 2 }]);
});

test("定时任务：暂停期间不触发，恢复后从现在起算", async () => {
	let now = at("2026-09-28T00:00:00Z");
	let count = 0;
	const scheduler = new CronScheduler({ now: () => now, timeZone: () => "UTC", onFire: async () => { count += 1; } });
	const job = scheduler.add({ expression: "* * * * *", text: "x", chatId: "oc", chatType: "group", creatorId: "ou" });
	scheduler.setEnabled(job.id, false);
	now += 5 * 60_000;
	await scheduler.tick();
	assert.equal(count, 0);
	scheduler.setEnabled(job.id, true);
	now += 60_000;
	await scheduler.tick();
	assert.equal(count, 1);
	assert.equal(scheduler.list()[0]?.missed ?? 0, 0);
});
