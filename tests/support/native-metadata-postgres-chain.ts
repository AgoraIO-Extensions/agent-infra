import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	createRuntimeNativeMetadataCurrentAssemblyV1,
	createRuntimeNativeMetadataReadV1,
} from "../../apps/agent-runtime-host/src/native-metadata-assembly.js";
import { createRuntimeNativeMetadataProofVerifierV1 } from "../../apps/agent-runtime-host/src/native-metadata-proof.js";
import {
	createRuntimeNativeMetadataCurrentCheckerV1,
	createRuntimeNativeMetadataRequestRegistryV1,
} from "../../apps/platform-api/src/runtime-native-metadata-current.js";
import { createRuntimeNativeMetadataWorkerReaderV1 } from "../../apps/platform-api/src/runtime-native-metadata-reader.js";
import { createRuntimeNativeMetadataRequestContextV1 } from "../../apps/platform-api/src/runtime-native-metadata-request-context.js";
import {
	createRuntimeNativeMetadataScopeResolverV1,
	NativeMetadataResourceUnavailableV1,
} from "../../apps/platform-api/src/runtime-native-metadata-scope-resolver.js";
import { createWorkerRuntimeNativeMetadataGatewayV1 } from "../../apps/platform-worker/src/runtime-native-metadata-gateway.js";
import { createWorkerRuntimeNativeMetadataProofIssuerV1 } from "../../apps/platform-worker/src/runtime-native-metadata-proof.js";
import type { CodexRuntimeDriver } from "../../packages/agent-runtime/src/codex-runtime-driver.js";
import { FileRuntimeStore } from "../../packages/agent-runtime/src/file-runtime-store.js";
import { RuntimeHost } from "../../packages/agent-runtime/src/runtime-host.js";
import { PostgresConversationQueryV1 } from "../../packages/platform-store/src/conversation-query.js";
import { migratePlatformDatabase } from "../../packages/platform-store/src/migrate.js";
import {
	openPostgresTestClient,
	startPostgresTestDatabase,
} from "../../packages/platform-store/src/postgres-test.js";

