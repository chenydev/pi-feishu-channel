import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriber } from "../src/inbound/stt.js";
import { ResourceResolver } from "../src/inbound/resource-resolver.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("语音转写：默认关闭（未配置 provider/endpoint 时不创建）", () => {
	assert.equal(createTranscriber(undefined), undefined);
	assert.equal(createTranscriber({ provider: "off" }), undefined);
	assert.equal(createTranscriber({ provider: "openai" }), undefined);
});

test("语音转写：OpenAI 兼容接口 —— 带模型、文件与密钥（密钥来自环境变量）", async () => {
	const calls: Array<{ url: string; auth?: string; model?: unknown; file?: unknown }> = [];
	const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: FormData }) => {
		calls.push({ url, auth: init.headers.Authorization, model: init.body.get("model"), file: (init.body.get("file") as File | null)?.name });
		return new Response(JSON.stringify({ text: "你好世界" }), { status: 200 });
	}) as unknown as typeof fetch;
	const transcribe = createTranscriber({ provider: "openai", endpoint: "https://stt.example/v1/", model: "whisper-large" }, { env: { STT_API_KEY: "k" }, fetch: fakeFetch });
	assert.equal(await transcribe?.(Buffer.from("x"), "voice"), "你好世界");
	assert.deepEqual(calls, [{ url: "https://stt.example/v1/audio/transcriptions", auth: "Bearer k", model: "whisper-large", file: "voice.ogg" }]);
});

test("语音转写：转写失败退回附件路径；成功时以 [语音转写] 注入", async () => {
	const dir = mkdtempSync(join(tmpdir(), "stt-"));
	try {
		const make = (transcribe: (audio: Buffer) => Promise<string | undefined>) => new ResourceResolver({
			baseDir: dir, download: async () => ({ buffer: Buffer.from("ogg"), mimeType: "audio/ogg" }), transcribe,
		});
		const ok = await make(async () => "明天开会").resolve([{ kind: "audio", key: "k", messageId: "m", name: "a.opus" }]);
		assert.match(ok.promptSuffix, /\[语音转写\] 明天开会/);
		const failed = await make(async () => undefined).resolve([{ kind: "audio", key: "k", messageId: "m", name: "a.opus" }]);
		assert.match(failed.promptSuffix, /本地路径/);
		failed.cleanup();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
