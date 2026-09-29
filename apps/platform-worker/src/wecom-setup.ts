import { randomUUID } from "node:crypto";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import { resolveCurrentTaskUserV1 } from "@agent-infra/identity";
import {
	createWecomSetupActivationV1,
	type TaskUserDirectoryV1,
	type WecomSetupRecordV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
	PostgresWecomConnectionsV1,
	PostgresWecomSetupV1,
} from "@agent-infra/platform-store";
import type { SecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import {
	createWecomApplicationAccessV1,
	createWecomWebSocketV1,
	type WecomWebSocketConfigurationV1,
} from "@agent-infra/wecom/worker";
import type { WecomConnectionsDeploymentV1 } from "./wecom-connections.js";
export interface WecomSetupWorkerDeploymentV1 {
	readonly decryptor: SecretKeyringDecryptorV1;
	readonly directory: TaskUserDirectoryV1;
	readonly applicationFetch?: typeof fetch;
}
export function createWecomSetupWorkerV1(
	options: WecomSetupWorkerDeploymentV1 &
		Omit<WecomConnectionsDeploymentV1, "bindings"> & {
			readonly databaseUrl: string;
		},
) {
	const store = new PostgresWecomSetupV1(options);
	const leases = new PostgresWecomConnectionsV1(options);
	const transaction = new PostgresAgentConfigurationTransactionV1(options);
	const query = new PostgresAgentConfigurationQueryV1(options);
	const holderId = randomUUID();
	const applicationAccess = createWecomApplicationAccessV1(
		options.applicationFetch ? { fetch: options.applicationFetch } : {},
	);
	const cachedBindings = new Map<
		string,
		{ ciphertext: string; configuration: WecomWebSocketConfigurationV1 }
	>();
	let closed = false;
	let nextKind: "wecom_bot" | "wecom_app" = "wecom_bot";
	let connecting: ReturnType<typeof createWecomWebSocketV1> | undefined;
	async function credentials(session: WecomSetupRecordV1): Promise<
		| WecomWebSocketConfigurationV1
		| {
				kind: "wecom_app";
				agentId: string;
				bindingReference: string;
				credentialVersion: string;
				corporationId: string;
				applicationId: string;
				secret: string;
		  }
	> {
		const record = validatePlatformSecretRecordV1(session.encryptedCredential);
		if (
			record.secretId !== session.sessionId ||
			record.agentId !== session.agentId ||
			record.ownerId !== session.actorId ||
			record.ownerType !== "agent-owner" ||
			record.name !== (session.kind ?? "wecom_bot") ||
			record.configRevision !== session.configurationRevision ||
			record.secretVersion !== 1
		)
			throw new Error("WeCom credential unavailable");
		const decrypted = await options.decryptor.decrypt({
			encryptedRecord: record,
			traceId: session.sessionId,
		});
		if (decrypted.outcome !== "decrypted")
			throw new Error("WeCom credential unavailable");
		try {
			const value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(decrypted.plaintext),
			);
			if (session.kind === "wecom_app") {
				if (
					value.corporationId !== session.application?.corporationId ||
					value.applicationId !== session.application?.applicationId ||
					typeof value.secret !== "string" ||
					!value.secret ||
					Object.keys(value).length !== 3
				)
					throw new Error("WeCom credential unavailable");
				return {
					kind: "wecom_app",
					agentId: session.agentId,
					bindingReference: session.sessionId,
					credentialVersion: session.sessionId,
					corporationId: value.corporationId,
					applicationId: value.applicationId,
					secret: value.secret,
				};
			}
			if (
				value.botId !== session.botId ||
				typeof value.secret !== "string" ||
				!value.secret ||
				Object.keys(value).length !== 2
			)
				throw new Error("WeCom credential unavailable");
			return {
				agentId: session.agentId,
				bindingReference: session.sessionId,
				credentialVersion: session.sessionId,
				botId: value.botId,
				secret: value.secret,
			};
		} finally {
			decrypted.plaintext.fill(0);
		}
	}
	const worker = {
		async bindings() {
			const bindings = await store.bindings();
			const current = new Set(bindings.map((binding) => binding.sessionId));
			for (const id of cachedBindings.keys())
				if (!current.has(id)) cachedBindings.delete(id);
			const result = await Promise.allSettled(
				bindings.map(async (binding) => {
					const ciphertext = JSON.stringify([
						binding.agentId,
						binding.actorId,
						binding.configurationRevision,
						binding.botId,
						binding.encryptedCredential,
					]);
					const cached = cachedBindings.get(binding.sessionId);
					if (cached?.ciphertext === ciphertext) return cached.configuration;
					cachedBindings.delete(binding.sessionId);
					const configuration = await credentials(binding);
					if ("kind" in configuration)
						throw new Error("Invalid WebSocket configuration");
					if (!closed)
						cachedBindings.set(binding.sessionId, {
							ciphertext,
							configuration,
						});
					return configuration;
				}),
			);
			return result.flatMap((item) => {
				if (item.status === "fulfilled") return [item.value];
				try {
					options.observeIngress?.("unavailable");
				} catch {
					/* Observation only. */
				}
				return [];
			});
		},
		async tick() {
			if (closed) return;
			const bots = await store.candidates();
			const applications = await store.candidates("wecom_app");
			const candidates =
				nextKind === "wecom_bot"
					? [...bots, ...applications]
					: [...applications, ...bots];
			for (const session of candidates) {
				if (closed) return;
				if (
					!session.botId ||
					(session.kind === "wecom_app" && !session.callbackVerifiedAt)
				)
					continue;
				const claim = await leases.claim({
					agentId: session.agentId,
					bindingReference: session.sessionId,
					botId: session.botId,
					holderId,
				});
				if (!claim) continue;
				nextKind = session.kind === "wecom_app" ? "wecom_bot" : "wecom_app";
				const activation = createWecomSetupActivationV1({
					transaction: {
						read: (input) => transaction.read(input),
						commit: (plan) =>
							transaction.commitWecomSetup(plan, {
								sessionId: session.sessionId,
								holderId: claim.holderId,
								fence: claim.fence,
							}),
					},
					readCurrentUser: (actorId) =>
						resolveCurrentTaskUserV1(options.directory, actorId),
					readAuthority: async (session, organizationIds) => {
						const current = await query.readAuthority({
							agentId: session.agentId,
							actorId: session.actorId,
							organizationIds: [...organizationIds],
							isAdministrator: false,
						});
						return current.outcome === "found" ? current : null;
					},
				});
				try {
					if (!(await activation.authority(session))) {
						await store.fail(session.sessionId, "conflict", claim);
						continue;
					}
					const config = await credentials(session);
					if ("kind" in config) {
						if (!(await applicationAccess.token(config))) {
							await store.fail(session.sessionId, "auth_failed", claim);
							continue;
						}
					} else {
						const connection = createWecomWebSocketV1({
							configuration: config,
							...(options.endpoint ? { endpoint: options.endpoint } : {}),
							isLocallyCurrent: () =>
								!closed && Date.now() < claim.leaseUntil.getTime() - 1000,
							isCurrent: () => leases.current(claim),
							receive: async () => {
								connection.close();
								throw new Error("WeCom setup probe cannot receive messages");
							},
							...(options.observeIngress
								? { observeIngress: options.observeIngress }
								: {}),
							protectReply: options.protectReply,
							revealReply: options.revealReply,
							observe() {},
						});
						connecting = connection;
						await connection.connect();
						if (!(await connection.authentication)) {
							if (connection.terminalReason === "auth_failed")
								await store.fail(session.sessionId, "auth_failed", claim);
							return;
						}
						connection.close();
						connecting = undefined;
					}
					await activation.activate(session);
					try {
						options.observeSetup?.("active");
					} catch {
						/* Observation only. */
					}
				} catch (error) {
					if (!(await activation.authority(session)))
						await store.fail(session.sessionId, "conflict", claim);
					else throw error;
				} finally {
					connecting?.close();
					connecting = undefined;
					await leases.release(claim);
				}
				return; // One bounded authentication probe per shared Worker poll.
			}
		},
		async close() {
			closed = true;
			cachedBindings.clear();
			connecting?.close();
			const results = await Promise.allSettled([
				store.close(),
				leases.close(),
				transaction.close(),
				query.close(),
			]);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		},
	};
	let running: Promise<void> | undefined;
	return {
		bindings: worker.bindings,
		tick() {
			if (closed) return Promise.resolve();
			running ??= worker.tick().finally(() => {
				running = undefined;
			});
			return running;
		},
		async close() {
			closed = true;
			connecting?.close();
			await running?.catch(() => {});
			await worker.close();
		},
	};
}
