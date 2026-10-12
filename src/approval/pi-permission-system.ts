/**
 * @gotgenes/pi-permission-system（下称 PS）在本机的位置、版本与跨扩展服务。
 *
 * PS 的配置在 pi 配置目录下：
 * 优先 `PI_CODING_AGENT_DIR`，其次 pi 的 agent 目录（`session_start` 时由 runtime/agent-dir.ts 解析后记下），
 * 最后才猜 `cwd/pi-agent` —— 只猜 cwd 在非容器环境里会指错。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 本扩展在 PS 授权链里的名字：运维要把它写进 PS 配置的 `authorizerChain` 才生效。 */
export const PS_LINK_NAME = "feishu-channel";

/**
 * 支持的最低 PS 版本。27.0.0 起服务按会话 id 发布（`getPermissionsService(sessionId)`），
 * `permissions:ready` 带 `sessionId` 并可能重复触发；更早的版本只有进程级的单个服务，
 * 授权链环节会注册到错误的会话上。
 */
export const PS_MIN_VERSION = "27.0.0";

let reportedAgentDir: string | undefined;

/** 记下 pi 的 agent 目录（`session_start` 时调用）。 */
export function setReportedAgentDir(dir: string | undefined): void {
	reportedAgentDir = dir;
}

export function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? reportedAgentDir ?? join(process.cwd(), "pi-agent");
}

/** PS 的全局配置文件（项目级配置在 `<cwd>/.pi/extensions/pi-permission-system/config.json`，这里不看）。 */
export function psConfigFile(): string {
	return join(resolveAgentDir(), "extensions", "pi-permission-system", "config.json");
}

function psPackageDirs(agentDir: string): string[] {
	return [
		join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system"),
		join(agentDir, "extensions", "pi-permission-system"),
	];
}

/**
 * 检查 PS 是否真的装在 pi 配置目录里。
 * 用途：审批模式为 pi-permission-system 时的默认拒绝判定 —— 若扩展缺席，
 * 桥的审批就是唯一防线，此时必须继续用自己的策略而不是静默放行。
 *
 * 每次工具调用都会判定一次，结果缓存 60 秒（装/卸扩展本来就要重启才生效）。
 */
let installedCache: { at: number; dir: string; value: boolean } | undefined;
export function piPermissionSystemInstalled(): boolean {
	const agentDir = resolveAgentDir();
	const now = Date.now();
	if (installedCache && installedCache.dir === agentDir && now - installedCache.at < 60_000) return installedCache.value;
	const value = psPackageDirs(agentDir).some((dir) => {
		try {
			return existsSync(join(dir, "package.json"));
		} catch {
			return false;
		}
	});
	installedCache = { at: now, dir: agentDir, value };
	return value;
}

/** 已安装的 PS 版本；没装或读不出来时为 undefined。 */
export function piPermissionSystemVersion(agentDir: string = resolveAgentDir()): string | undefined {
	for (const dir of psPackageDirs(agentDir)) {
		try {
			const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
			if (typeof version === "string" && version) return version;
		} catch {
			// 下一个候选
		}
	}
	return undefined;
}

/** `version` 是否不低于 `min`（只比 major.minor.patch，预发布后缀忽略）。 */
export function versionAtLeast(version: string, min: string = PS_MIN_VERSION): boolean {
	const parse = (value: string) => value.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const a = parse(version);
	const b = parse(min);
	for (let i = 0; i < 3; i += 1) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	}
	return true;
}

/** PS 全局配置里的 `authorizerChain`；文件不存在或字段缺失时为 undefined。 */
export function psAuthorizerChain(file: string = psConfigFile()): string[] | undefined {
	try {
		const chain = (JSON.parse(readFileSync(file, "utf8")) as { authorizerChain?: unknown }).authorizerChain;
		return Array.isArray(chain) ? chain.filter((item): item is string => typeof item === "string") : undefined;
	} catch {
		return undefined;
	}
}

