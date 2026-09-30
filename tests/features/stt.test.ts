/**
 * 可选能力·语音转写（stt.provider + stt.endpoint）：开、关两种配置。
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { sttFeature } from "../../src/features/stt.js";
import type { BridgeConfig } from "../../src/types.js";
import { T, enabledIn, featureHostFor, withHarness } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function hostWith(stt: BridgeConfig["stt"]) {
	return (await featureHostFor([sttFeature], { stt })).host;
}

test("语音转写·关：没有转写器；只选 provider 不填 endpoint 也视为关闭", async () => {
	assert.equal((await hostWith(undefined)).first("transcribe"), undefined);
	assert.equal((await hostWith({ provider: "openai" })).first("transcribe"), undefined);
});

test("语音转写·开：资源下载器拿到的转写器会调用配置的接口", async () => {
	const calls: string[] = [];
	globalThis.fetch = (async (url: string) => {
		calls.push(url);
		return new Response(JSON.stringify({ text: "你好" }), { status: 200 });
	}) as typeof fetch;
	const transcribe = (await hostWith({ provider: "openai", endpoint: "http://stt.local/v1/" })).first("transcribe");
	assert.ok(transcribe);
	assert.equal(await transcribe(Buffer.from("x"), "voice"), "你好");
	assert.deepEqual(calls, ["http://stt.local/v1/audio/transcriptions"]);
});

test("语音转写：开关状态出现在 status.json 的 features 里", T, async () => {
	await withHarness({ stt: { provider: "openai", endpoint: "http://stt.local/v1" } }, async (h) => {
		assert.ok(enabledIn(h).status.includes("stt"));
	});
	await withHarness({}, async (h) => {
		assert.ok(!enabledIn(h).status.includes("stt"));
	});
});
