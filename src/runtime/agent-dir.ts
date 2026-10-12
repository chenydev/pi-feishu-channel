/**
 * pi 的 agent 配置目录（`~/.pi/agent` 一类）。
 *
 * pi 传给扩展的 API 对象上**没有** `getAgentDir`：它是 `@earendil-works/pi-coding-agent` 的模块导出。
 * 所以这里按需导入包；导入不到时按 pi 自己的规则推算：`PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`。
 */
import { homedir } from "node:os";
import { join } from "node:path";

type PiSdkModule = { getAgentDir?: () => string };

export async function loadPiAgentDir(
	importSdk: () => Promise<unknown> = () => import("@earendil-works/pi-coding-agent"),
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	try {
		const sdk = (await importSdk()) as PiSdkModule;
		const dir = sdk.getAgentDir?.();
		if (dir) return dir;
	} catch {
		/* 包不可用：退回下面的推算 */
	}
	const fromEnv = env.PI_CODING_AGENT_DIR;
	if (fromEnv) return fromEnv === "~" ? homedir() : fromEnv.startsWith("~/") ? join(homedir(), fromEnv.slice(2)) : fromEnv;
	return join(homedir(), ".pi", "agent");
}