/** Real PG original scope + API/Worker/Host/Driver; identity/policy and native RPC are controlled. */
export async function measureNativeMetadataPgChain(input: {
	readonly driver: CodexRuntimeDriver;
	readonly nativeSessionRef: string;
	readonly directory: string;
	readonly fault?: "revocation" | "identity" | "agent";
	readonly onProjection?: (mark: () => void) => void;
	readonly rtt?: {
		identity: number;
		policy: number;
		query: number;
		current: number;
	};
}) {
	const database = await startPostgresTestDatabase("metadata-completion");
	const sql = openPostgresTestClient(database);
	const registry = createRuntimeNativeMetadataRequestRegistryV1();
	let query: PostgresConversationQueryV1 | undefined;
	let host: RuntimeHost | undefined;
	let context:
		| ReturnType<typeof createRuntimeNativeMetadataRequestContextV1>
		| undefined;
	const counts = { identity: 0, policy: 0, query: 0, current: 0 };
	const rtt = input.rtt;
	let projected = false;
	let changedOriginalScope: Promise<unknown> | undefined;
	try {
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,host_session_ref) values ('conversation-1','agent-1','reader-1','web','active',1,'pg-current','pg-original-host')`;
		await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values ('personal','reader-1',1,1)`;
		await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values ('personal','reader-1',1,'pg-synthetic-key',${sql.json({ purpose: "personal", subjectId: "reader-1", keyId: "pg-synthetic-key", keyVersion: 1 })})`;
		await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version) values ('execution-1','conversation-1','agent-1','reader-1','web','platform-turn-1','completed',1,'pg-original',now(),'v4',${"a".repeat(43)},'pg-original-host','web','personal','reader-1','pg-synthetic-key',1)`;
		query = new PostgresConversationQueryV1({
			databaseUrl: database.databaseUrl,
		});
		const originalQuery = query;
		const identity = {
			schemaVersion: 1 as const,
			userId: "reader-1",
			displayName: "Synthetic metadata reader",
			accountStatus: "active" as const,
			organizationIds: [],
			roles: ["employee" as const],
			authorizationRevision: "identity-current",
		};
		const authorize = async () => {
			counts.policy++;
			if (rtt) await delay(rtt.policy);
			if (projected && input.fault === "revocation")
				return { outcome: "revoked" as const };
			return {
				outcome: "allowed" as const,
				authority: {
					actorId: identity.userId,
					agentId: "agent-1",
					channelId: "web",
					authorizationRevision: "policy-current",
				},
			};
		};
		const resolveRequest = createRuntimeNativeMetadataScopeResolverV1({
			authorize,
			query: {
				async readNativeMetadataObjectScopeV1(
					request,
					conversationId?: string,
					executionId?: string,
					signal?: AbortSignal,
				) {
					counts.query++;
					if (rtt) await delay(rtt.query);
					if ("scope" in request)
						return originalQuery.readNativeMetadataObjectScopeV1(request);
					if (!conversationId || !executionId)
						throw new Error("Missing synthetic metadata scope");
					return originalQuery.readNativeMetadataObjectScopeV1(
						request,
						conversationId,
						executionId,
						signal,
					);
				},
			},
		});
		const checker = createRuntimeNativeMetadataCurrentCheckerV1({
			registry,
			authorize,
		});
		const current = {
			async check(request: Parameters<typeof checker.check>[0]) {
				counts.current++;
				if (rtt) await delay(rtt.current);
				return checker.check(request);
			},
		};
		const keys = generateKeyPairSync("ed25519");
		const proofOptions = {
			issuer: "pg-fixture",
			workerId: "pg-worker",
			keyVersion: "pg-key",
		};
		const verifier = createRuntimeNativeMetadataProofVerifierV1({
			...proofOptions,
			publicKey: keys.publicKey,
		});
		host = await RuntimeHost.open({
			store: await FileRuntimeStore.open(
				join(input.directory, "metadata-pg-host.json"),
			),
			driver: input.driver,
			grantValidation: { expectedIssuer: "pg-fixture" },
		});
		const metadataHost = host;
		const gateway: ReturnType<
			typeof createWorkerRuntimeNativeMetadataGatewayV1
		> = createWorkerRuntimeNativeMetadataGatewayV1({
			current,
			binding: {
				async resolve({ request }) {
					const { apiRequestSourceRef: _source, ...binding } = request;
					return { ...binding, originalHostScopeRef: "pg-original-host" };
				},
			},
			proofIssuer: createWorkerRuntimeNativeMetadataProofIssuerV1({
				...proofOptions,
				privateKey: keys.privateKey,
			}),
			transport: {
				async resolve() {
					return {
						read: createRuntimeNativeMetadataReadV1(
							metadataHost,
							createRuntimeNativeMetadataCurrentAssemblyV1({
								current: {
									check: (value) =>
										gateway.checkHostCurrent(value, value.signal),
								},
								resolveNativeSessionRef: async () => input.nativeSessionRef,
								verifyProof: (request) => verifier.verify(request),
							}),
						),
					};
				},
			},
		});
		const reader = createRuntimeNativeMetadataWorkerReaderV1({
			resolveRequest,
			requestRegistry: registry,
			gateway: { read: (request, signal) => gateway.read(request, signal) },
		});
		context = createRuntimeNativeMetadataRequestContextV1({
			signal: new AbortController().signal,
			authenticate: async () => {
				counts.identity++;
				if (rtt) await delay(rtt.identity);
				if (projected && input.fault === "agent") {
					changedOriginalScope ??= sql`update platform.conversation_executions set agent_id='foreign-agent' where execution_id='execution-1'`;
					await changedOriginalScope;
				}
				return projected && input.fault === "identity"
					? { ...identity, userId: "foreign-reader" }
					: identity;
			},
		});
		const readContext = context;
		input.onProjection?.(() => {
			projected = true;
		});
		const [before] = await sql<{ executions: number; outbox: number }[]>`
			select (select count(*)::int from platform.conversation_executions) as executions,
			(select count(*)::int from platform.outbox_items) as outbox
		`;
		if (!before) throw new Error("Missing synthetic metadata counters");
		const started = performance.now();
		await context.authenticate();
		const rounds = [];
		for (let round = 0; round < 2; round++) {
			const directories = await Promise.all(
				(["commands", "skills"] as const).map((selector) =>
					reader.read(
						identity,
						"conversation-1",
						"execution-1",
						selector,
						readContext,
					),
				),
			);
			rounds.push(
				directories.map((directory) =>
					directory && directory !== NativeMetadataResourceUnavailableV1
						? directory.selector
						: null,
				),
			);
			if (
				directories.some(
					(directory) =>
						!directory || directory === NativeMetadataResourceUnavailableV1,
				)
			)
				break;
		}
		// Preserve the real response-bytes guard; no business Turn is submitted by this test.
		if (rounds.length === 2 && rounds.flat().every(Boolean))
			await context.verifyDelivery(identity);
		const elapsedMs = Math.round(performance.now() - started);
		const [after] = await sql<{ executions: number; outbox: number }[]>`
			select (select count(*)::int from platform.conversation_executions) as executions,
			(select count(*)::int from platform.outbox_items) as outbox
		`;
		if (!after) throw new Error("Missing synthetic metadata counters");
		return {
			counts,
			rounds,
			projected,
			businessWrites: {
				executions: after.executions - before.executions,
				outbox: after.outbox - before.outbox,
			},
			elapsedMs,
			rtt: rtt ?? null,
		};
	} finally {
		context?.close();
		registry.clear();
		await host?.close();
		await query?.close();
		await sql.end({ timeout: 1 });
		await database.stop();
	}
}
