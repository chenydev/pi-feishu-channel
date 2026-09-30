/**
 * 超长回答转文件（`longReply.asFile`，默认关）：回答超过 `longReply.thresholdChars`（默认 6000 字），
 * 或代码块很多时，正文只放开头 `previewChars` 字，全文作为 .md 附件经持久发送队列发出。
 * 附件写失败就退回原文（宁可分片刷屏，也不能丢内容）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../config.js";
import type { ConversationManagerDeps, LongReplyInput } from "../session/conversation-manager.js";
import type { BridgeConfig } from "../types.js";
import type { BridgeFeature } from "./feature.js";

type SendLocalFile = NonNullable<ConversationManagerDeps["sendLocalFile"]>;
type Log = (level: "info" | "warn", msg: string, meta?: unknown) => void;

export const longReplyFeature: BridgeFeature = {
	name: "longReply",
	enabled: (config) => config.longReply?.asFile === true,
	setup({ rt, log, sendLocalFile }) {
		return {
			replyAsFile: createReplyAsFile({
				options: rt.config.longReply ?? {},
				exportsDir: resolvePaths(rt.homeDir).exportsDir,
				sendLocalFile,
				log: (level, msg, meta) => log[level](msg, meta),
			}),
		};
	},
};

export function createReplyAsFile(deps: {
	options: NonNullable<BridgeConfig["longReply"]>;
	exportsDir: string;
	sendLocalFile: SendLocalFile;
	log: Log;
	now?: () => number;
}): (input: LongReplyInput) => string {
	const { options, exportsDir, sendLocalFile, log, now = Date.now } = deps;
	return (input) => {
		const text = input.text;
		const threshold = options.thresholdChars ?? 6_000;
		const fences = (text.match(/^```/gm) ?? []).length / 2;
		// 代码块很多的回答优先走文件（群里的代码块分片后几乎没法复制）
		if (text.length <= threshold && !(fences >= 4 && text.length > threshold / 2)) return text;
		try {
			mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
			const name = `reply-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.md`;
			const path = join(exportsDir, name);
			writeFileSync(path, text, { mode: 0o600 });
			const sent = sendLocalFile(input.chatId, path, { replyTo: input.replyTo, threadId: input.threadId }, {
				dedupeKey: `${input.messageId}:final-file`, laneKey: input.conversationKey,
			});
			if (!sent.ok) {
				log("warn", "feishu.conv.long_reply_file_failed", { messageId: input.messageId, error: sent.error });
				return text;
			}
			const previewChars = options.previewChars ?? 1_500;
			let preview = text.slice(0, previewChars);
			// 别把代码块切在中间（未闭合的 ``` 会让后面的正文全变成代码）
			if (((preview.match(/^```/gm) ?? []).length) % 2 === 1) preview += "\n```";
			log("info", "feishu.conv.long_reply_as_file", { messageId: input.messageId, chars: text.length, file: name });
			return `${preview}\n\n…（全文 ${text.length} 字，完整内容见附件 ${name}）`;
		} catch (error) {
			log("warn", "feishu.conv.long_reply_file_failed", { messageId: input.messageId, error: error instanceof Error ? error.message : String(error) });
			return text;
		}
	};
}
