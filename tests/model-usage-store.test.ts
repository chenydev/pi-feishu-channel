import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelUsageStore } from "../src/runtime/model-usage-store.js";
import { quickSwitchLabels } from "../src/commands/models-card.js";

const DAY = 24 * 60 * 60_000;

test("模型切换历史：按频率排序，最近使用按时间排序", () => {
	let now = 0;
	const store = new ModelUsageStore({ now: () => now });
	for (let i = 0; i < 3; i++) { now += 1_000; store.record("a/flash"); }
	now += 1_000; store.record("b/pro");
	assert.deepEqual(store.frequent(), ["a/flash", "b/pro"]);
	assert.deepEqual(store.recent(), ["b/pro", "a/flash"]);
	assert.equal(store.get("a/flash")?.count, 3);
});

test("模型切换历史：频率随时间衰减 —— 很久以前用得多的会被最近常用的超过", () => {
	let now = 0;
	const store = new ModelUsageStore({ now: () => now });
	for (let i = 0; i < 5; i++) store.record("old/heavy");
	now += 60 * DAY; // 4 个半衰期：5 → 0.3125
	store.record("new/light");
	assert.deepEqual(store.frequent(), ["new/light", "old/heavy"]);
	assert.equal(store.get("old/heavy")?.count, 5, "累计次数保留（展示用）");
});

test("模型切换历史：同分按最近使用；持久化后重启顺序不变", () => {
	const dir = mkdtempSync(join(tmpdir(), "model-usage-"));
	try {
		const file = join(dir, "model-usage.json");
		let now = 1_000;
		const store = new ModelUsageStore({ file, now: () => now, halfLifeMs: Number.POSITIVE_INFINITY });
		store.record("a/x");
		now += 1;
		store.record("b/y");
		assert.deepEqual(store.frequent(), ["b/y", "a/x"], "同分时最近的在前");
		const reloaded = new ModelUsageStore({ file, now: () => now, halfLifeMs: Number.POSITIVE_INFINITY });
		assert.deepEqual(reloaded.frequent(), ["b/y", "a/x"]);
		assert.deepEqual(reloaded.recent(1), ["b/y"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("模型切换历史：超出容量时淘汰分数最低的", () => {
	let now = 0;
	const store = new ModelUsageStore({ now: () => now, maxEntries: 2 });
	store.record("a"); store.record("a");
	now += 1; store.record("b");
	now += 1; store.record("c");
	assert.deepEqual(store.frequent().sort(), ["a", "c"]);
});

test("快速切换顺序：常用在前（只取可用的），其余按列表补齐，不含当前模型", () => {
	const models = [{ id: "m1", provider: "p" }, { id: "m2", provider: "p" }, { id: "m3", provider: "p" }, { id: "m4", provider: "p" }];
	assert.deepEqual(
		quickSwitchLabels({ models, currentLabel: "p/m1", frequentModels: ["p/m3", "gone/model", "p/m1"] }),
		["p/m3", "p/m2", "p/m4"],
	);
	assert.deepEqual(quickSwitchLabels({ models, currentLabel: "p/m4" }, 2), ["p/m1", "p/m2"], "没有历史时保持列表顺序");
});
