import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { FeishuTransport, type LarkSdkLike } from "../src/inbound/transport.js";
import { DEFAULT_CONFIG } from "../src/types.js";

interface WsOptions {
	onReady?: () => void;
	onError?: (error: unknown) => void;
	onReconnecting?: () => void;
	onReconnected?: () => void;
	autoReconnect?: boolean;
	extraUaTags?: string[];
}

function fakeSdk(historyItems: unknown[] = [], resource = Buffer.from("resource")) {
	const requests: Array<{ url: string; method: string; params?: unknown }> = [];
	const sockets: FakeWs[] = [];
	const handlers: Record<string, (data: unknown) => unknown> = {};
	class FakeClient {
		im = { v1: {
			messageResource: { get: async () => ({ getReadableStream: () => Readable.from([resource]), headers: { "content-type": "image/png", "content-length": String(resource.length) } }) },
			image: { create: async () => ({ data: { image_key: "img_uploaded" } }) },
			file: { create: async () => ({ file_key: "file_uploaded" }) },
		} };
		async request(opts: { url: string; method: string; params?: unknown }) {
			requests.push(opts);
			if (opts.url === "/open-apis/bot/v3/info") return { bot: { open_id: "ou_bot", bot_name: "Bot" } };
			if (opts.url === "/open-apis/im/v1/messages") return { data: { items: historyItems } };
			return { code: 0 };
		}
	}
	class FakeDispatcher {
		register(next: Record<string, (data: unknown) => unknown>) { Object.assign(handlers, next); return this; }
	}
	class FakeWs {
		status: string | { state: string } = "idle";
		closed = 0;
		closeParams: Array<{ force?: boolean } | undefined> = [];
		constructor(readonly opts: WsOptions) { sockets.push(this); }
		start() { this.status = "connected"; this.opts.onReady?.(); }
		close(params?: { force?: boolean }) { this.closed += 1; this.closeParams.push(params); this.status = "idle"; }
		getConnectionStatus() { return this.status; }
	}
	const sdk = {
		Domain: { Feishu: "feishu", Lark: "lark" },
		Client: FakeClient,
		WSClient: FakeWs,
		EventDispatcher: FakeDispatcher,
	} as unknown as LarkSdkLike;
	return { sdk, requests, sockets, handlers };
}

function transport(sdk: LarkSdkLike, over: { now?: () => number; statuses?: string[]; onCardAction?: (action: import("../src/inbound/transport.js").CardAction) => Promise<unknown>; onMessage?: (msg: import("../src/types.js").FeishuInboundMessage) => Promise<void>; cardActionBudgetMs?: number } = {}) {
	return new FeishuTransport({
		cardActionBudgetMs: over.cardActionBudgetMs,
		config: { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], appId: "app", appSecret: "secret" },
		sdk,
		onMessage: over.onMessage ?? (async () => {}),
		onStatus: (state) => over.statuses?.push(state),
		onCardAction: over.onCardAction,
		now: over.now,
	});
}

test("transport：并发 reconnect 只创建一个新 WS 生命周期", async () => {
	const fake = fakeSdk();
	const instance = transport(fake.sdk);
	await instance.start();
	assert.equal(fake.sockets.length, 1);
	await Promise.all([instance.reconnect(), instance.reconnect(), instance.reconnect()]);
	assert.equal(fake.sockets.length, 2);
	assert.equal(fake.sockets[0].closed, 1);
	assert.equal(instance.isConnected(), true);
});

test("transport：显式 stop 可使并发 reconnect 失效，不会停止后复活 WS", async () => {
	const fake = fakeSdk();
	const instance = transport(fake.sdk);
	await instance.start();
	const reconnecting = instance.reconnect();
	await instance.stop();
	await reconnecting;
	assert.equal(instance.isRunning(), false);
	assert.equal(instance.isConnected(), false);
	assert.equal(fake.sockets.length, 1);
});

test("transport：downSince 首次断线固定，ready 后清除", async () => {
	let now = 100;
	const statuses: string[] = [];
	const fake = fakeSdk();
	const instance = transport(fake.sdk, { now: () => now, statuses });
	await instance.start();
	fake.sockets[0].opts.onError?.(new Error("down"));
	assert.equal(instance.getDownSince(), 100);
	now = 200;
	fake.sockets[0].opts.onError?.(new Error("still down"));
	assert.equal(instance.getDownSince(), 100);
	await instance.reconnect();
	assert.equal(instance.getDownSince(), undefined);
	assert.deepEqual(statuses, ["connected", "error", "error", "connected"]);
});

