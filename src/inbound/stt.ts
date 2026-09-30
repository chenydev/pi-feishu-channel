/**
 * 可插拔语音转写（默认关闭）。
 *
 * 目前只实现 OpenAI 兼容的 `/audio/transcriptions`（OpenAI、Groq、自建 whisper 服务都兼容这个接口）。
 * 密钥只从环境变量读（`stt.apiKeyEnv`，默认 STT_API_KEY），不进配置文件。
 */
import type { BridgeConfig } from "../types.js";

export type Transcriber = (audio: Buffer, name: string, mimeType?: string) => Promise<string | undefined>;

export function createTranscriber(
	config: BridgeConfig["stt"],
	deps: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void } = {},
): Transcriber | undefined {
	if (config?.provider !== "openai" || !config.endpoint) return undefined;
	const env = deps.env ?? process.env;
	const doFetch = deps.fetch ?? fetch;
	const maxBytes = config.maxBytes ?? 20 * 1024 * 1024;
	const endpoint = config.endpoint.replace(/\/+$/, "");
	return async (audio, name, mimeType) => {
		if (audio.length > maxBytes) return undefined;
		const apiKey = env[config.apiKeyEnv ?? "STT_API_KEY"];
		const form = new FormData();
		form.append("model", config.model ?? "whisper-1");
		// 飞书语音是 opus（ogg 容器）；多数服务按扩展名识别格式
		const fileName = /\.\w+$/.test(name) ? name : `${name}.ogg`;
		form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType ?? "audio/ogg" }), fileName);
		const started = Date.now();
		try {
			const response = await doFetch(`${endpoint}/audio/transcriptions`, {
				method: "POST",
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
				body: form,
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok) {
				deps.log?.("warn", "feishu.stt.failed", { status: response.status });
				return undefined;
			}
			const data = await response.json() as { text?: unknown };
			const text = typeof data.text === "string" ? data.text : undefined;
			deps.log?.("info", "feishu.stt.done", { bytes: audio.length, chars: text?.length ?? 0, ms: Date.now() - started });
			return text;
		} catch (error) {
			deps.log?.("warn", "feishu.stt.failed", { error: error instanceof Error ? error.message : String(error) });
			return undefined;
		}
	};
}
