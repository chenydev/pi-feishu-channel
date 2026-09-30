/**
 * 可选能力测试的公共装置：从扩展入口启动一个完整实例，按「开 / 关」两种配置各测一次。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandDispatcher } from "../../src/commands/dispatch.js";
import { FeatureHost, type BridgeFeature, type FeatureContext } from "../../src/features/feature.js";
import { CardRouter } from "../../src/interaction/card-router.js";
import { BridgeRuntime } from "../../src/runtime/bridge-runtime.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../../src/types.js";
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

/** 不启动整个扩展，只用给定配置装配某几个能力（测挂接点本身）。 */
export async function featureHostFor(features: BridgeFeature[], config: Partial<BridgeConfig>, ctx: Partial<Pick<FeatureContext, "sendLocalFile">> = {}) {
	const logs: string[] = [];
	const push = (m: string) => { logs.push(m); };
	const log = { debug: push, info: push, warn: push, error: push };
	const rt = new BridgeRuntime();
	rt.config = { ...DEFAULT_CONFIG, ...config };
	// 运行时目录放在临时目录里：能力可能在这里写文件（附件、定时任务等）
	rt.homeDir = mkdtempSync(join(tmpdir(), "feature-"));
	const replier = () => ({ reply() {}, trySendCard: async () => false });
	const dispatcher = new CommandDispatcher({ log, isAdmin: () => false, replier, piCommands: () => [] });
	const cardRouter = new CardRouter({ log, admins: () => [] });
	const host = new FeatureHost(features, { dispatcher, cardRouter, log });
	await host.setup({ rt, log, replier, reconnectsLast5m: () => 0, sendLocalFile: ctx.sendLocalFile ?? (() => ({ ok: true })) });
	return { host, rt, logs, dispatcher, cardRouter };
}
