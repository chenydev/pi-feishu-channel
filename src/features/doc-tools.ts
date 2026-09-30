/**
 * 云文档读取工具（`docTools.enabled`，默认关）：子会话里多一个读取飞书云文档正文的工具，
 * 超过 `docTools.maxChars`（默认 3 万字）截断。
 */
import { readDocText } from "../inbound/doc-comments.js";
import type { BridgeFeature } from "./feature.js";

export const docToolsFeature: BridgeFeature = {
	name: "docTools",
	enabled: (config) => config.docTools?.enabled === true,
	setup({ rt }) {
		return {
			async readDoc(ref) {
				if (!rt.transport) return { content: [{ type: "text", text: "飞书连接不可用" }], isError: true };
				const transport = rt.transport;
				const result = await readDocText((opts) => transport.rawRequest(opts), ref, rt.config.docTools?.maxChars ?? 30_000);
				if (!result.ok) return { content: [{ type: "text", text: result.error }], isError: true };
				return { content: [{ type: "text", text: result.truncated ? `${result.text}\n\n…（文档较长，已截断）` : result.text || "（文档为空）" }] };
			},
		};
	},
};
