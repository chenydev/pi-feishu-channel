/**
 * 进程级兜底：漏 await 的路径不该把整个桥带走，但也不能悄悄吞掉。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProcessGuard, installProcessGuards } from "../src/runtime/process-guards.js";

function logger(records: Array<{ event: string; meta?: unknown }>) {
	return {
		debug: () => {}, info: () => {}, warn: () => {},
		error: (event: string, meta?: unknown) => { records.push({ event, meta }); },
	};
}

test("进程级兜底：记日志并计数（Error 与字符串原因都要能记）", () => {
	const records: Array<{ event: string; meta?: unknown }> = [];
	const guard = createProcessGuard(logger(records));
	guard.handler(new Error("漏了 await"));
	assert.equal(guard.count(), 1);
	assert.equal(records[0]?.event, "feishu.process.unhandled_rejection");
	assert.match(JSON.stringify(records[0]?.meta), /漏了 await/);

	guard.handler("字符串原因");
	assert.equal(guard.count(), 2);
	assert.match(JSON.stringify(records[1]?.meta), /字符串原因/);
});

test("进程级兜底：装上 / 摘掉监听（dispose 幂等）", () => {
	const before = process.listenerCount("unhandledRejection");
	const guard = installProcessGuards(logger([]));
	assert.equal(process.listenerCount("unhandledRejection"), before + 1);
	guard.dispose();
	assert.equal(process.listenerCount("unhandledRejection"), before, "dispose 后监听要摘干净");
	assert.doesNotThrow(() => guard.dispose());
});

