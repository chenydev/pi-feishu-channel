/**
 * 单轮执行器 —— 从 ConversationManager 拆出的 `runOne`（一次 agent run 的完整生命周期：
 * 进度消息、流式卡片、事件订阅、空闲/总时长计时、最终交付、失败通知、收尾清账）。
 *
 * 会话表、队列、调度和命令都不在这里；执行器只通过 `RunHost` 访问管理器的少量能力，
 * 便于单独阅读和测试 "一轮是怎么跑完的"。
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedTurnResources } from "../inbound/resource-resolver.js";
import { adaptAgentEvent } from "../outbound/agent-event-adapter.js";
import type { LiveChannel } from "../outbound/live-channel.js";
import { createRunMetrics, elapsedMs as metricsElapsedMs, recordUsage, stripMarkdown } from "../outbound/run-metrics.js";
import { StreamingCard } from "../outbound/streaming-card.js";
import { resolveFooterEnabled } from "../config.js";
import type { RateBudget } from "../runtime/rate-budget.js";
import type { DeliveryTarget, PiImageContent } from "../types.js";
import type { AgentHandle, BridgeSession, ConversationManagerDeps, QueuedMessage } from "./conversation-manager.js";
import { PROGRESS_HEARTBEAT_MS, type ProgressTracker } from "./progress-tracker.js";
import { classifyRunError, newErrorId } from "./run-errors.js";
import { extractAssistantText, stripContextPrefix, stripInjectedPrompt } from "./text-utils.js";

type RunMetrics = ReturnType<typeof createRunMetrics>;

/** 执行器需要的管理器能力（全部由 ConversationManager 在构造时提供）。 */
export interface RunHost {
	readonly shuttingDown: boolean;
	readonly runIdleTimeoutMs: number;
	readonly runMaxDurationMs: number;
	readonly progress: ProgressTracker;
	readonly liveChannel?: LiveChannel;
	readonly rateBudget: RateBudget;
	now(): number;
	ensureAgentSession(sess: BridgeSession): Promise<AgentHandle>;
	prepareAgentInput(item: QueuedMessage, conversationKey: string): Promise<{ text: string; images?: PiImageContent[]; resources?: ResolvedTurnResources }>;
	touchRunActivity(sess: BridgeSession): void;
	footerFor(metrics: RunMetrics, sess: BridgeSession): string;
	rememberSentFooter(footer: string): void;
	recordRunUsage(sess: BridgeSession, item: QueuedMessage, metrics: RunMetrics): Promise<void>;
	removeProcessingReaction(sess: BridgeSession, item: QueuedMessage): Promise<void>;
	clearPending(item: QueuedMessage): void;
	notify(chatId: string, text: string, opts?: { replyTo?: string; threadId?: string }, dedupeKey?: string, laneKey?: string, kind?: "error" | "notify"): Promise<boolean>;
}

export class RunExecutor {
	constructor(private readonly deps: ConversationManagerDeps, private readonly host: RunHost) {}

