import { createHash, randomUUID } from "node:crypto";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import { resolveCurrentTaskUserV1 } from "@agent-infra/identity";
import {
	createAgentConfigurationUseCaseV1,
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
	createWecomWebSocketV1,
	type WecomWebSocketConfigurationV1,
} from "@agent-infra/wecom/worker";
import type { WecomConnectionsDeploymentV1 } from "./wecom-connections.js";
export interface WecomSetupWorkerDeploymentV1 {
	readonly decryptor: SecretKeyringDecryptorV1;
	readonly directory: TaskUserDirectoryV1;
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
	const cachedBindings = new Map<
		string,
		{ ciphertext: string; configuration: WecomWebSocketConfigurationV1 }
	>();
	let closed = false;
	let connecting: ReturnType<typeof createWecomWebSocketV1> | undefined;
	async function credentials(
		session: WecomSetupRecordV1,
	): Promise<WecomWebSocketConfigurationV1> {
		const record = validatePlatformSecretRecordV1(session.encryptedCredential);
		if (
			record.secretId !== session.sessionId ||
			record.agentId !== session.agentId ||
			record.ownerId !== session.actorId ||
			record.ownerType !== "agent-owner" ||
			record.name !== "wecom_bot" ||
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
	async function authority(session: WecomSetupRecordV1) {
		const user = await resolveCurrentTaskUserV1(
			options.directory,
			session.actorId,
		);
		if (user?.accountStatus !== "active") return null;
		const current = await query.readAuthority({
			agentId: session.agentId,
			actorId: session.actorId,
			organizationIds: user.organizationIds,
			isAdministrator: false,
		});
		return current.outcome === "found" &&
			current.configuration.revision === session.configurationRevision &&
			current.authorizationRevision === session.authorizationRevision
			? current
			: null;
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
			for (const session of await store.candidates()) {
				if (closed) return;
				if (!session.botId) continue;
				const claim = await leases.claim({
					agentId: session.agentId,
					bindingReference: session.sessionId,
					botId: session.botId,
					holderId,
				});
				if (!claim) continue;
				try {
					if (!(await authority(session))) {
						await store.fail(session.sessionId, "conflict", claim);
						continue;
					}
					const config = await credentials(session);
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
					const unavailable = async (): Promise<never> => {
						throw new Error("Unexpected WeCom configuration admission");
					};
					const configuration = createAgentConfigurationUseCaseV1({
						transaction: {
							read: (input) => transaction.read(input),
							commit: (plan) =>
								transaction.commitWecomSetup(plan, {
									sessionId: session.sessionId,
									holderId,
									fence: claim.fence,
								}),
						},
						authorizationAdmission: {
							async authorize(request) {
								const current = await authority(session);
								return current
									? {
											schemaVersion: 1,
											status: "admitted",
											agentId: session.agentId,
											actorId: session.actorId,
											authorizationRevision: current.authorizationRevision,
										}
									: {
											schemaVersion: 1,
											status: "rejected",
											agentId: request.agentId,
											actorId: request.actorId,
										};
							},
						},
						channelAdmission: {
							async admitChannels(input) {
								return {
									schemaVersion: 1,
									status: "admitted",
									agentId: session.agentId,
									requestId: input.requestId,
									channelRevision: session.sessionId,
									channels: [
										...input.current.filter((c) => c.kind !== "wecom_bot"),
										{ kind: "wecom_bot", bindingReference: session.sessionId },
									],
								};
							},
						},
						imageAdmission: { admitImage: unavailable },
						modelAdmission: { admitModels: unavailable },
						secretAdmission: { admitSecrets: unavailable },
					});
					await configuration.update(
						{
							schemaVersion: 2,
							agentId: session.agentId,
							idempotencyKey: session.sessionId,
							requestId: session.sessionId,
							traceId: session.sessionId,
							changes: {
								channels: [
									{
										kind: "wecom_bot",
										enabled: true,
										bindingReference: session.sessionId,
									},
								],
							},
						},
						{
							schemaVersion: 1,
							actorId: session.actorId,
							rawRequestDigest: createHash("sha256")
								.update(session.sessionId)
								.digest("hex"),
						},
					);
					try {
						options.observeSetup?.("active");
					} catch {
						/* Observation only. */
					}
				} catch (error) {
					if (!(await authority(session)))
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
