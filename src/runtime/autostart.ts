/**
 * pi 启动时是否自动连飞书。
 *
 * 扩展装在用户级设置里时，本机每个 pi 进程都会加载它（TUI、`pi -p`、编辑器插件拉起的 RPC 进程）。
 * 同一个应用只能有一条长连接，所以默认谁都不连：部署的进程显式设 `FEISHU_CHANNEL_ENABLED=1`，
 * 并且是 `pi --mode rpc` 启动的，才自动启动。开关用环境变量而不放进 config.json：
 * 配置文件是本机所有 pi 进程共用的，区分不了哪个进程该连。
 *
 * 不自动启动时 `/feishu:start` 仍可手动启动。
 */
import type { ExtensionRuntimeContext } from "../pi-types.js";
import { channelEnv } from "./identity.js";

/** 不自动启动的原因：`disabled` = 没设 `FEISHU_CHANNEL_ENABLED`；`mode` = 不是 RPC 模式。 */
export type AutoStartBlocker = "disabled" | "mode";

/** `FEISHU_CHANNEL_ENABLED` 为 `1` / `true` / `yes` / `on` 时打开，其余（含未设）都是关闭。 */
export function channelEnabled(env: NodeJS.ProcessEnv): boolean {
	const raw = channelEnv(env, "ENABLED")?.trim().toLowerCase();
	return raw !== undefined && ["1", "true", "yes", "on"].includes(raw);
}

/**
 * 返回不自动启动的原因，可以启动时返回 undefined。
 * `mode` 缺失（老版本 pi 的 ctx 上没有）时不按模式拦，只看开关。
 */
export function autoStartBlocker(mode: ExtensionRuntimeContext["mode"], env: NodeJS.ProcessEnv): AutoStartBlocker | undefined {
	if (!channelEnabled(env)) return "disabled";
	if (mode && mode !== "rpc") return "mode";
	return undefined;
}