/** 授权链环节能不能生效：装没装、版本够不够、`authorizerChain` 里有没有写上本扩展。 */
export interface PsLinkStatus {
	installed: boolean;
	version?: string;
	versionOk: boolean;
	/** PS 全局配置里的 `authorizerChain`（未配置为 undefined）。 */
	chain?: string[];
	inChain: boolean;
}

export function psLinkStatus(agentDir: string = resolveAgentDir()): PsLinkStatus {
	const version = piPermissionSystemVersion(agentDir);
	const chain = psAuthorizerChain(join(agentDir, "extensions", "pi-permission-system", "config.json"));
	return {
		installed: version !== undefined,
		version,
		versionOk: version !== undefined && versionAtLeast(version),
		chain,
		inChain: chain?.includes(PS_LINK_NAME) ?? false,
	};
}

// ------------------------------------------------------------ 跨扩展服务 ----

/** 授权链环节的裁决（PS 的 `AuthorizerVerdict`）。 */
export type PsVerdict = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" };

/** 环节拿到的策略查询能力（PS 的 `PermissionQuery`，只声明用到的部分）。 */
export interface PsQuery {
	checkPermission(surface: string, value?: string, agentName?: string): { state: string; matchedPattern?: string };
}

/** 环节拿到的审查日志（PS 的 `AuthorizerLog`）。 */
export interface PsAuthorizerLog {
	review(event: string, details?: Record<string, unknown>): void;
}

/**
 * 一次「询问」的描述（PS 的 `PromptPermissionDetails`，只声明读到的字段，且都按可缺省处理：
 * 本扩展不 import PS 的类型，字段多了少了都不能让判定崩掉）。
 */
export interface PsAskDetails {
	requestId?: string;
	toolCallId?: string;
	toolName?: string;
	command?: string;
	path?: string;
	surface?: string | null;
	value?: string | null;
	payload?: {
		kind?: string;
		request?: {
			requester?: { agentName?: string | null; forwarded?: boolean; sessionId?: string | null };
			surface?: string;
			toolName?: string | null;
			value?: string;
			matchedPattern?: string | null;
			executedUnit?: string | null;
			commandContext?: unknown;
		};
		evidence?: ReadonlyArray<{ label?: string; text?: string }>;
	};
	accessIntent?: {
		surface?: string;
		askingUnits?: ReadonlyArray<{ command?: string; floor?: string }>;
	};
}

export type PsAuthorize = (details: PsAskDetails, query: PsQuery, log: PsAuthorizerLog) => Promise<PsVerdict>;

/** PS 的 `PermissionsService` 里本扩展用到的部分。 */
export interface PsService {
	registerAuthorizer(name: string, authorize: PsAuthorize): () => void;
}

/**
 * PS 发布服务的进程级槽位：`Map<sessionId, PermissionsService>`。
 *
 * 官方用法是 `import("@gotgenes/pi-permission-system")` 后调 `getPermissionsService(sessionId)`，
 * 它读的就是这个槽位。本扩展常以本地路径加载，包名解析不到 PS 的安装目录，所以直接读槽位；
 * 槽位名自 27.0.0（按会话发布）起未变，低于该版本的 PS 由版本检查拦下。
 */
const PS_SESSION_SERVICES_KEY = Symbol.for("@gotgenes/pi-permission-system:session-services");

/** 某个会话的 PS 服务；PS 没在该会话加载、或服务上没有 `registerAuthorizer` 时为 undefined。 */
export function psServiceFor(sessionId: string, store: Record<symbol, unknown> = globalThis as Record<symbol, unknown>): PsService | undefined {
	const services = store[PS_SESSION_SERVICES_KEY];
	if (!(services instanceof Map)) return undefined;
	const service = services.get(sessionId) as Partial<PsService> | undefined;
	return typeof service?.registerAuthorizer === "function" ? (service as PsService) : undefined;
}
