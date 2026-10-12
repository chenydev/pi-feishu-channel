import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/config.js";
import { formatDoctor, runDoctor } from "../src/runtime/doctor.js";
import { DEFAULT_CONFIG } from "../src/types.js";

test("doctor：不泄露 secret，逐项报告凭据/连接/身份/目录/管理员", () => {
	const home = mkdtempSync(join(tmpdir(), "feishu-doctor-"));
	try {
		const checks = runDoctor({
			config: { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], appId: "app", appSecret: "super-secret", admins: [] },
			paths: resolvePaths(home),
			transport: { isRunning: () => true, isConnected: () => false, getBotIdentity: () => ({}) },
		});
		const text = formatDoctor(checks);
		assert.match(text, /credentials: 已配置/);
		assert.match(text, /运行中但未连接/);
		assert.match(text, /默认拒绝/);
		assert.doesNotMatch(text, /super-secret/);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("doctor：旧版 PID 探针残留不会造成目录不可写假阴性", () => {
	const home = mkdtempSync(join(tmpdir(), "feishu-doctor-stale-"));
	try {
		const paths = resolvePaths(home);
		mkdirSync(paths.sessionDir, { recursive: true });
		mkdirSync(join(paths.outboxFile, ".."), { recursive: true });
		writeFileSync(join(paths.sessionDir, `.feishu-doctor-${process.pid}.tmp`), "stale", { mode: 0o600 });
		const checks = runDoctor({
			config: { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], appId: "app", appSecret: "secret", admins: ["admin"] },
			paths,
		});
		assert.equal(checks.find((check) => check.name === "session_dir")?.ok, true);
		assert.equal(checks.find((check) => check.name === "outbox_dir")?.ok, true);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

// ── pi-permission-system 授权链环节 ────────────────────────────────────
// 环节没生效（版本过低、authorizerChain 没写上）时 PS 的「询问」一律被拒绝，
// 而桥这边看不到任何调用 —— doctor 要显式说出来。

const LINK_OK = { installed: true, version: "40.1.3", versionOk: true, chain: ["feishu-channel"], inChain: true, registered: 2 };

test("doctor：环节可用时 ps_link 通过，并列出「始终批准」规则", () => {
	const checks = runDoctor({
		config: DEFAULT_CONFIG,
		paths: resolvePaths("/tmp/doctor-ps"),
		diagnostics: { psLink: { ...LINK_OK, alwaysApproved: { count: 1, patterns: ["echo PS-TEST-*"] } } },
	});
	const link = checks.find((c) => c.name === "ps_link");
	assert.equal(link?.ok, true);
	assert.match(link?.detail ?? "", /40\.1\.3/);
	assert.match(link?.detail ?? "", /2 个会话/);
	assert.match(checks.find((c) => c.name === "ps_always_approved")?.detail ?? "", /echo PS-TEST-\*/);
});

test("doctor：authorizerChain 没写上或版本过低时 ps_link 不通过", () => {
	const notInChain = runDoctor({
		config: DEFAULT_CONFIG,
		paths: resolvePaths("/tmp/doctor-ps"),
		diagnostics: { psLink: { ...LINK_OK, chain: undefined, inChain: false } },
	}).find((c) => c.name === "ps_link");
	assert.equal(notInChain?.ok, false);
	assert.match(notInChain?.detail ?? "", /authorizerChain 里没有 feishu-channel/);

	const tooOld = runDoctor({
		config: DEFAULT_CONFIG,
		paths: resolvePaths("/tmp/doctor-ps"),
		diagnostics: { psLink: { ...LINK_OK, version: "26.3.1", versionOk: false } },
	}).find((c) => c.name === "ps_link");
	assert.equal(tooOld?.ok, false);
	assert.match(tooOld?.detail ?? "", /26\.3\.1 过低（需要 ≥ 27\.0\.0）/);
});

test("doctor：未提供环节状态时不出这两项（不假装通过）", () => {
	const checks = runDoctor({ config: DEFAULT_CONFIG, paths: resolvePaths("/tmp/doctor-ps") });
	assert.equal(checks.some((c) => c.name === "ps_link" || c.name === "ps_always_approved"), false);
});

// ── permissions 项必须看「有效管理员」（本轮修的真 bug）────────────────
// 只看 config.admins 会误报：admins 常常是空的（本来就靠启动时自动查到的归属人），
// 于是诊断谎报"审批将默认拒绝"，而审批卡其实一直点得动。

test("doctor：只有隐式管理员（应用归属人）时也应判通过", () => {
	const config = { ...DEFAULT_CONFIG, admins: [], implicitAdmins: ["ou_owner"], appOwnerId: "ou_owner", appAdminIds: [] };
	const checks = runDoctor({ config, paths: resolvePaths("/tmp/doctor-imp") });
	const permissions = checks.find((c) => c.name === "permissions");
	assert.equal(permissions?.ok, true, "隐式管理员也算管理员 —— 否则会误报默认拒绝");
	assert.match(permissions?.detail ?? "", /可审批 1 人/);
	assert.match(permissions?.detail ?? "", /应用归属人 1 · 应用管理员 0 · 管理员（config.admins）0/, "按角色分开报，便于排查是否查到了归属人");
});

test("doctor：显式 + 隐式都为空时判不通过，并给出两条修复路径", () => {
	const config = { ...DEFAULT_CONFIG, admins: [], implicitAdmins: [] };
	const checks = runDoctor({ config, paths: resolvePaths("/tmp/doctor-none") });
	const permissions = checks.find((c) => c.name === "permissions");
	assert.equal(permissions?.ok, false);
	assert.match(permissions?.detail ?? "", /默认拒绝/);
	assert.match(permissions?.detail ?? "", /application:application:readonly/, "要指出查询归属人需要哪个 scope");
	assert.match(permissions?.detail ?? "", /admins 里显式配置/, "要给出后备方案");
});

test("doctor：开启开通申请时报告审批策略；owner 策略缺归属人判失败", () => {
	const base = { ...DEFAULT_CONFIG, admins: ["ou_admin"], onboarding: { accessRequest: true } };
	const missing = runDoctor({ config: base, paths: resolvePaths("/tmp/doctor-acc") }).find((c) => c.name === "access_approvers");
	assert.equal(missing?.ok, false);
	assert.match(missing?.detail ?? "", /仅应用归属人/);
	const ok = runDoctor({ config: { ...base, appOwnerId: "ou_owner", implicitAdmins: ["ou_owner"] }, paths: resolvePaths("/tmp/doctor-acc") }).find((c) => c.name === "access_approvers");
	assert.equal(ok?.ok, true);
	assert.equal(runDoctor({ config: DEFAULT_CONFIG, paths: resolvePaths("/tmp/doctor-acc") }).some((c) => c.name === "access_approvers"), false, "未开启时不出现");
});