	async run(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		const logMeta = (meta: Record<string, unknown> = {}): Record<string, unknown> => ({
			messageId: item.messageId,
			conversationKey: sess.conversationKey,
			runId: item.runId,
			...meta,
		});
		sess.lastActivityAt = this.host.now();
		sess.lastItem = item;
		const st = this.host.progress.state(sess.conversationKey);
		// 进度消息的回复目标：轮换新消息（编辑配额用尽）时沿用，保持阅读顺序。
		st.replyTo = item.replyTo;
		st.threadId = sess.threadId ?? item.threadId;
		let progressTimer: ReturnType<typeof setInterval> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;
		let activeAgent: BridgeSession["agent"];
		let durableHandled = false;
		let runSucceeded = false;
		let runTimedOut = false;
		let modelErrorOnly = false;
		// run 级指标（模型/耗时/token/费用估算），final 页脚用。
		const metrics = createRunMetrics();
		let resolvedResources: ResolvedTurnResources | undefined;
		// 流式卡片句柄（默认关闭）。声明在 try 外，finally 里才能收尾。
		let streamCard: StreamingCard | undefined;
		// 流式卡片启用时答案是卡片；进度仍然要有一条**自己的**可编辑消息。
		// 非聊天交付目标（云文档评论）—— 没有可编辑的会话消息：不发进度/卡片/页脚。
		const external = item.deliverTo;
		const cardMode = Boolean(this.deps.config.streamingCard?.enabled && this.deps.rawRequest) && !external;
		this.deps.log?.("debug", "feishu.conv.card_mode", {
			cardMode,
			configured: Boolean(this.deps.config.streamingCard?.enabled),
			hasRawRequest: Boolean(this.deps.rawRequest),
			throttleMs: this.deps.config.streamingCard?.throttleMs,
			progressMode: this.host.progress.mode,
		});
		try {
			// 进度消息：
			// - 非卡片模式：这条消息同时是**流式草稿的载体**（首 token 前显示进度、之后变成答案），
			//   所以与进度档位无关，必须发（否则连流式吐字一起没了）；
			// - 卡片模式：答案是卡片，进度需要自己的消息 —— 旧代码用 `if (!cardMode)` 把这段整段跳过，
			//   导致开了流式卡片后**完全没有执行进度**。
			if (cardMode && this.host.progress.mode !== "off") {
				// 卡片模式懒创建（首个工具行才发），计时从现在算
				st.lazy = true;
				st.startedAt = this.host.now();
			} else if (!cardMode && !external) {
				const sent = await this.deps.sender.send(item.chatId, "🤖 正在处理…", {
					replyTo: item.replyTo,
					threadId: sess.threadId ?? item.threadId,
				});
				if (sent.success && sent.messageId) {
					st.messageId = sent.messageId;
					st.startedAt = this.host.now();
					this.host.liveChannel?.open(sess.conversationKey, sent.messageId);
					st.liveTarget = true;
				}
			}
			if (this.host.shuttingDown) throw new Error("bridge shutting down");

			activeAgent = await this.host.ensureAgentSession(sess);
			// shutdown 可能发生在异步 session 初始化完成之后、prompt 开始之前。
			if (this.host.shuttingDown || sess.agent !== activeAgent) throw new Error("bridge shutting down");

			// 流式/完成事件：从 subscribe 事件提取回复文本（pi SDK 的 prompt() 返回值
			// 结构不可靠，pi-feishu-link 同样走事件通道：message_update.text_delta 累积、
			// message_end.content 完整提取）。
			let streamedText = "";
			// 卡片用累积文本：`streamedText` 会在每轮 message_end/turn_end 清空
			// （多轮工具场景只保留最后一轮作为最终答案），但卡片要展示"到目前为止的全部输出"，
			// 所以单独维护一份不清空的累积值 —— 否则卡片永远只拿到空串（实测 deltaCount=1053 而 streamedLen=0）。
			let cardText = "";
			let deltaCount = 0;
			// 埋点：模型真实输出窗口（用来把「模型慢」和「卡片拖慢」分开）
			let firstDeltaAt: number | undefined;
			let lastDeltaAt: number | undefined;
			let lastEndText = "";
			let agentError: string | undefined;
			let sentFromEvent = false;
			const preparedInput = await this.host.prepareAgentInput(item, sess.conversationKey);
			const injectedPrompt = preparedInput.text;
			resolvedResources = preparedInput.resources;
			const sendReply = async (text: string): Promise<void> => {
				if (sentFromEvent || !text.trim()) return;
				try {
					this.deps.log?.("debug", "feishu.conv.send_reply_start", logMeta({ chatId: sess.chatId, textLen: text.length }));
					// 模型偶发复述注入的引用块/提示：剥离后发送
					const cleaned = stripInjectedPrompt(text, injectedPrompt);
					if (!cleaned.trim()) {
						// 纯引用残留（无实际内容）：静默跳过，不报错
						this.deps.log?.("debug", "feishu.conv.empty_after_strip", logMeta({ chatId: sess.chatId }));
						durableHandled = true;
						return;
					}
					if (external) {
						const delivered = await this.deliverExternal(external, cleaned, item);
						if (delivered) { sentFromEvent = true; durableHandled = true; }
						return;
					}
					// 回复挂用户消息（hermes: reply_to = source.message_id）；
					// 话题会话发送到话题（threadId 优先会话级，其次消息级）
					const liveMessageId = await this.host.liveChannel?.claimFinalTarget(sess.conversationKey);
					const sendOpts = {
						replyTo: item.replyTo,
						threadId: sess.threadId ?? item.threadId,
						editMessageId: liveMessageId,
					};
					let envelopeId: string | undefined;
					const res = this.deps.durableOutbox
						? (() => {
							const ids = this.deps.durableOutbox!.enqueue(sess.chatId, cleaned, sendOpts, {
								dedupeKey: `${item.messageId}:final`, laneKey: sess.conversationKey, kind: "final",
							});
							envelopeId = ids[0];
							return { success: ids.length > 0, messageId: undefined, error: undefined, fallback: undefined };
						})()
						: await this.deps.sender.send(sess.chatId, cleaned, sendOpts);
					if (res.success) {
						sentFromEvent = true;
						durableHandled = true;
						if (liveMessageId) st.messageId = undefined;
					}
					this.deps.log?.("info", "feishu.conv.reply_sent", logMeta({
						chatId: sess.chatId,
						envelopeId,
						success: res.success,
						sentMessageId: res.messageId,
						error: res.error,
						fallback: res.fallback,
						textLen: text.trim().length,
					}));
				} catch (err) {
					this.deps.log?.("error", "feishu.conv.send_error", logMeta({
						chatId: sess.chatId,
						error: err instanceof Error ? err.message : String(err),
					}));
				}
			};
			unsubscribe = activeAgent.subscribe((ev) => {
				// 任何事件都算「有产出」：重置空闲计时器（长时间工具/长回答不该被误杀）
				this.host.touchRunActivity(sess);
				// message_update 风暴降噪：只打非 text_delta 的 update（tool 事件等）
				const evType = (ev as { type?: string })?.type ?? "?";
				if (evType === "message_update") {
					const ame = (ev as { assistantMessageEvent?: { type?: string } })?.assistantMessageEvent;
					if (ame?.type === "text_delta") {
						// 静默：纯流式文本
					} else {
						this.deps.log?.("debug", "feishu.conv.event", logMeta({
							chatId: sess.chatId,
							type: evType,
							sub: ame?.type ?? (ev as { delta?: unknown }).delta !== undefined ? "delta" : "other",
						}));
					}
				} else {
					this.deps.log?.("debug", "feishu.conv.event", logMeta({
						chatId: sess.chatId,
						type: evType,
					}));
				}
				const adapted = adaptAgentEvent(ev);
				// 工具进度：订阅回调本来就在会话上下文里（不用猜 sessionId），
				// 因此这是主路径；`pi.on` 全局钩子是退路，两边靠 toolCallId 去重。
				if (adapted?.type === "tool_start") {
					this.host.progress.append(sess, adapted.toolName, adapted.args, adapted.toolCallId);
					return;
				}
				if (adapted?.type === "tool_end") {
					// 追加式日志：结束不改写已落地的行；只记失败次数（终态摘要）
					if (adapted.isError) st.toolErrors += 1;
					return;
				}
				if (adapted?.type === "text_delta") {
					deltaCount += 1;
					const nowMs = this.host.now();
					firstDeltaAt ??= nowMs;
					lastDeltaAt = nowMs;
					streamedText += adapted.delta;
					cardText += adapted.delta;
					this.host.liveChannel?.append(sess.conversationKey, adapted.delta);
					streamCard?.update(cardText);
					return;
				}
				if (adapted?.type === "message_end") {
					// 关键：user 消息也会触发 message_end（role=user），须先检查 role
					// （对齐 pi-feishu-link handleMessageEnd 的 role==='assistant' 检查）。
					// 多轮 agent：工具轮（stopReason=toolUse）也会 message_end——
					// 只记最后一轮文本，prompt() resolve（= agent 全部结束）后统一发送，
					// 避免中间轮文本（如"好的，再展开一层…"）被当最终回复发出。
					if (adapted.role !== "assistant") return;
					// assistant 用量按 messageId 去重后累加（跨工具多轮，重投不重复）
					recordUsage(metrics, {
						messageId: adapted.messageId, provider: adapted.provider,
						model: adapted.model, usage: adapted.usage,
					});
					if (adapted.stopReason === "error") {
						agentError = adapted.errorMessage?.trim() || "模型未返回具体错误信息";
						this.deps.log?.("error", "feishu.conv.agent_error_event", logMeta({
							chatId: sess.chatId,
							error: agentError,
							agentMessageId: adapted.messageId,
						}));
					} else {
						// SDK 重试可能在错误轮后补发成功轮；最终成功结果应清除暂存错误。
						agentError = undefined;
					}
					const text = adapted.text;
					this.deps.log?.("debug", "feishu.conv.message_end_extract", logMeta({
						chatId: sess.chatId,
						textLen: text?.length ?? 0,
						agentMessageId: adapted.messageId,
					}));
					if (text) lastEndText = text;
					streamedText = ""; // 新一轮从零累积
					return;
				}
				// 思考摘要仅在开启时累积（不持久化完整 reasoning）
				if (adapted?.type === "reasoning_delta" && this.deps.config.progress?.showThinking) {
					st.thinking = `${st.thinking ?? ""}${adapted.delta}`.slice(-500);
				}
				if (adapted?.type === "turn_end" && adapted.text) {
					lastEndText = adapted.text;
					streamedText = "";
				}
			});

			// 组装提示词（回复链路可见性）——对齐 hermes 的回复注入格式：
			// `[Replying to: "原文"]` 方括号元信息（非对话内容，模型不易复述）；
			// 区分回复自己消息 vs 回复他人消息；原文截断 500、占位转 @。
			// 启用时先建流式卡片；失败就静默降级（下面走原文本通道）
			if (cardMode) {
				streamCard = new StreamingCard({
					rawRequest: (opts) => { const rr = this.deps.rawRequest; if (!rr) throw new Error("rawRequest unavailable"); return rr(opts); },
					log: (level, message, meta) => this.deps.log?.(level, message, meta),
					throttleMs: this.deps.config.streamingCard?.throttleMs,
					printFrequencyMs: this.deps.config.streamingCard?.printFrequencyMs,
					printStep: this.deps.config.streamingCard?.printStep,
					budget: this.host.rateBudget,
					budgetScope: sess.conversationKey,
				});
				const started = await streamCard.start({
					chatId: sess.chatId,
					replyTo: item.replyTo,
					threadId: sess.threadId ?? item.threadId,
				}, "正在处理…", { withMetrics: resolveFooterEnabled(this.deps.config, sess.chatId).enabled });
				if (!started) streamCard = undefined;
			}

			// 周期刷新进度消息（增量更新：长时间处理时持续展示耗时与工具状态）
			progressTimer = setInterval(() => {
				void this.host.progress.render(sess, st);
			}, PROGRESS_HEARTBEAT_MS);

			// 双计时器：
			// - 空闲计时器：每次事件重置；长时间无产出才判卡死（默认 10 分钟）
			// - 总时长上限：仅当显式配置 > 0 时生效（默认不限，避免长任务被硬杀）
			const timeout = new Promise<never>((_, reject) => {
				sess.runIdleReject = reject;
				if (this.host.runIdleTimeoutMs > 0) this.host.touchRunActivity(sess);
				if (this.host.runMaxDurationMs > 0) {
					timeoutTimer = setTimeout(() => reject(new Error("run max duration exceeded")), this.host.runMaxDurationMs);
				}
			});
			const result = await Promise.race([activeAgent.prompt(injectedPrompt, preparedInput.images), timeout]);
			if (agentError) {
				// 模型侧错误（限流、上下文超限、提供方 5xx）不代表会话坏了 ——
				// 不必 dispose 整个会话（下一条消息重建要重新发现全部扩展与技能）。
				modelErrorOnly = true;
				throw new Error(agentError);
			}

			// 最终发送：最后一轮 message_end 文本优先，其次流式累积/返回值
			// 超长回答（开启时）正文只放开头，全文作为 .md 附件经持久 outbox 发送
			const answer = lastEndText || streamedText.trim() || extractAssistantText(result);
			const rawText = external ? answer : this.maybeReplyAsFile(answer, item, sess);
			// 评论区回复不带页脚（那是给聊天用的运行指标）
			const footer = external ? "" : this.host.footerFor(metrics, sess);
			// 卡片模式：页脚走**独立元素**（分割线 + 小号淡色块），不拼进答案正文
			const footerBlock = footer.replace(/^———\n/, "");
			// 留一份本轮快照，`/feishu usage` 用（会话被回收后自然消失）
			sess.lastRun = {
				...(metrics.model ? { model: metrics.model } : {}),
				tokens: { ...metrics.usage },
				cost: metrics.cost,
				hasCost: metrics.hasCost,
				elapsedMs: metricsElapsedMs(metrics),
			};
			// 文本通道不解析 markdown、也没有分割线元素：同一份页脚落到纯文本前要先剥标记
			// 与 `———` 标记（那是给卡片/引用剥离用的内部标记，不是给人看的字面内容）
			const footerPlain = footer ? stripMarkdown(footer.replace(/^———\n/, "")) : "";
			if (footerPlain) this.host.rememberSentFooter(footerPlain);
			const text = rawText && footerPlain ? `${rawText}\n\n${footerPlain}` : rawText;
			this.deps.log?.("info", "feishu.conv.stream_stats", logMeta({
				chatId: sess.chatId,
				deltaCount,
				streamedLen: streamedText.length,
				lastEndLen: lastEndText.length,
				textLen: text?.length ?? 0,
				cardActive: Boolean(streamCard),
				modelWindowMs: firstDeltaAt && lastDeltaAt ? lastDeltaAt - firstDeltaAt : 0,
				modelCharsPerSec: firstDeltaAt && lastDeltaAt && lastDeltaAt > firstDeltaAt
					? Math.round((cardText.length / ((lastDeltaAt - firstDeltaAt) / 1000)) * 10) / 10 : 0,
			}));
			let cardDelivered = false;
			if (streamCard && text) {
				// 卡片承载最终答案：成功则不再重复发文本（失败则落回下面的 durable 文本通道）。
				// 正文与页脚分开传：页脚是元信息，写进独立元素（见 StreamingCard.finish）。
				cardDelivered = await streamCard.finish(rawText || text, footerBlock ? { metrics: footerBlock } : undefined);
				if (cardDelivered && streamCard.overflowed) {
					// 卡片只放得下前段 —— 全文走 durable 文本通道（分片、可重试），
					// 交付成功与否以它为准，而不是以"卡片写成功"为准。
					this.deps.log?.("info", "feishu.stream_card.overflow_to_text", logMeta({ chatId: sess.chatId, textLen: text.length }));
					cardDelivered = false;
					await sendReply(text);
				} else if (cardDelivered) {
					// 卡内容已由飞书侧持久化，等价于「final 已交付」；
					// 必须同时置 durableHandled，否则接管账本不会 ack，重启后会把同一条消息重放成重复任务。
					durableHandled = true;
				} else {
					this.deps.log?.("warn", "feishu.stream_card.fallback_to_text", logMeta({ chatId: sess.chatId }));
				}
				streamCard = undefined;
			}
			if (text && !cardDelivered && !sentFromEvent) await sendReply(text);
			else if (!text) durableHandled = true;
			runSucceeded = true;
			this.autoName(activeAgent, item);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isRunTimeout = msg === "run idle timeout" || msg === "run max duration exceeded";
			if (isRunTimeout) runTimedOut = true;
			if (activeAgent && sess.agent === activeAgent && !modelErrorOnly) {
				if (isRunTimeout) {
					try { await activeAgent.abort(); } catch { /* best effort */ }
				}
				try { await activeAgent.dispose(); } catch { /* best effort */ }
				sess.agent = undefined;
				sess.sessionId = undefined;
			}
			if (sess.stopRequested) {
				// 用户主动 /stop：确认消息由命令路径负责，当前 turn 不再伪装成执行错误。
				durableHandled = true;
				this.deps.log?.("info", "feishu.conv.run_cancelled_by_user", logMeta({ chatId: sess.chatId }));
			} else if (this.host.shuttingDown) {
				// shutdown/abort 不是面向用户的执行失败；pending 保留供重启恢复。
				this.deps.log?.("info", "feishu.conv.run_cancelled_by_shutdown", logMeta({
					chatId: sess.chatId,
					messageId: item.messageId,
					conversationKey: sess.conversationKey,
				}));
			} else if (isRunTimeout) {
				// 说明「多久没动静」而不是「总共跑了多久」——两者语义不同，用户需要能区分
				const idleLabel = this.host.runIdleTimeoutMs >= 60_000
					? `${Math.round(this.host.runIdleTimeoutMs / 60_000)} 分钟`
					: `${Math.round(this.host.runIdleTimeoutMs / 1000)} 秒`;
				const timeoutText = msg === "run idle timeout"
					? `任务已 ${idleLabel} 没有新进展，已中止（不是总时长限制）。长时间无输出的任务可把 runIdleTimeoutMs 调大。`
					: "任务超过配置的最长执行时间，已中止。";
				durableHandled = external ? await this.deliverExternal(external, timeoutText, item) : await this.host.notify(sess.chatId, timeoutText, {
					replyTo: item.replyTo,
					threadId: sess.threadId ?? item.threadId,
				}, `${item.messageId}:timeout`, sess.conversationKey, "error");
			} else {
				// 原始错误只进日志；群里给类别文案 + 下一步建议 + 错误编号
				const errorId = newErrorId(this.host.now());
				const classified = classifyRunError(msg, errorId);
				this.deps.log?.("error", "feishu.conv.run_error", logMeta({ chatId: sess.chatId, error: msg, errorId, category: classified.category }));
				durableHandled = external ? await this.deliverExternal(external, classified.text, item) : await this.host.notify(sess.chatId, classified.text, {
					replyTo: item.replyTo,
					threadId: sess.threadId ?? item.threadId,
				}, `${item.messageId}:error`, sess.conversationKey, "error");
			}
		} finally {
			const steered = sess.steered.splice(0);
			if (!runSucceeded && !sess.stopRequested && steered.length > 0) {
				// 当前 run 异常时，已接管的 steer 降级为独立 FIFO turn，避免静默丢失。
				sess.queue.unshift(...steered);
			}
			if (streamCard) {
				// run 异常结束时收尾卡片，避免它永远停在「正在处理…」
				await streamCard.abandon(runSucceeded ? "已完成" : "任务已中止，未产出最终答案。").catch(() => {});
				streamCard = undefined;
			}
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (sess.runIdleTimer) { clearTimeout(sess.runIdleTimer); sess.runIdleTimer = undefined; }
			sess.runIdleReject = undefined;
			if (progressTimer) clearInterval(progressTimer);
			try { unsubscribe?.(); } catch { /* best effort */ }
			// 先取快照：下面会把 stopRequested 复位，之后再读它就永远是 false。
			const stopped = Boolean(sess.stopRequested);
			const completedSteers = runSucceeded || stopped ? steered : [];
			await Promise.allSettled([
				this.host.removeProcessingReaction(sess, item),
				this.host.progress.finish(sess, st, runSucceeded ? "ok" : stopped ? "stopped" : "failed"),
				...completedSteers.map((steeredItem) => this.host.removeProcessingReaction(sess, steeredItem)),
			]);
			// 失败要有明确标记（先撤 Typing 再加失败表情，避免同时显示"处理中"和"失败"）。
			// 用户主动 /stop 与关闭重启不算失败。
			if (!runSucceeded && !stopped && !this.host.shuttingDown) await this.markFailed(item);
			if (durableHandled) {
				this.host.clearPending(item);
				for (const steeredItem of completedSteers) this.host.clearPending(steeredItem);
			}
			sess.stopRequested = false;
			// run 退出后未决审批一律失效（旧卡不得再授予 session/always 权限）。
			this.deps.onApprovalInvalidate?.({
				conversationKey: sess.conversationKey,
				runId: item.runId,
				reason: runSucceeded ? "completed" : stopped ? "stopped" : this.host.shuttingDown ? "shutdown" : runTimedOut ? "timeout" : "failed",
			});
			try { resolvedResources?.cleanup(); } catch { /* best effort */ }
			try { await this.host.recordRunUsage(sess, item, metrics); } catch { /* 记账失败不影响交付 */ }
			// Pi 以 0644 创建会话文件，而它含对话全文 —— 每轮结束收紧一次（幂等、便宜）
			try { chmodSync(sess.sessionFile, 0o600); } catch { /* 文件可能还没落盘 */ }
		}
	}

