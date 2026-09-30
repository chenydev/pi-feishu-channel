/**
 * @gotgenes/pi-permission-system（下称 PS）在本机的位置与安装检测。
 *
 * PS 的配置、父会话转发目录都在 pi 配置目录下：
 * 优先 `PI_CODING_AGENT_DIR`，其次 pi 自己报告的目录（`pi.getAgentDir()`，扩展加载时记下），
 * 最后才猜 `cwd/pi-agent` —— 只猜 cwd 在非容器环境里会指错。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

let reportedAgentDir: string | undefined;

/** 记下 pi 报告的配置目录（扩展加载时调用一次）。 */
export function setReportedAgentDir(dir: string | undefined): void {
	reportedAgentDir = dir;
}

export function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? reportedAgentDir ?? join(process.cwd(), "pi-agent");
}

/** PS 的配置文件。 */
export function psConfigFile(): string {
	return join(resolveAgentDir(), "extensions", "pi-permission-system", "config.json");
}

/**
 * 检查 PS 是否真的装在 pi 配置目录里。
 * 用途：policyEngine=pi-permission-system 时的默认拒绝判定 —— 若扩展缺席，
 * 桥的审批就是唯一防线，此时必须继续用自己的策略而不是静默放行。
 * 父会话转发（approval.forwarding）也复用该判定：扩展不在就没有 ask 会转发过来。
 *
 * 每次工具调用都会判定一次，结果缓存 60 秒（装/卸扩展本来就要重启才生效）。
 */
let installedCache: { at: number; dir: string; value: boolean } | undefined;
export function piPermissionSystemInstalled(): boolean {
	const agentDir = resolveAgentDir();
	const now = Date.now();
	if (installedCache && installedCache.dir === agentDir && now - installedCache.at < 60_000) return installedCache.value;
	const candidates = [
		join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system"),
		join(agentDir, "extensions", "pi-permission-system"),
	];
	const value = candidates.some((dir) => {
		try {
			return existsSync(join(dir, "package.json"));
		} catch {
			return false;
		}
	});
	installedCache = { at: now, dir: agentDir, value };
	return value;
}
