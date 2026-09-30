/**
 * 会话归档（`retention.sessionDays` > 0，默认不归档）：启动时把超过保留天数、
 * 且没有被任何会话引用的历史会话文件移到归档目录。
 */
import { resolvePaths } from "../config.js";
import { archiveOldSessions } from "../runtime/retention.js";
import type { BridgeFeature } from "./feature.js";

export const retentionFeature: BridgeFeature = {
	name: "retention",
	enabled: (config) => (config.retention?.sessionDays ?? 0) > 0,
	setup({ rt, log }) {
		return {
			start() {
				try {
					const archived = archiveOldSessions({
						dir: resolvePaths(rt.homeDir).sessionDir,
						keep: rt.convManager?.referencedSessionFiles() ?? new Set(),
						days: rt.config.retention?.sessionDays ?? 0,
					});
					if (archived.length > 0) log.info("feishu.retention", { tightened: 0, archived: archived.length });
				} catch (error) {
					log.warn("feishu.retention_failed", { error: error instanceof Error ? error.message : String(error) });
				}
			},
		};
	},
};
