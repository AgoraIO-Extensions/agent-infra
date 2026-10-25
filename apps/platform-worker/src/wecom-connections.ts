import {
	type WecomAcceptanceV1,
	type WecomConnectionFenceV1,
	type WecomMessageV1,
	type WecomScopeV1,
	wecomProcessingTextV1,
} from "@agent-infra/platform-core";
import {
	PostgresWecomConnectionsV1,
	type WecomConnectionClaimV1,
} from "@agent-infra/platform-store";
import type { WecomReplyRouteV1 } from "@agent-infra/wecom";
import {
	createWecomWebSocketV1,
	type WecomWebSocketConfigurationV1,
	type WecomWebSocketSenderV1,
} from "@agent-infra/wecom/worker";

export interface WecomConnectionsDeploymentV1 {
	/** Worker-only resolver. Returns decrypted channel credentials for current Agent bindings. */
	readonly bindings: () => Promise<readonly WecomWebSocketConfigurationV1[]>;
	readonly protectReply: (route: WecomReplyRouteV1) => Promise<string>;
	readonly revealReply: (handle: string) => Promise<WecomReplyRouteV1>;
	readonly endpoint?: string;
	readonly observeConnection?: (
		status: "verifying" | "connected" | "disconnected" | "auth_failed",
	) => void;
	readonly observeSetup?: (
		status: "expired" | "conflict" | "auth_failed" | "active",
	) => void;
	readonly observeIngress?: (
		outcome: "invalid" | "overloaded" | "unavailable",
	) => void;
}

function bindingIdentity(
	botId: string,
	agentId: string,
	bindingReference: string,
	credentialVersion: string,
): string {
	return JSON.stringify([botId, agentId, bindingReference, credentialVersion]);
}