test("transport：SDK 静默掉线可由 getConnectionStatus 探测", async () => {
	const now = 300;
	const statuses: string[] = [];
	const fake = fakeSdk();
	const instance = transport(fake.sdk, { now: () => now, statuses });
	await instance.start();
	fake.sockets[0].status = "idle";
	assert.equal(instance.isConnected(), false);
	assert.equal(instance.getDownSince(), 300);
	assert.equal(statuses.at(-1), "error");
});

test("transport：兼容 SDK 对象形式的连接状态", async () => {
	const statuses: string[] = [];
	const fake = fakeSdk();
	const instance = transport(fake.sdk, { statuses });
	await instance.start();
	fake.sockets[0].status = { state: "connected" };
	assert.equal(instance.isConnected(), true);
	assert.equal(statuses.at(-1), "connected");
	fake.sockets[0].status = { state: "failed" };
	assert.equal(instance.isConnected(), false);
	assert.equal(statuses.at(-1), "error");
});

test("transport：按 chat 有界拉取历史并映射为标准消息", async () => {
	const fake = fakeSdk([{
		message_id: "om_history",
		chat_id: "oc_chat",
		chat_type: "group",
		msg_type: "text",
		body: { content: JSON.stringify({ text: "补收消息" }) },
		sender: { id: "ou_user", id_type: "open_id", sender_type: "user" },
		parent_id: "om_parent",
		thread_id: "om_thread",
	}]);
	const instance = transport(fake.sdk);
	await instance.start();
	const messages = await instance.listChatHistory("oc_chat", 1_500, 9_100, 100);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].messageId, "om_history");
	assert.equal(messages[0].senderId, "ou_user");
	assert.equal(messages[0].text, "补收消息");
	assert.equal(messages[0].threadId, "om_thread");
	const historyRequest = fake.requests.find((request) => request.url === "/open-apis/im/v1/messages");
	assert.deepEqual(historyRequest?.params, {
		container_id_type: "chat",
		container_id: "oc_chat",
		start_time: "1",
		end_time: "10",
		sort_type: "ByCreateTimeAsc",
		page_size: 50,
	});
});

test("transport：下载资源校验声明与实际大小", async () => {
	const fake = fakeSdk([], Buffer.from([1, 2, 3]));
	const instance = transport(fake.sdk);
	await instance.start();
	const downloaded = await instance.downloadResource({ kind: "image", key: "img", messageId: "om" }, 3);
	assert.deepEqual(downloaded.buffer, Buffer.from([1, 2, 3]));
	assert.equal(downloaded.mimeType, "image/png");
	await assert.rejects(() => instance.downloadResource({ kind: "image", key: "img", messageId: "om" }, 2), /resource too large/);
});

test("transport：图片与文件上传返回资源 key", async () => {
	const fake = fakeSdk();
	const instance = transport(fake.sdk);
	await instance.start();
	assert.equal(await instance.uploadImage(Buffer.from("image")), "img_uploaded");
	assert.equal(await instance.uploadFile("report.pdf", Buffer.from("file")), "file_uploaded");
});

