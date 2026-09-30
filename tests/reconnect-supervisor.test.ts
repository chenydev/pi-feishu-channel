/**
 * 重连监管：复现 2026-09 线上 1Hz 重连风暴的时序，并锁住修复语义。
 *
 * 线上时序（docker logs）：reconnect() 返回 → 立刻再调度（握手未完成）→ ~230ms 后 ws_ready
 * → 1s 后定时器触发、不复查连接、强制关闭健康连接 → onReady 清零退避 → 永远循环。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ReconnectSupervisor, type ReconnectTarget } from "../src/runtime/reconnect-supervisor.js";

interface Harness {
	supervisor: ReconnectSupervisor;
	target: ReconnectTarget & { connected: boolean; running: boolean; connectStartedAt: number; reconnects: number; failNext: number };
	clock: { now: number };
	timers: Array<{ fn: () => void; at: number }>;
	/** 推进时间并触发到期定时器与 watchdog 巡检（每秒一次）。 */
	advance(ms: number): Promise<void>;
	scheduled: number[];
}

function harness(options: { handshakeMs?: number } = {}): Harness {
	const clock = { now: 1_000_000 };
	const timers: Array<{ fn: () => void; at: number }> = [];
	const scheduled: number[] = [];
	const handshakeMs = options.handshakeMs ?? 230;
	const target = {
		connected: true,
		running: true,
		connectStartedAt: 0,
		reconnects: 0,
		failNext: 0,
		isRunning() { return this.running; },
		isConnected() { return this.connected; },
		getConnectStartedAt() { return this.connectStartedAt; },
		async reconnect() {
			this.reconnects += 1;
			this.connected = false;
			if (this.failNext > 0) {
				this.failNext -= 1;
				this.running = false;
				throw new Error("ws connect failed");
			}
			this.running = true;
			this.connectStartedAt = clock.now;
			// 握手在 reconnect() 返回之后才完成（真实 SDK 行为）
			const readyAt = clock.now + handshakeMs;
			timers.push({ at: readyAt, fn: () => { target.connected = true; target.connectStartedAt = 0; } });
		},
	};
	const supervisor = new ReconnectSupervisor({
		isActive: () => true,
		target: () => target,
		onScheduled: (_attempt, delay) => scheduled.push(delay),
		now: () => clock.now,
		random: () => 0,
		setTimer: (fn, ms) => {
			const handle = { fn, at: clock.now + ms, unref() { return handle; } };
			timers.push(handle);
			return handle as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (handle) => {
			const index = timers.indexOf(handle as unknown as { fn: () => void; at: number });
			if (index >= 0) timers.splice(index, 1);
		},
	});
	let nextWatchdog = clock.now + 1_000;
	return {
		supervisor, target, clock, timers, scheduled,
		async advance(ms) {
			const end = clock.now + ms;
			while (true) {
				const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
				const nextAt = Math.min(due?.at ?? Number.POSITIVE_INFINITY, nextWatchdog);
				if (nextAt > end) break;
				clock.now = nextAt;
				if (due && due.at === nextAt) {
					timers.splice(timers.indexOf(due), 1);
					due.fn();
				} else {
					nextWatchdog += 1_000;
					supervisor.tick();
				}
				// 让 reconnect() 的 async 续体跑完
				await new Promise((resolve) => setImmediate(resolve));
			}
			clock.now = end;
		},
	};
}

test("一次真实断线只触发一次重连，之后不再自我循环（线上 1Hz 风暴回归）", async () => {
	const h = harness();
	await h.advance(3_000);
	assert.equal(h.target.reconnects, 0, "健康连接不应重连");

	h.target.connected = false; // 一次真实断线
	await h.advance(60_000);
	assert.equal(h.target.reconnects, 1, "恢复后不得再重连（重连风暴时 60s 内约 50 次）");
	assert.equal(h.target.connected, true);
});

test("定时器排队期间连接已自行恢复 → 放弃本次重连，不关掉健康连接", async () => {
	const h = harness();
	h.target.connected = false;
	await h.advance(1_000); // watchdog 排上一次重连（约 1s 后触发）
	assert.equal(h.supervisor.pending, true);
	h.target.connected = true; // SDK 自己连回来了
	await h.advance(5_000);
	assert.equal(h.target.reconnects, 0);
});

test("握手宽限期内不判掉线", async () => {
	const h = harness({ handshakeMs: 10_000 });
	h.target.connected = false;
	await h.advance(1_000);
	await h.advance(2_000); // 第一次重连已触发，握手需要 10s
	assert.equal(h.target.reconnects, 1);
	await h.advance(8_000); // 第 11s：握手未完成，但仍在 15s 宽限期内，不得再排
	assert.equal(h.target.reconnects, 1);
	assert.equal(h.target.connected, false);
	await h.advance(2_000); // 第 13s：握手完成
	assert.equal(h.target.connected, true);
	assert.equal(h.target.reconnects, 1);
});

test("reconnect 抛错：transport 不再 running，由 supervisor 自己继续退避（1s → 2s → 4s …）", async () => {
	const h = harness();
	h.target.failNext = 3;
	h.target.connected = false;
	await h.advance(30_000);
	assert.equal(h.target.reconnects, 4, "三次失败后第四次成功");
	assert.deepEqual(h.scheduled.map((d) => Math.round(d)), [1_000, 2_000, 4_000, 8_000]);
	assert.equal(h.target.connected, true);
});

test("退避计数在连接稳定 30s 后才清零；刚 ready 又断不会回到 1s", async () => {
	const h = harness();
	h.target.failNext = 2;
	h.target.connected = false;
	await h.advance(10_000); // 失败两次后连上
	assert.equal(h.target.connected, true);
	assert.equal(h.supervisor.backoffAttempts, 3);

	h.target.connected = false; // 刚连上 ~3s 又断：退避继续增长
	await h.advance(1_000);
	assert.equal(Math.round(h.scheduled.at(-1)!), 8_000);

	await h.advance(40_000); // 恢复并稳定超过 30s
	assert.equal(h.supervisor.backoffAttempts, 0);
});

test("reconnectsInWindow 统计近 5 分钟重连次数（flapping 诊断）", async () => {
	const h = harness();
	h.target.failNext = 2;
	h.target.connected = false;
	await h.advance(10_000);
	assert.equal(h.supervisor.reconnectsInWindow(), 3);
	assert.equal(h.supervisor.totalReconnects, 3);
	await h.advance(6 * 60_000);
	assert.equal(h.supervisor.reconnectsInWindow(), 0);
	assert.equal(h.supervisor.totalReconnects, 3);
});

test("cancel() 取消已排队的重连", async () => {
	const h = harness();
	h.target.connected = false;
	await h.advance(1_000);
	assert.equal(h.supervisor.pending, true);
	h.supervisor.cancel();
	assert.equal(h.supervisor.pending, false);
});

test("重连：SDK 正在自动重连时不插手；自动重连超过上限才整体重建", async () => {
	const h = harness();
	let healing = true;
	(h.target as { isSelfHealing?: () => boolean }).isSelfHealing = () => healing;
	h.target.connected = false;
	await h.advance(4 * 60_000);
	assert.equal(h.target.reconnects, 0, "SDK 自动重连期间不得打断它的重连阶梯");
	await h.advance(2 * 60_000);
	assert.equal(h.target.reconnects, 1, "超过 5 分钟仍未恢复 → 整体重建");
	healing = false;
});

test("重连：SDK 进入终态（不再自动重连）→ 立即按退避重建", async () => {
	const h = harness();
	(h.target as { isSelfHealing?: () => boolean }).isSelfHealing = () => false;
	h.target.connected = false;
	await h.advance(3_000);
	assert.equal(h.target.reconnects, 1);
});
