/**
 * 可选能力测试的公共装置：从扩展入口启动一个完整实例，按「开 / 关」两种配置各测一次。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarness, type Harness } from "../integration/extension-harness.js";

export const ADMIN = "ou_admin";
export const USER = "ou_user";
export const GROUP = "oc_group";
export const DM = "oc_dm";

export const BASE = {
	admins: [ADMIN],
	allowUsers: [USER],
	allowChats: [GROUP],
	groupPolicy: "mention",
};

export const T = { timeout: 10_000 };

export async function withHarness(config: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
	const h = await startHarness({ ...BASE, ...config });
	try { await body(h); } finally { await h.stop(); }
}

/** status.json 与启动日志里列出的已启用能力。 */
export function enabledIn(h: Harness): { status: string[]; log: string[] } {
	const status = JSON.parse(readFileSync(join(h.home, "feishu-bridge", "status.json"), "utf8")) as { features?: string[] };
	const line = h.logs.find((l) => l.event === "feishu.bridge.features");
	return { status: status.features ?? [], log: (line?.meta as { enabled?: string[] } | undefined)?.enabled ?? [] };
}

/** 某个前缀的日志事件是否出现过。 */
export function hasLogPrefix(h: Harness, prefix: string): boolean {
	return h.logs.some((l) => l.event.startsWith(prefix));
}