test("transport：card.action.trigger 规范化 message/chat/operator/value", async () => {
	const fake = fakeSdk();
	let captured: unknown;
	const instance = transport(fake.sdk, { onCardAction: async (action) => { captured = action; return { toast: { content: "ok" } }; } });
	await instance.start();
	const response = await fake.handlers["card.action.trigger"]?.({
		context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
		operator: { open_id: "ou_admin" }, action: { value: { op: "approval", approvalId: "a" } },
	});
	assert.deepEqual(captured, { messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_admin", token: undefined, value: { op: "approval", approvalId: "a" } });
	assert.deepEqual(response, { toast: { content: "ok" } });
});

test("SDK 重连：开启 SDK 自带重连、带 channel UA 标签；关闭时发 CLOSE 帧（非 force）", async () => {
	const fake = fakeSdk();
	const instance = transport(fake.sdk);
	await instance.start();
	assert.equal(fake.sockets[0].opts.autoReconnect, true);
	assert.deepEqual(fake.sockets[0].opts.extraUaTags, ["channel"]);
	await instance.stop();
	assert.deepEqual(fake.sockets[0].closeParams, [undefined], "必须走 close() 而不是 terminate");
});

test("SDK 重连：onReconnecting → 断线（记 downSince），onReconnected → 恢复；SDK 自动重连期间 isSelfHealing=true", async () => {
	let now = 1_000;
	const statuses: string[] = [];
	const fake = fakeSdk();
	const instance = transport(fake.sdk, { now: () => now, statuses });
	await instance.start();
	const ws = fake.sockets[0];
	ws.status = { state: "reconnecting" };
	ws.opts.onReconnecting?.();
	assert.equal(instance.isConnected(), false);
	assert.equal(instance.isSelfHealing(), true);
	assert.equal(instance.getDownSince(), 1_000);
	now = 5_000;
	ws.status = { state: "connected" };
	ws.opts.onReconnected?.();
	assert.equal(instance.isConnected(), true);
	assert.equal(instance.getDownSince(), undefined);
	assert.deepEqual(statuses, ["connected", "reconnecting", "connected"]);
	ws.status = { state: "failed" };
	assert.equal(instance.isSelfHealing(), false, "终态不算自动重连中，交给 supervisor 重建");
});

test("SDK 重连：transport.sdkAutoReconnect=false 退回自管模式", async () => {
	const fake = fakeSdk();
	const instance = new FeishuTransport({
		config: { ...DEFAULT_CONFIG, appId: "app", appSecret: "secret", transport: { sdkAutoReconnect: false } },
		sdk: fake.sdk, onMessage: async () => {},
	});
	await instance.start();
	assert.equal(fake.sockets[0].opts.autoReconnect, false);
	fake.sockets[0].status = { state: "reconnecting" };
	assert.equal(instance.isSelfHealing(), false);
});

test("回调处理：消息回调立即返回，后台按 chat 串行处理", async () => {
	const fake = fakeSdk();
	const seen: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const instance = transport(fake.sdk, {
		onMessage: async (msg) => { if (msg.messageId === "om_1") await gate; seen.push(msg.messageId); },
	});
	await instance.start();
	const event = (id: string, chat: string) => ({ event: {
		sender: { sender_id: { open_id: "ou_u" }, sender_type: "user" },
		message: { message_id: id, chat_id: chat, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: id }) },
	} });
	const returned = fake.handlers["im.message.receive_v1"](event("om_1", "oc_a"));
	assert.equal(returned, undefined, "回调不得返回 Promise 让 SDK 等待");
	fake.handlers["im.message.receive_v1"](event("om_2", "oc_a"));
	fake.handlers["im.message.receive_v1"](event("om_3", "oc_b"));
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(seen, ["om_3"], "别的 chat 不被阻塞；同 chat 保序等待");
	assert.equal(instance.inboundPending(), 2);
	release();
	await instance.drainInbound();
	assert.deepEqual(seen, ["om_3", "om_1", "om_2"]);
	assert.equal(instance.inboundPending(), 0);
});

test("回调处理：卡片回调超出预算先回 toast，算完用 PATCH 刷卡", async () => {
	const fake = fakeSdk();
	let finish!: (v: unknown) => void;
	const instance = transport(fake.sdk, {
		cardActionBudgetMs: 20,
		onCardAction: () => new Promise((resolve) => { finish = resolve; }),
	});
	await instance.start();
	const res = await fake.handlers["card.action.trigger"]({
		operator: { open_id: "ou_op" }, token: "tok_1",
		context: { open_message_id: "om_card", open_chat_id: "oc_a" }, action: { value: { op: "x" } },
	}) as { toast?: { content: string } };
	assert.equal(res.toast?.content, "处理中…");
	finish({ card: { type: "raw", data: { hello: 1 } } });
	await new Promise((r) => setTimeout(r, 10));
	const patch = fake.requests.find((r) => r.method === "PATCH" && r.url.endsWith("/om_card"));
	assert.ok(patch, "迟到的结果卡要 PATCH 上去");
});

test("引用原文：引用原文对 post 消息返回可读文本（不是原始 JSON）；卡片返回 undefined", async () => {
	const fake = fakeSdk();
	const instance = transport(fake.sdk);
	await instance.start();
	const client = (instance as unknown as { client: { request: (opts: { url: string }) => Promise<unknown> } }).client;
	const original = client.request.bind(client);
	client.request = async (opts) => {
		if (opts.url.endsWith("/om_post")) return { data: { items: [{ msg_type: "post", body: { content: JSON.stringify({ title: "周报", content: [[{ tag: "text", text: "本周完成了 A" }]] }) } }] } };
		if (opts.url.endsWith("/om_card")) return { data: { items: [{ msg_type: "interactive", body: { content: JSON.stringify({ type: "card", data: { card_id: "c" } }) } }] } };
		return original(opts);
	};
	const text = await instance.getMessageText("om_post");
	assert.ok(text?.includes("本周完成了 A"), String(text));
	assert.ok(!text?.includes("\"tag\""), "不能把 JSON 塞进提示词");
	assert.equal(await instance.getMessageText("om_card"), undefined);
});

test("语音时长：Ogg Opus 时长解析（最后一页 granule / 48k）", async () => {
	const { oggOpusDurationMs } = await import("../src/inbound/transport.js");
	const page = (granule: bigint) => { const b = Buffer.alloc(27); b.write("OggS", 0); b.writeBigInt64LE(granule, 6); return b; };
	assert.equal(oggOpusDurationMs(Buffer.concat([page(0n), page(48_000n * 3n)])), 3_000);
	assert.equal(oggOpusDurationMs(Buffer.from("not ogg")), undefined);
});
