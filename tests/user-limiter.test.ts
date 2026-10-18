/**
 * 按人限流：滑动窗口、默认关闭、被拦时给等待时间。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createUserLimiter } from "../src/inbound/user-limiter.js";

test("限流：0 = 不限（默认）；设了上限后窗口内超出就拦，窗口滑过后恢复", () => {
	let now = 0;
	const limiter = createUserLimiter({ perMinute: 2, now: () => now });
	assert.equal(limiter.allow("ou_a").ok, true);
	assert.equal(limiter.allow("ou_a").ok, true);
	const blocked = limiter.allow("ou_a");
	assert.equal(blocked.ok, false);
	assert.equal(blocked.ok === false ? blocked.retryAfterMs : 0, 60_000, "刚发满时还要等满窗口");

	// 别人不受影响
	assert.equal(limiter.allow("ou_b").ok, true);

	now += 30_000;
	const half = limiter.allow("ou_a");
	assert.equal(half.ok, false);
	assert.equal(half.ok === false ? half.retryAfterMs : 0, 30_000, "剩余等待时间按最早那条算");

	now += 30_000;
	assert.equal(limiter.allow("ou_a").ok, true, "窗口滑过第一条之后就有名额");
});

test("限流：上限可以现读（配置热更），prune 清掉过期用户", () => {
	let now = 0;
	let cap = 1;
	const limiter = createUserLimiter({ perMinute: () => cap, now: () => now });
	assert.equal(limiter.allow("ou_a").ok, true);
	assert.equal(limiter.allow("ou_a").ok, false);
	cap = 5;
	assert.equal(limiter.allow("ou_a").ok, true, "放宽上限立即生效");

	assert.equal(limiter.size(), 1);
	now += 61_000;
	limiter.prune();
	assert.equal(limiter.size(), 0, "过期用户要被清掉（长驻进程不累积）");

	// 关闭（0）时一律放行
	const off = createUserLimiter({ perMinute: 0, now: () => now });
	for (let i = 0; i < 100; i += 1) assert.equal(off.allow("ou_a").ok, true);
});
