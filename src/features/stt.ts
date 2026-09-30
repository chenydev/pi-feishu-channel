/**
 * 语音转写（`stt.provider` + `stt.endpoint`，默认关）：语音消息下载后先转成文字再交给模型。
 * 转写实现见 inbound/stt.ts；这里只负责按配置创建转写器并交给资源下载器。
 */
import { createTranscriber } from "../inbound/stt.js";
import type { BridgeFeature } from "./feature.js";

export const sttFeature: BridgeFeature = {
	name: "stt",
	// 与 createTranscriber 的判定一致：只选了 provider 而没有 endpoint 时并不会创建转写器
	enabled: (config) => config.stt?.provider === "openai" && Boolean(config.stt.endpoint),
	setup({ rt, log }) {
		return { transcribe: createTranscriber(rt.config.stt, { log: (level, m, meta) => log[level](m, meta) }) };
	},
};
