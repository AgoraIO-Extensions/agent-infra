import type {
	WecomAcceptanceV1,
	WecomConnectionFenceV1,
	WecomMessageV1,
	WecomSendPortV1,
} from "@agent-infra/platform-core";
import {
	PostgresWecomConnectionsV1,
	type WecomConnectionClaimV1,
} from "@agent-infra/platform-store";
import type { WecomReplyRouteV1 } from "@agent-infra/wecom";
import {
	createWecomWebSocketV1,
	type WecomWebSocketConfigurationV1,
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
export function createPlatformWecomConnectionsV1(
	options: WecomConnectionsDeploymentV1 & {
		readonly databaseUrl: string;
		readonly holderId: string;
		readonly receive: (
			message: WecomMessageV1,
			fence: WecomConnectionFenceV1,
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
	const blocked = new Map<string, string>();
	const retryAfter = new Map<string, { version: string; time: number }>();
	const statuses = new Map<string, Promise<unknown>>();
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
			if (terminal === "auth_failed")
				blocked.set(botId, entry.credentialVersion);
			else if (terminal === "timeout" || terminal === "retry_exhausted")
				retryAfter.set(botId, {
					version: entry.credentialVersion,
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
			if (
				closed ||
				active.has(configuration.botId) ||
				blocked.get(configuration.botId) === configuration.credentialVersion ||
				(retry?.version === configuration.credentialVersion &&
					Date.now() < retry.time)
			)
				continue;
			blocked.delete(configuration.botId);
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
					const result = await options
						.receive(message, claim)
						.catch(() => ({ outcome: "unavailable" as const }));
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
			await connection.connect();
		}
	}
	const sender: WecomSendPortV1 = {
		async send(input) {
			const entry = [...active.values()].find(
				(e) =>
					e.claim.agentId === input.scope.agentId &&
					e.claim.bindingReference === input.scope.bindingReference &&
					input.scope.kind === "wecom_bot",
			);
			if (!entry || !(await leases.current(entry.claim))) return "failed";
			return entry.connection.sender.send(input);
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
