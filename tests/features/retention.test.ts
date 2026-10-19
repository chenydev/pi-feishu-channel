/**
 * 可选能力·会话归档（retention.sessionDays > 0）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../../src/config.js";
import { retentionFeature } from "../../src/features/retention.js";
import { featureHostFor } from "./helpers.js";

function oldSession(homeDir: string, name: string): string {
	const dir = resolvePaths(homeDir).sessionDir;
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, "{}\n");
	const old = (Date.now() - 40 * 86_400_000) / 1000;
	utimesSync(file, old, old);
	return file;
}

test("会话归档·关：旧会话文件保持原样", async () => {
	const { host, rt } = await featureHostFor([retentionFeature], {});
	const file = oldSession(rt.homeDir, "a.jsonl");
	await host.start();
	assert.deepEqual(host.names(), []);
	assert.ok(existsSync(file));
});

test("会话归档·开：超过保留天数的会话归档为 .gz，并记录 feishu.retention", async () => {
	const { host, rt, logs } = await featureHostFor([retentionFeature], { retention: { sessionDays: 30 } });
	const file = oldSession(rt.homeDir, "a.jsonl");
	await host.start();
	assert.ok(!existsSync(file));
	assert.ok(existsSync(join(resolvePaths(rt.homeDir).sessionDir, "archive", "a.jsonl.gz")));
	assert.ok(logs.includes("feishu.retention"));
});

test("会话归档·开：不再管导出附件（由 longReply 自己回收），停止后不留定时器", async () => {
	const { host, rt } = await featureHostFor([retentionFeature], { retention: { sessionDays: 30 } });
	const exportsDir = resolvePaths(rt.homeDir).exportsDir;
	mkdirSync(exportsDir, { recursive: true });
	const old = new Date(Date.now() - 10 * 86_400_000);
	for (let i = 0; i < 205; i += 1) {
		const file = join(exportsDir, `reply-${i}.md`);
		writeFileSync(file, "内容");
		utimesSync(file, old, old);
	}
	await host.start();
	assert.equal(readdirSync(exportsDir).length, 205);
	// 关掉后不再有定时器残留（unref + clearInterval）
	await host.stop();
});
