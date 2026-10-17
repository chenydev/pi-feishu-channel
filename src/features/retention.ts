/**
 * 会话归档（`retention.sessionDays` > 0，默认不归档）：把超过保留天数、
 * 且没有被任何会话引用的历史会话文件移到归档目录。
 *
 * 启动时跑一次，之后每 6 小时一次：只在启动时跑的话，长驻实例（几周不重启）
 * 永远归档不了新变旧的文件，磁盘只涨不降。
 */
import { resolvePaths } from "../config.js";
import { archiveOldSessions, pruneExports } from "../runtime/retention.js";
import type { BridgeFeature } from "./feature.js";

/** 归档巡检间隔（6 小时）。 */
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/** 长回答导出的 `reply-*.md` 保留份数。 */
const EXPORTS_TO_KEEP = 200;

export const retentionFeature: BridgeFeature = {
	name: "retention",
	enabled: (config) => (config.retention?.sessionDays ?? 0) > 0,
	setup({ rt, log }) {
		let timer: ReturnType<typeof setInterval> | undefined;
		const sweep = (): void => {
			const paths = resolvePaths(rt.homeDir);
			try {
				const archived = archiveOldSessions({
					dir: paths.sessionDir,
					keep: rt.convManager?.referencedSessionFiles() ?? new Set(),
					days: rt.config.retention?.sessionDays ?? 0,
				});
				const prunedExports = pruneExports({ dir: paths.exportsDir, keep: EXPORTS_TO_KEEP });
				if (archived.length > 0 || prunedExports > 0) {
					log.info("feishu.retention", { tightened: 0, archived: archived.length, prunedExports });
				}
			} catch (error) {
				log.warn("feishu.retention_failed", { error: error instanceof Error ? error.message : String(error) });
			}
		};
		return {
			start() {
				sweep();
				timer = setInterval(sweep, SWEEP_INTERVAL_MS);
				timer.unref?.();
			},
			stop() {
				if (timer) clearInterval(timer);
				timer = undefined;
			},
		};
	},
};