	/** 交付到非聊天目标（失败只记日志；返回是否送达）。 */
	private async deliverExternal(target: DeliveryTarget, text: string, item: QueuedMessage): Promise<boolean> {
		if (!this.deps.deliverExternal) return false;
		try {
			const ok = await this.deps.deliverExternal(target, text);
			this.deps.log?.(ok ? "info" : "warn", "feishu.conv.external_delivered", { messageId: item.messageId, kind: target.kind, ok, textLen: text.length });
			return ok;
		} catch (error) {
			this.deps.log?.("error", "feishu.conv.external_delivery_failed", { messageId: item.messageId, kind: target.kind, error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	/**
	 * 超长回答转文件。返回要在正文/卡片里展示的文本（未触发时原样返回）。
	 * 附件写失败就退回原文（宁可分片刷屏，也不能丢内容）。
	 */
	private maybeReplyAsFile(text: string | undefined, item: QueuedMessage, sess: BridgeSession): string | undefined {
		const options = this.deps.config.longReply;
		if (!text || !options?.asFile || !this.deps.exportsDir || !this.deps.sendLocalFile) return text;
		const threshold = options.thresholdChars ?? 6_000;
		const fences = (text.match(/^```/gm) ?? []).length / 2;
		// 代码块很多的回答优先走文件（群里的代码块分片后几乎没法复制）
		if (text.length <= threshold && !(fences >= 4 && text.length > threshold / 2)) return text;
		try {
			mkdirSync(this.deps.exportsDir, { recursive: true, mode: 0o700 });
			const name = `reply-${new Date(this.host.now()).toISOString().replace(/[:.]/g, "-")}.md`;
			const path = join(this.deps.exportsDir, name);
			writeFileSync(path, text, { mode: 0o600 });
			const sent = this.deps.sendLocalFile(sess.chatId, path, { replyTo: item.replyTo, threadId: sess.threadId ?? item.threadId }, {
				dedupeKey: `${item.messageId}:final-file`, laneKey: sess.conversationKey,
			});
			if (!sent.ok) {
				this.deps.log?.("warn", "feishu.conv.long_reply_file_failed", { messageId: item.messageId, error: sent.error });
				return text;
			}
			const previewChars = options.previewChars ?? 1_500;
			let preview = text.slice(0, previewChars);
			// 别把代码块切在中间（未闭合的 ``` 会让后面的正文全变成代码）
			if (((preview.match(/^```/gm) ?? []).length) % 2 === 1) preview += "\n```";
			this.deps.log?.("info", "feishu.conv.long_reply_as_file", { messageId: item.messageId, chars: text.length, file: name });
			return `${preview}\n\n…（全文 ${text.length} 字，完整内容见附件 ${name}）`;
		} catch (error) {
			this.deps.log?.("warn", "feishu.conv.long_reply_file_failed", { messageId: item.messageId, error: error instanceof Error ? error.message : String(error) });
			return text;
		}
	}

	/**
	 * 会话第一轮成功后自动命名（首条消息前 20 字，不额外调用模型）。
	 * 用户 /name 过的名字优先（已有名字就不动）。
	 */
	private autoName(agent: AgentHandle | undefined, item: QueuedMessage): void {
		if (!agent?.setSessionName || agent.sessionName?.()) return;
		const name = stripContextPrefix(item.text).replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 20);
		if (!name) return;
		try { agent.setSessionName(name); } catch { /* 命名失败无所谓 */ }
	}


	private async markFailed(item: QueuedMessage): Promise<void> {
		const emoji = this.deps.config.reaction?.failureEmoji ?? "CrossMark";
		if (!emoji || !this.deps.config.reaction?.enabled || !this.deps.reactions || !item.messageId || item.synthetic) return;
		try { await this.deps.reactions.add(item.messageId, emoji); } catch { /* 标记失败不影响错误通知 */ }
	}
}
