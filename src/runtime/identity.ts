/**
 * 运行时标识：运行时目录名、环境变量前缀，以及从旧名（`pi-feishu-bridge` 时代）迁移。
 *
 * - 运行时目录：`<home>/feishu-channel/`（旧名 `feishu-bridge/`）；
 * - 环境变量：`FEISHU_CHANNEL_*`（旧名 `FEISHU_BRIDGE_*` 仍识别，启动时告警）；
 * - 启动时如果只有旧目录，就把它改名为新目录，并在原位置留一个指向新目录的软链接，
 *   这样会话文件里记录的旧绝对路径、外部脚本里写死的旧路径仍然有效。
 */
import { existsSync, lstatSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { BridgeLogger } from "./logger.js";

export const RUNTIME_DIR_NAME = "feishu-channel";
export const LEGACY_RUNTIME_DIR_NAME = "feishu-bridge";
const ENV_PREFIX = "FEISHU_CHANNEL_";
const LEGACY_ENV_PREFIX = "FEISHU_BRIDGE_";

/** 读取 `FEISHU_CHANNEL_<name>`，没有时退回旧名 `FEISHU_BRIDGE_<name>`。 */
export function channelEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	return env[`${ENV_PREFIX}${name}`] ?? env[`${LEGACY_ENV_PREFIX}${name}`];
}

/** 进程环境里仍在使用的旧名环境变量，及其新名。 */
export function deprecatedEnvNames(env: NodeJS.ProcessEnv): { name: string; replacement: string }[] {
	return Object.keys(env)
		.filter((key) => key.startsWith(LEGACY_ENV_PREFIX) && env[key] !== undefined)
		.sort()
		.map((name) => ({ name, replacement: `${ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}` }));
}

export type RuntimeDirMigration =
	| { action: "none" }
	| { action: "migrated"; from: string; to: string; compatLink: boolean }
	| { action: "legacy_ignored"; legacy: string; current: string };

function isRealDir(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * 把旧运行时目录迁移到新名字。
 * - 只有旧目录：改名，并在原位置留软链接（建软链接失败不影响迁移，`compatLink: false`）；
 * - 新旧都有（且旧的不是软链接）：用新目录，旧目录原样保留；
 * - 其它情况：什么都不做。
 * 改名失败时抛出异常（不在迁移了一半的状态下启动）。
 */
export function migrateRuntimeDir(homeDir: string): RuntimeDirMigration {
	const current = join(homeDir, RUNTIME_DIR_NAME);
	const legacy = join(homeDir, LEGACY_RUNTIME_DIR_NAME);
	if (!isRealDir(legacy)) return { action: "none" };
	if (existsSync(current)) return { action: "legacy_ignored", legacy, current };
	renameSync(legacy, current);
	let compatLink = true;
	try {
		symlinkSync(RUNTIME_DIR_NAME, legacy, "dir");
	} catch {
		compatLink = false;
	}
	return { action: "migrated", from: legacy, to: current, compatLink };
}

/**
 * 启动前准备运行时目录：旧环境变量告警、旧目录迁移。
 * 返回 false 表示迁移失败（已记日志），调用方不应继续启动。
 */
export function prepareRuntimeDir(homeDir: string, env: NodeJS.ProcessEnv, log: BridgeLogger): boolean {
	for (const item of deprecatedEnvNames(env)) log.warn("feishu.config.deprecated_env", item);
	try {
		const result = migrateRuntimeDir(homeDir);
		if (result.action === "migrated") log.info("feishu.config.migrated", { from: result.from, to: result.to, compatLink: result.compatLink });
		if (result.action === "legacy_ignored") log.warn("feishu.config.legacy_dir_ignored", { legacy: result.legacy, current: result.current });
		return true;
	} catch (error) {
		log.error("feishu.config.migrate_failed", {
			from: join(homeDir, LEGACY_RUNTIME_DIR_NAME),
			to: join(homeDir, RUNTIME_DIR_NAME),
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