export function createPlatformWecomConnectionsV1(
	options: WecomConnectionsDeploymentV1 & {
		readonly databaseUrl: string;
		readonly holderId: string;
		readonly receive: (
			message: WecomMessageV1,
			fence: WecomConnectionFenceV1,
			signal?: AbortSignal,
		) => Promise<WecomAcceptanceV1>;
	},
) {
	const leases = new PostgresWecomConnectionsV1(options);
	const holderId = options.holderId;
	const active = new Map<
		string,
		{
			claim: WecomConnectionClaimV1;
			credentialVersion: string;
			connection: ReturnType<typeof createWecomWebSocketV1>;
		}
	>();
	const blocked = new Set<string>();
	const retryAfter = new Map<string, { identity: string; time: number }>();
	const statuses = new Map<string, Promise<unknown>>();
	// #3374：受理之后在串行槽位外发送的回复；关闭时等待它们结束。
	const replies = new Set<Promise<void>>();
	let closed = false;
	let polling: Promise<void> | undefined;
	async function reconcile() {
		const bindings = await options.bindings();
		if (closed) return;
		if (new Set(bindings.map((b) => b.botId)).size !== bindings.length)
			throw new Error("Invalid WeCom connection bindings");
		for (const [botId, entry] of active) {
			const desired = bindings.find((b) => b.botId === botId);
			const terminal = entry.connection.terminalReason;
			const identity = bindingIdentity(
				botId,
				entry.claim.agentId,
				entry.claim.bindingReference,
				entry.credentialVersion,
			);
			if (terminal === "auth_failed") blocked.add(identity);
			else if (terminal === "timeout" || terminal === "retry_exhausted")
				retryAfter.set(botId, {
					identity,
					time: Date.now() + 5000,
				});
			if (
				terminal ||
				!desired ||
				desired.credentialVersion !== entry.credentialVersion ||
				desired.bindingReference !== entry.claim.bindingReference ||
				desired.agentId !== entry.claim.agentId ||
				!(await leases.renew(entry.claim))
			) {
				entry.connection.close();
				active.delete(botId);
				await statuses.get(botId);
				await leases.release(entry.claim);
			}
		}
		for (const botId of retryAfter.keys()) {
			if (!bindings.some((binding) => binding.botId === botId))
				retryAfter.delete(botId);
		}
		for (const configuration of bindings) {
			const retry = retryAfter.get(configuration.botId);
			const identity = bindingIdentity(
				configuration.botId,
				configuration.agentId,
				configuration.bindingReference,
				configuration.credentialVersion,
			);
			if (
				closed ||
				active.has(configuration.botId) ||
				blocked.has(identity) ||
				(retry?.identity === identity && Date.now() < retry.time)
			)
				continue;
			retryAfter.delete(configuration.botId);
			const claim = await leases.claim({
				botId: configuration.botId,
				agentId: configuration.agentId,
				bindingReference: configuration.bindingReference,
				holderId,
			});
			if (!claim) continue;
			if (closed) {
				await leases.release(claim);
				return;
			}
			const connection = createWecomWebSocketV1({
				configuration,
				...(options.endpoint ? { endpoint: options.endpoint } : {}),
				isLocallyCurrent: () =>
					!closed && Date.now() < claim.leaseUntil.getTime() - 1000,
				isCurrent: () => leases.current(claim),
				receive: async (message) => {
					// #3374：同一会话键的下一帧要等这一帧受理结束；受理最多占用到回复有效期结束，
					// 依赖挂起时也会释放槽位（过期后已无法回复）。
					const remaining = Date.parse(message.replyExpiresAt) - Date.now();
					const deadline = AbortSignal.timeout(
						Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
					);
					const result = await options
						.receive(message, claim, deadline)
						.catch(() => ({ outcome: "unavailable" as const }));
					// #3374：受理结束即释放该会话键的串行槽位；处理中提示与拒绝回复在槽位之外发送，
					// 等待 ACK 不推迟同一会话的下一条消息（工程 Spec §14.2.4）。
					const reply = replyAfterAdmission(message, result).catch(() => {
						options.observeIngress?.("unavailable");
					});
					replies.add(reply);
					void reply.finally(() => replies.delete(reply));
				},
				observeIngress: options.observeIngress,
				protectReply: options.protectReply,
				revealReply: options.revealReply,
				observe: (status) => {
					const previous = statuses.get(claim.botId) ?? Promise.resolve();
					const next = previous
						.then(async () => {
							if (await leases.status(claim, status)) {
								try {
									options.observeConnection?.(status);
								} catch {
									/* Observation only. */
								}
							}
						})
						.catch(() => {
							connection.close("ownership_lost");
						})
						.finally(() => {
							if (statuses.get(claim.botId) === next)
								statuses.delete(claim.botId);
						});
					statuses.set(claim.botId, next);
				},
			});
			active.set(configuration.botId, {
				claim,
				connection,
				credentialVersion: configuration.credentialVersion,
			});
			/** 受理之后的回复：新受理并已开始执行的消息立即回处理中提示（#3077）；繁忙、重投不发。 */
			const replyAfterAdmission = async (
				message: WecomMessageV1,
				result: WecomAcceptanceV1,
			) => {
				if (
					result.outcome === "accepted" &&
					result.receipt.status === "accepted"
				) {
					if (!(await leases.current(claim))) return;
					await connection.acknowledge({
						scope: message,
						replyHandle: message.replyHandle,
						text: wecomProcessingTextV1,
					});
					return;
				}
				if (result.outcome === "denied" || result.outcome === "unavailable") {
					if (!(await leases.current(claim))) return;
					const status = await connection.sender.send({
						scope: message,
						replyHandle: message.replyHandle,
						text:
							result.outcome === "denied"
								? "暂无权限使用此 Agent"
								: "Agent 当前不可用，请稍后重试",
					});
					if (status !== "sent") options.observeIngress?.("unavailable");
				}
			};
			await connection.connect();
		}
	}
	const entryFor = async (scope: WecomScopeV1) => {
		const entry = [...active.values()].find(
			(e) =>
				e.claim.agentId === scope.agentId &&
				e.claim.bindingReference === scope.bindingReference &&
				scope.kind === "wecom_bot",
		);
		return entry && (await leases.current(entry.claim)) ? entry : undefined;
	};
	const sender: WecomWebSocketSenderV1 = {
		async send(input) {
			const entry = await entryFor(input.scope);
			if (!entry) return "failed";
			return entry.connection.sender.send(input);
		},
		// #3377：进度帧只经本 Worker 持有当前租约的连接发送；每帧发送前另由 prepare 复核。
		async update(input) {
			const entry = await entryFor(input.scope);
			if (!entry) return "failed";
			return entry.connection.sender.update(input);
		},
		// #3229：只有本 Worker 持有当前租约的连接才规划与发送媒体。
		async planMedia(input) {
			const entry = await entryFor(input.scope);
			return entry ? entry.connection.sender.planMedia(input) : null;
		},
		async sendMedia(input) {
			const entry = await entryFor(input.scope);
			if (!entry) return "failed";
			return entry.connection.sender.sendMedia(input);
		},
	};
	return {
		sender,
		tick() {
			if (closed) return Promise.resolve();
			polling ??= reconcile()
				.catch(async (error: unknown) => {
					const entries = [...active.values()];
					for (const entry of entries) entry.connection.close();
					active.clear();
					await Promise.allSettled(
						entries.map(async (entry) => {
							try {
								await statuses.get(entry.claim.botId);
								await leases.release(entry.claim);
							} finally {
								statuses.delete(entry.claim.botId);
							}
						}),
					);
					throw error;
				})
				.finally(() => {
					polling = undefined;
				});
			return polling;
		},
		async close() {
			closed = true;
			await polling?.catch(() => {});
			await Promise.allSettled([...replies]);
			const entries = [...active.values()];
			active.clear();
			const results = await Promise.allSettled(
				entries.map(async (entry) => {
					try {
						entry.connection.close();
						await statuses.get(entry.claim.botId);
					} finally {
						statuses.delete(entry.claim.botId);
						await leases.release(entry.claim);
					}
				}),
			);
			results.push(...(await Promise.allSettled([leases.close()])));
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		},
	};
}
