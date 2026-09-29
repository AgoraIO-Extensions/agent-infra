import {
	type ChildProcess,
	execFile as execFileCallback,
	spawn,
} from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	CodexRuntimeDriver,
	createExecutionGrantVerifier,
	createRuntimeExecutionGrantValidatorV4,
	createRuntimeExecutionGrantVerifierV2,
	createWorkloadReadinessVerifierV1,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	verifyCodexPilotInstallation,
} from "@agent-infra/agent-runtime";
import {
	CommandAcceptedProjectionV1Schema,
	ConversationProjectionV1Schema,
	ExecutionDetailProjectionV2Schema,
	TaskAcceptedV1Schema,
	TaskProjectionV1Schema,
	TaskSseMessageV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	ExecutionGrantClaimsV1,
	ExecutionGrantV1,
	RuntimeSubmitTurnRequestV2,
	RuntimeSubmitTurnRequestV3,
} from "@agent-infra/contracts/runtime";
import {
	createFakeModelCatalogAdapterV1,
	projectRuntimeModelConfigurationV4,
} from "@agent-infra/model-catalog";
import {
	type AgentConfigurationRecordV2,
	createConversationExecutionUseCaseV1,
	hashApiCredentialV1,
} from "@agent-infra/platform-core";
import {
	PostgresConversationExecutionTransactionV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import {
	KubeConfig,
	type V1Secret,
	type V1StatefulSet,
} from "@kubernetes/client-node";
import postgres from "postgres";
import { expect, it } from "vitest";
import { createRuntimeHostApp } from "../apps/agent-runtime-host/src/app.js";
import type { ProductionPlatformApiInputV1 } from "../apps/platform-api/src/deployment.js";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "../apps/platform-api/src/index.js";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "../apps/platform-worker/src/kubernetes.fixture.js";
import {
	createKubernetesRuntimeAdapterV1,
	workloadResourceNameV1,
} from "../apps/platform-worker/src/kubernetes-runtime-adapter.js";
import { createWorkerRuntimeGrantSignerV2 } from "../apps/platform-worker/src/runtime-grant-signer.js";
import { workloadResourceConfigurationHashV1 } from "../apps/platform-worker/src/workload-runtime.js";
import { catalogFixture } from "../packages/model-catalog/src/catalog.fixture.js";
import { migratePlatformDatabase } from "../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../packages/platform-store/src/postgres-test.js";
import { createRelayKeyEncryptorV1 } from "../packages/secret-store/src/index.js";
import { setProductionDeploymentInput } from "./fixtures/platform-api-production-deployment.js";

const execFile = promisify(execFileCallback);
const realCodexE2e = process.env.AGENT_INFRA_REAL_CODEX_E2E === "1";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This task-scoped fake harness flag is intentionally outside the default Turbo task environment.
const packagedV4Fake = process.env.AGENT_INFRA_PACKAGED_V4_FAKE === "1";
const keyedRuntime = realCodexE2e || packagedV4Fake;

function syntheticModelEvents() {
	const item = {
		type: "message",
		id: "worker-codex-message",
		role: "assistant",
		status: "completed",
		content: [
			{ type: "output_text", text: "controlled dispatch", annotations: [] },
		],
	};
	return [
		{
			type: "response.created",
			response: {
				id: "worker-codex-response",
				status: "in_progress",
				output: [],
			},
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			delta: "controlled dispatch",
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "worker-codex-response",
				status: "completed",
				output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
}

async function writeSyntheticModelResponse(
	response: import("node:http").ServerResponse,
	completionGate?: Promise<void>,
) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const events = syntheticModelEvents();
	const first = events[0];
	if (!first) throw Error("Synthetic model response is empty");
	response.write(`event: ${first.type}\ndata: ${JSON.stringify(first)}\n\n`);
	if (completionGate) await completionGate;
	for (const event of events.slice(1)) {
		response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	}
	response.end();
}

async function waitUntil(
	check: () => Promise<boolean>,
	label: string,
	checkTimeoutMs = 5_000,
) {
	for (let attempt = 0; attempt < 150; attempt++) {
		let timer: NodeJS.Timeout | undefined;
		try {
			const result = await Promise.race([
				check(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(new Error(`Check timed out after ${checkTimeoutMs}ms`)),
						checkTimeoutMs,
					);
				}),
			]);
			if (result) return;
		} catch (error) {
			throw new Error(`Check failed: ${label}`, { cause: error });
		} finally {
			if (timer) clearTimeout(timer);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw Error(`Timed out: ${label}`);
}

async function settleQuery<T>(
	query: Promise<T> & { cancel?: () => void },
	label: string,
	timeoutMs = 5_000,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	try {
		return await Promise.race([
			query,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					reject(new Error(`Query timed out: ${label}`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (timedOut) query.cancel?.();
	}
}

// Real PostgreSQL and the packaged production module/CLI, with controlled Kubernetes
// and Runtime HTTP. AGENT_INFRA_REAL_CODEX_E2E adds the fixed Codex/provider lane;
// neither mode is identity-provider, Connection, or browser acceptance.
it("automatically dispatches lawful Core admissions through two packaged Worker processes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "worker-766-"));
	const externalDatabaseUrl = process.env.PLATFORM_TEST_DATABASE_URL;
	const database =
		realCodexE2e && externalDatabaseUrl
			? {
					databaseUrl: externalDatabaseUrl,
					stop: async () => undefined,
				}
			: await startPostgresTestDatabase("766-worker-dispatch");
	const sql = postgres(database.databaseUrl, { max: 2 });
	const diagnosticSql = postgres(database.databaseUrl, {
		max: 1,
		connect_timeout: 3,
		idle_timeout: 5,
		application_name: "conversation-worker-855-diagnostic",
	});
	const children: ChildProcess[] = [];
	const output: string[] = [];
	const traces: string[] = [];
	const nativeStartedAt = Date.now();
	let nativeStage = "setup";
	const recordNativeStage = (
		stage: string,
		details: Record<string, unknown> = {},
	) => {
		nativeStage = stage;
		process.stderr.write(
			`[855-native-stage] ${JSON.stringify({
				stage,
				elapsedMs: Date.now() - nativeStartedAt,
				...details,
			})}\n`,
		);
	};
	const sampleBlocking = async (stage: string) => {
		try {
			const rows = await diagnosticSql<
				{
					pid: number;
					applicationName: string | null;
					state: string | null;
					waitEventType: string | null;
					waitEvent: string | null;
					blocking: boolean;
				}[]
			>`
				select pid,
				       application_name as "applicationName",
				       state,
				       wait_event_type as "waitEventType",
				       wait_event as "waitEvent",
				       cardinality(pg_blocking_pids(pid)) > 0 as blocking
				from pg_stat_activity
				where datname=current_database()
				  and pid <> pg_backend_pid()
				  and (application_name like 'conversation-worker-%'
				       or application_name like 'platform-%')
				order by pid
			`;
			recordNativeStage(`${stage}.pg_activity`, {
				connections: rows.map(
					({
						pid,
						applicationName,
						state,
						waitEventType,
						waitEvent,
						blocking,
					}) => ({
						pid,
						applicationName,
						state,
						waitEventType,
						waitEvent,
						blocking,
					}),
				),
			});
		} catch (error) {
			recordNativeStage(`${stage}.pg_activity_error`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const requests: {
		path: string;
		executionId?: string;
		operationId?: string;
		sessionGeneration?: number;
		businessHostSessionRef?: string | null;
		deliveryFence?: number;
		confirmedCursor?: string;
		responseStatus?: number;
		transportTls?: boolean;
		keyId?: string;
		keyVersion?: number;
		privateKeyMatches?: boolean;
		keyInBusinessRequest?: boolean;
	}[] = [];
	let packagedV4ReadFailureInjected = false;
	const modelRequests: { body: string; credential: string | undefined }[] = [];
	const modelJournalAtArrival: {
		executionId: string;
		operationRef: string;
		attemptRef: string;
	}[] = [];
	let withheldAck:
		| {
				response: import("node:http").ServerResponse;
				executionId: string;
				confirmedCursor: string;
		  }
		| undefined;
	let modelServer: ReturnType<typeof createServer> | undefined;
	let modelPort: number | undefined;
	let releaseModelResponse: (() => void) | undefined;
	let releaseSecondModelResponse: (() => void) | undefined;
	const modelResponseGate = realCodexE2e
		? new Promise<void>((resolve) => {
				releaseModelResponse = resolve;
			})
		: Promise.resolve();
	const secondModelResponseGate = new Promise<void>((resolve) => {
		releaseSecondModelResponse = resolve;
	});
	const keys = generateKeyPairSync("ed25519");
	const wrapping = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const wrappingPublicKey = wrapping.publicKey.export({
		format: "der",
		type: "spki",
	});
	const encryptionKeys = {
		schemaVersion: 1 as const,
		activeWrappingKeyVersion: "worker-key",
		keys: [
			{
				schemaVersion: 1 as const,
				keyVersion: "worker-key",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
				publicKeySpkiDerBase64: wrappingPublicKey.toString("base64"),
				publicKeyFingerprint: createHash("sha256")
					.update(wrappingPublicKey)
					.digest("hex"),
				rsaModulusBits: 3072,
				status: "active" as const,
			},
		],
	};
	const relayEncryptor = createRelayKeyEncryptorV1({ encryptionKeys });
	const relayKeys = {
		first: "synthetic-agent-execution-key-k1",
		rotated: "synthetic-agent-execution-key-k2",
		second: "synthetic-user-second-personal-key",
	};
	const browserSessionCookies = {
		"user-cli": "worker_session=controlled-browser-first",
		"user-second": "worker_session=controlled-browser-second",
	};
	const apiCredentials = {
		"user-cli": "synthetic-user-cli-api-credential",
		"user-second": "synthetic-user-second-api-credential",
	};
	const signing = {
		workerId: "worker-transport",
		issuer: "worker-platform",
		keyId: "worker-key",
	};
	const policy = {
		...workloadTestPolicy,
		runtimeAuth: {
			workerId: signing.workerId,
			grantIssuer: signing.issuer,
			grantKeyId: signing.keyId,
			grantPublicKey: keys.publicKey
				.export({ type: "spki", format: "pem" })
				.toString(),
			serviceTokenSecret: { name: "runtime-transport", key: "token" },
		},
	};
	const fake = fakeKubernetesApi();
	const kinds: Record<string, string> = {
		pods: "Pod",
		services: "Service",
		secrets: "Secret",
		persistentvolumeclaims: "PersistentVolumeClaim",
		serviceaccounts: "ServiceAccount",
		statefulsets: "StatefulSet",
		networkpolicies: "NetworkPolicy",
		ingresses: "Ingress",
	};
	const kube = createServer(async (request, response) => {
		traces.push(`kube:${request.method}:${request.url}`);
		const url = new URL(request.url ?? "/", "http://localhost");
		const parts = url.pathname.split("/");
		const marker = parts.indexOf("namespaces");
		let body: unknown;
		if (marker < 0)
			body = {
				kind: "APIResourceList",
				apiVersion: "v1",
				groupVersion: parts.slice(parts[1] === "api" ? 2 : 2).join("/"),
				resources: Object.entries(kinds).map(([name, kind]) => ({
					name,
					kind,
					namespaced: true,
					verbs: ["get", "list"],
				})),
			};
		else {
			const kind = kinds[parts[marker + 2] ?? ""];
			const name = parts[marker + 3];
			body = name
				? fake.resources.get(`${kind}/${name}`)
				: {
						apiVersion: "v1",
						kind: `${kind}List`,
						items: [...fake.resources.values()].filter(
							(value) => value.kind === kind,
						),
					};
		}
		response.writeHead(body ? 200 : 404, {
			"content-type": "application/json",
		});
		response.end(
			JSON.stringify(
				body ?? { kind: "Status", code: 404, reason: "NotFound" },
				(key, value) =>
					key === "ingress" && Array.isArray(value)
						? value.map(({ _from, ...rule }) => ({ ...rule, from: _from }))
						: value,
			),
		);
	});
	let host: RuntimeHost | undefined;
	let runtimeServer:
		| ReturnType<typeof createServer>
		| ReturnType<typeof createSecureServer>
		| undefined;
	let execution: PostgresConversationExecutionTransactionV1 | undefined;
	let authorization: PostgresTaskAuthorizationStoreV1 | undefined;
	let moduleDirectory: string | undefined;
	let apiRunning:
		| Awaited<ReturnType<typeof startPlatformApiFromDeployment>>
		| undefined;
	let apiOrigin: string | undefined;
	try {
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		if (realCodexE2e) {
			modelServer = createServer(async (request, response) => {
				const chunks: Uint8Array[] = [];
				for await (const chunk of request) chunks.push(chunk);
				const body = Buffer.concat(chunks).toString();
				const credential = request.headers.authorization?.replace(
					/^Bearer /,
					"",
				);
				modelRequests.push({
					body,
					credential,
				});
				if (
					![relayKeys.first, relayKeys.rotated, relayKeys.second].includes(
						credential ?? "",
					)
				) {
					response.writeHead(401);
					response.end();
					return;
				}
				const state = JSON.parse(
					await readFile(join(directory, "driver.json"), "utf8"),
				) as {
					sessions: Record<
						string,
						{
							executions: Record<string, { nativeTurnId: string }>;
							journals?: Record<
								string,
								{
									events: {
										type: string;
										payload?: {
											kind?: string;
											phase?: string;
											operationRef?: string;
											attemptRef?: string;
										};
									}[];
								}
							>;
						}
					>;
				};
				modelJournalAtArrival.push(
					...Object.values(state.sessions).flatMap((session) =>
						Object.entries(session.executions).flatMap(
							([executionId, execution]) =>
								(
									session.journals?.[execution.nativeTurnId]?.events ?? []
								).flatMap((event) =>
									event.type === "operation" &&
									event.payload?.kind === "model" &&
									event.payload.phase === "intent"
										? [
												{
													executionId,
													operationRef: event.payload.operationRef ?? "",
													attemptRef: event.payload.attemptRef ?? "",
												},
											]
										: [],
								),
						),
					),
				);
				// Keep the controlled provider response open until the Worker has
				// durably observed the accepted running Execution. Otherwise the
				// synthetic model can complete before the takeover assertions read
				// the processing state that this test is exercising.
				if (!response.destroyed)
					await writeSyntheticModelResponse(
						response,
						modelRequests.length === 2
							? secondModelResponseGate
							: modelResponseGate,
					);
			});
			modelServer.listen(0, "127.0.0.1");
			await once(modelServer, "listening");
			const modelAddress = modelServer.address();
			if (!modelAddress || typeof modelAddress === "string")
				throw Error("Controlled model server did not bind");
			modelPort = modelAddress.port;
		}
		const baseDesired = workloadDesiredFixture(1, "agent-cli", "internal-only");
		const configuration: AgentConfigurationRecordV2 = {
			schemaVersion: 2,
			agentId: baseDesired.agentId,
			revision: 1,
			source: keyedRuntime
				? {
						kind: "standard",
						templateId: "worker-controlled-codex",
						imageDigest: baseDesired.imageDigest,
						admissionRevision: "admitted",
						allowedEnvironmentKeys: [],
						allowedSecretKeys: [],
						platformManagedKeys: [],
						connectionEnabled: false,
					}
				: {
						kind: "custom",
						imageDigest: baseDesired.imageDigest,
						admissionRevision: "admitted",
						interactionMode: "platform-adapter",
						connectionEnabled: false,
					},
			modelConfiguration: keyedRuntime
				? {
						catalogRevision: "worker-controlled-catalog",
						options: [
							{
								optionId: "worker-controlled-model",
								endpointId: "worker-controlled-endpoint",
								modelId: "gpt-5.6-sol",
								reasoningLevels: ["medium"],
								credential: {
									secretId: "worker-controlled-secret",
									version: 1,
									isSet: true,
								},
							},
						],
						defaultOptionId: "worker-controlled-model",
						defaultReasoningLevel: "medium",
					}
				: null,
			environment: [],
			secrets: [],
			channels: [],
			channelRevision: "channels-1",
		};
		const catalog = catalogFixture();
		const catalogEndpoint = catalog.endpoints[0];
		if (!catalogEndpoint) throw Error("Controlled model endpoint is missing");
		const controlledCatalog = {
			...catalog,
			revision: "worker-controlled-catalog",
			validUntil: Date.now() + 600_000,
			endpoints: [
				{ ...catalogEndpoint, endpointId: "worker-controlled-endpoint" },
			],
		};
		const modelProjection = keyedRuntime
			? await projectRuntimeModelConfigurationV4({
					configuration,
					protocol: "openai-responses-v1",
					catalog: createFakeModelCatalogAdapterV1(controlledCatalog),
					signal: AbortSignal.timeout(1000),
				})
			: undefined;
		const desired = baseDesired;
		let runtimeCertificatePath: string | undefined;
		let runtimePrivateKeyPath: string | undefined;
		if (keyedRuntime) {
			runtimeCertificatePath = join(directory, "runtime.crt");
			runtimePrivateKeyPath = join(directory, "runtime.key");
			const service = workloadResourceNameV1(desired.agentId);
			await execFile("openssl", [
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-keyout",
				runtimePrivateKeyPath,
				"-out",
				runtimeCertificatePath,
				"-subj",
				`/CN=${service}`,
				"-addext",
				`subjectAltName=DNS:${service}.${policy.namespace}.svc,DNS:${service}-probe.${policy.namespace}.svc,IP:127.0.0.1`,
			]);
			const tlsSecret: V1Secret = {
				apiVersion: "v1",
				kind: "Secret",
				metadata: { name: `${service}-tls`, namespace: policy.namespace },
				type: "kubernetes.io/tls",
				data: {
					"tls.crt": (await readFile(runtimeCertificatePath)).toString(
						"base64",
					),
					"tls.key": (await readFile(runtimePrivateKeyPath)).toString("base64"),
				},
			};
			fake.resources.set(`Secret/${service}-tls`, tlsSecret);
		}
		const adapter = createKubernetesRuntimeAdapterV1({
			client: fake.client,
			policy,
			...(modelProjection ? { modelProjection } : {}),
			probe: async () => true,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending")
			throw Error("Expected controlled Workload identity");
		await adapter.promote(desired, identity);
		if (keyedRuntime) {
			expect(modelProjection?.schemaVersion).toBe(4);
			expect(desired.secretRefs).toEqual([]);
			const workload = fake.resources.get(
				`StatefulSet/${workloadResourceNameV1(desired.agentId)}`,
			) as V1StatefulSet | undefined;
			const container = workload?.spec?.template.spec?.containers[0];
			expect(container?.readinessProbe?.httpGet?.scheme).toBe("HTTPS");
			expect(
				container?.env?.some(({ name }) =>
					name.startsWith("AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_"),
				),
			).toBe(false);
		}
		const capacity = {
			schemaVersion: 1,
			imageDigest: desired.imageDigest,
			resourceProfileRef: policy.resourceProfileRef,
			resourceConfigurationHash: workloadResourceConfigurationHashV1(policy),
			conformanceEvidenceHash: "c".repeat(64),
			maximumConcurrentExecutions: 1,
		};
		const version = {
			configuration,
			deployment: desired,
			executionCapacity: capacity,
			...(modelProjection ? { modelProjection } : {}),
		};
		const state = {
			schemaVersion: 1,
			agentId: desired.agentId,
			sourceConfigurationRevision: 1,
			sourceLifecycleRevision: 1,
			revision: 1,
			fence: 1,
			phase: "ready",
			candidate: version,
			verified: version,
			verifiedRevision: 1,
			identity,
			rollback: false,
			failureCode: null,
			attempts: 0,
			capabilities: {
				modelSelection: keyedRuntime,
				attachments: false,
				resultFiles: false,
				supplementaryInstruction: true,
				connection: false,
			},
		};
		await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision) values (${desired.agentId}, 1, 'authority-1')`;
		await sql`insert into platform.agent_applications (id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at, management_revision, approval_revision, desired_state, service_availability, workload_revision, fence) values ('application-cli', ${desired.agentId}, 'user-cli', 'Controlled Agent', 'Fixture', 'available', 'trace', 'request', now(), 1, 1, 'running', 'ready', 1, 1)`;
		await sql`insert into platform.agent_owners (agent_id, owner_id, created_at) values (${desired.agentId}, 'user-cli', now())`;
		await sql`insert into platform.agent_availability (agent_id, target_type, target_id) values (${desired.agentId}, 'user', 'user-second')`;
		if (keyedRuntime) {
			for (const [subjectId, credential] of Object.entries(apiCredentials)) {
				await sql`insert into platform.agent_principal_grants
					(agent_id, principal_type, principal_id, grant_type, authorization_revision)
					values (${desired.agentId}, 'user', ${subjectId}, 'use', 'authority-1')`;
				await sql`insert into platform.platform_api_credentials
					(id, principal_type, principal_id, credential_hash, scopes)
					values (${`api-credential-${subjectId}`}, 'user', ${subjectId},
						${hashApiCredentialV1(credential)}, '["agent:use"]'::jsonb)`;
			}
			for (const [purpose, subjectId, keyId, plaintext] of [
				["agent-default", desired.agentId, "relay-agent-k1", relayKeys.first],
				["personal", "user-second", "relay-user-second-k1", relayKeys.second],
			] as const) {
				await sql`insert into platform.relay_key_subjects
					(purpose, subject_id, last_version, current_version)
					values (${purpose}, ${subjectId}, 1, 1)`;
				await sql`insert into platform.relay_key_versions
					(purpose, subject_id, key_version, key_id, ciphertext)
					values (${purpose}, ${subjectId}, 1, ${keyId},
						${sql.json(
							JSON.parse(
								JSON.stringify(
									relayEncryptor.encrypt({
										purpose,
										subjectId,
										keyId,
										keyVersion: 1,
										plaintext,
									}),
								),
							),
						)})`;
			}
		}
		await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at, configuration) values (${desired.agentId}, 1, ${configuration.source.kind === "standard" ? configuration.source.templateId : configuration.source.imageDigest}, now(), ${sql.json(JSON.parse(JSON.stringify(configuration)))})`;
		await sql`insert into platform.workload_reconciliations (agent_id, revision, state, next_attempt_at) values (${desired.agentId}, 1, ${sql.json(JSON.parse(JSON.stringify(state)))}, now() + interval '1 hour')`;
		const fakeDriver = realCodexE2e
			? undefined
			: await FakeRuntimeDriver.open(
					join(directory, "driver.json"),
					keyedRuntime
						? [
								{
									schemaVersion: 1,
									modelOptionId: "worker-controlled-model",
									reasoningLevel: "medium",
								},
							]
						: undefined,
				);
		const driver = realCodexE2e
			? await (async () => {
					await verifyCodexPilotInstallation();
					return CodexRuntimeDriver.open({
						nativeLane: "official-model-only",
						path: join(directory, "driver.json"),
						launchPath: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
						configVersion: "worker-controlled-codex-v1",
						defaultModelOptionId: "worker-controlled-model",
						defaultReasoningLevel: "medium",
						modelOptions: [
							{
								modelOptionId: "worker-controlled-model",
								model: "gpt-5.6-sol",
								reasoningLevels: ["medium"],
								endpoint: `http://127.0.0.1:${modelPort}/v1`,
							},
						],
						authorizeExternalAction: async (action) => {
							if (action.kind === "tool" || !host) {
								throw new Error(
									"controlled test lane forbids external actions",
								);
							}
							return host.authorizeExternalAction(action);
						},
					});
				})()
			: fakeDriver;
		if (!driver) throw Error("Runtime driver was not assembled");
		const dispatchCount = async () => {
			if (realCodexE2e) return modelRequests.length;
			if (!fakeDriver) throw Error("Fake runtime driver was not assembled");
			return fakeDriver.sideEffectCount();
		};
		host = await RuntimeHost.open({
			driver: Object.assign(driver, {
				probeReadiness: () => driver.getCapabilities(),
			}),
			readinessVerifier: createWorkloadReadinessVerifierV1({
				publicKeys: new Map([[signing.keyId, keys.publicKey]]),
				expectedIssuer: signing.issuer,
				binding: {
					workerId: signing.workerId,
					agentId: desired.agentId,
					workloadRevision: 1,
					fence: 1,
					imageDigest: desired.imageDigest,
				},
			}),
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			grantValidation: { expectedIssuer: signing.issuer },
			grantValidationV2: {
				expectedIssuer: signing.issuer,
				expectedWorkerId: signing.workerId,
			},
			...(keyedRuntime
				? {
						allowLegacyBusiness: false,
						validateGrantV4: createRuntimeExecutionGrantValidatorV4(
							new Map([[signing.keyId, keys.publicKey]]),
							{
								expectedIssuer: signing.issuer,
								expectedWorkerId: signing.workerId,
								expectedAgentId: desired.agentId,
							},
						),
					}
				: {}),
		});
		const app = createRuntimeHostApp({
			host,
			runtimeWorkerId: signing.workerId,
			readinessWorkerId: signing.workerId,
			serviceToken: "synthetic-runtime-token",
			verifyGrant: createExecutionGrantVerifier(
				new Map([[signing.keyId, keys.publicKey]]),
			),
			verifyGrantV2: createRuntimeExecutionGrantVerifierV2(
				new Map([[signing.keyId, keys.publicKey]]),
			),
		});
		let ackCount = 0;
		const runtimeHandler: RequestListener = async (req, res) => {
			traces.push(`runtime:${req.method}:${req.url}`);
			if (req.url === "/healthz") {
				res.end("ok");
				return;
			}
			const chunks: Uint8Array[] = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = Buffer.concat(chunks).toString();
			const parsed = body ? JSON.parse(body) : {};
			const observedRequest: (typeof requests)[number] = {
				path: req.url ?? "",
				executionId: parsed.businessRequest?.executionId ?? parsed.executionId,
				operationId:
					parsed.businessRequest?.operation?.id ?? parsed.operation?.id,
				sessionGeneration:
					parsed.businessRequest?.sessionGeneration ?? parsed.sessionGeneration,
				businessHostSessionRef: parsed.businessRequest?.hostSessionRef,
				deliveryFence:
					parsed.businessRequest?.operation?.executionDeliveryFence ??
					parsed.operation?.executionDeliveryFence,
				confirmedCursor: parsed.confirmedCursor,
				transportTls:
					"encrypted" in req.socket && req.socket.encrypted === true,
				...(parsed.businessRequest
					? {
							keyId: parsed.businessRequest.keyBinding?.ciphertextRef,
							keyVersion: parsed.businessRequest.keyBinding?.version,
							privateKeyMatches:
								parsed.privateKeyField?.keyDelivery?.relayKey ===
								(parsed.businessRequest.keyBinding?.ciphertextRef ===
								"relay-agent-k1"
									? relayKeys.first
									: relayKeys.rotated),
							keyInBusinessRequest: [
								relayKeys.first,
								relayKeys.rotated,
								relayKeys.second,
							].some((key) =>
								JSON.stringify(parsed.businessRequest).includes(key),
							),
						}
					: {}),
				...(parsed.keyBinding
					? {
							keyId: parsed.keyBinding.ciphertextRef,
							keyVersion: parsed.keyBinding.version,
						}
					: {}),
			};
			requests.push(observedRequest);
			if (
				packagedV4Fake &&
				req.url === "/internal/runtime/v4/events/read" &&
				!packagedV4ReadFailureInjected
			) {
				packagedV4ReadFailureInjected = true;
				observedRequest.responseStatus = 503;
				traces.push(`response:${req.url}:503:transient-fixture`);
				res.writeHead(503, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						schemaVersion: 1,
						code: "RUNTIME_UNAVAILABLE",
						message: "synthetic transient V4 event read failure",
						retryable: true,
						traceId: parsed.traceId ?? crypto.randomUUID(),
					}),
				);
				return;
			}
			const requestController = new AbortController();
			res.on("close", () => requestController.abort());
			const response = await app.request(`http://runtime${req.url}`, {
				signal: requestController.signal,
				method: req.method,
				headers: req.headers as Record<string, string>,
				...(body ? { body } : {}),
			});
			observedRequest.responseStatus = response.status;
			if (req.url?.endsWith("/ack") && response.ok) ackCount++;
			traces.push(`response:${req.url}:${response.status}`);
			if (
				realCodexE2e &&
				req.url?.endsWith("/ack") &&
				response.ok &&
				!withheldAck
			) {
				// Host has committed the ACK; keep its HTTP response off the wire
				// until both original Worker processes have been killed.
				withheldAck = {
					response: res,
					executionId: parsed.executionId,
					confirmedCursor: parsed.confirmedCursor,
				};
				return;
			}
			res.writeHead(response.status, Object.fromEntries(response.headers));
			if (response.body) {
				const stream = Readable.fromWeb(response.body as never);
				res.on("close", () => stream.destroy());
				stream.pipe(res);
			} else res.end();
		};
		runtimeServer = keyedRuntime
			? createSecureServer(
					{
						cert: await readFile(runtimeCertificatePath ?? ""),
						key: await readFile(runtimePrivateKeyPath ?? ""),
					},
					runtimeHandler,
				)
			: createServer(runtimeHandler);
		kube.listen(0, "127.0.0.1");
		runtimeServer.listen(0, "127.0.0.1");
		await Promise.all([
			once(kube, "listening"),
			once(runtimeServer, "listening"),
		]);
		const address = kube.address();
		const runtimeAddress = runtimeServer.address();
		if (
			!address ||
			typeof address === "string" ||
			!runtimeAddress ||
			typeof runtimeAddress === "string"
		)
			throw Error();
		const kubeUrl = `http://127.0.0.1:${address.port}`;
		const runtimeUrl = `${keyedRuntime ? "https" : "http"}://127.0.0.1:${runtimeAddress.port}`;
		if (keyedRuntime) {
			const legacySigner = createWorkerRuntimeGrantSignerV2({
				issuer: signing.issuer,
				workerId: signing.workerId,
				keyId: signing.keyId,
				privateKey: keys.privateKey,
			});
			const legacyV2Unsigned: Omit<RuntimeSubmitTurnRequestV2, "grant"> = {
				schemaVersion: 2,
				requestId: "legacy-static-key-v2-request",
				traceId: "legacy-static-key-v2-trace",
				actorId: "user-cli",
				channelId: "web",
				agentId: desired.agentId,
				conversationId: "legacy-static-key-v2-conversation",
				executionId: "legacy-static-key-v2-execution",
				turnId: "legacy-static-key-v2-turn",
				sessionGeneration: 1,
				deliveryFence: 1,
				hostSessionRef: undefined,
				input: { text: "must be rejected", attachments: [] },
				selection: {
					schemaVersion: 1,
					modelOptionId: "worker-controlled-model",
					reasoningLevel: "medium",
				},
			};
			const legacyV2Claims: ExecutionGrantClaimsV1 = {
				schemaVersion: 1,
				issuer: signing.issuer,
				audience: ["runtime_host"],
				issuedAt: new Date(Date.now() - 1_000).toISOString(),
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
				grantId: "legacy-static-key-v2-grant",
				agentId: legacyV2Unsigned.agentId,
				actorId: legacyV2Unsigned.actorId,
				channelId: legacyV2Unsigned.channelId,
				conversationId: legacyV2Unsigned.conversationId,
				executionId: legacyV2Unsigned.executionId,
				turnId: legacyV2Unsigned.turnId,
				sessionGeneration: legacyV2Unsigned.sessionGeneration,
				allowedCommands: ["turn.submit"],
				attachments: [],
				actionSetVersion: "packaged-v4-test",
				actionIds: [],
				traceId: legacyV2Unsigned.traceId,
			};
			const legacyV2Protected = Buffer.from(
				JSON.stringify({ alg: "EdDSA", kid: signing.keyId }),
			).toString("base64url");
			const legacyV2Payload = Buffer.from(
				JSON.stringify(legacyV2Claims),
			).toString("base64url");
			const legacyV2SigningInput = `${legacyV2Protected}.${legacyV2Payload}`;
			const legacyV2Grant: ExecutionGrantV1 = {
				schemaVersion: 1,
				format: "compact-jws",
				token: `${legacyV2SigningInput}.${sign(
					null,
					Buffer.from(legacyV2SigningInput, "ascii"),
					keys.privateKey,
				).toString("base64url")}`,
			};
			const legacyV2Response = await app.request("/internal/runtime/v2/turns", {
				method: "POST",
				headers: {
					authorization: "Bearer synthetic-runtime-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ ...legacyV2Unsigned, grant: legacyV2Grant }),
			});
			expect(legacyV2Response.status).toBe(403);
			expect(await legacyV2Response.json()).toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
			const legacyUnsigned: Omit<RuntimeSubmitTurnRequestV3, "grant"> = {
				schemaVersion: 3,
				requestId: "legacy-static-key-request",
				traceId: "legacy-static-key-trace",
				principal: { kind: "user", id: "user-cli" },
				channelId: "web",
				agentId: desired.agentId,
				conversationId: "legacy-static-key-conversation",
				executionId: "legacy-static-key-execution",
				turnId: "legacy-static-key-turn",
				sessionGeneration: 1,
				hostSessionRef: null,
				operation: {
					kind: "execution",
					id: "legacy-static-key-execution",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
				input: { text: "must be rejected", attachments: [] },
			};
			const legacyRequest = {
				...legacyUnsigned,
				grant: legacySigner(
					legacyUnsigned,
					{
						purpose: "business",
						authorizationRecordId: "legacy-static-key-authorization",
					},
					"turn.submit",
				),
			};
			const legacyResponse = await app.request("/internal/runtime/v3/turns", {
				method: "POST",
				headers: {
					authorization: "Bearer synthetic-runtime-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(legacyRequest),
			});
			expect(legacyResponse.status).toBe(403);
			expect(await legacyResponse.json()).toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
		}
		const config = new KubeConfig();
		config.loadFromOptions({
			clusters: [{ name: "test", server: kubeUrl, skipTLSVerify: true }],
			users: [{ name: "worker", token: "synthetic-token" }],
			contexts: [
				{
					name: "test",
					cluster: "test",
					user: "worker",
					namespace: policy.namespace,
				},
			],
			currentContext: "test",
		});
		const kubePath = join(directory, "kubeconfig");
		await writeFile(kubePath, config.exportConfig(), { mode: 0o600 });
		await writeFile(
			join(directory, "signing.pem"),
			keys.privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
		await writeFile(
			join(directory, "wrapping.der"),
			wrapping.privateKey.export({ type: "pkcs8", format: "der" }),
			{ mode: 0o600 },
		);
		// The build publishes the real deployment module without the mounted configuration.
		await execFile("pnpm", ["build"], {
			cwd: resolve(import.meta.dirname, "../apps/platform-worker"),
			timeout: 30_000,
		});
		moduleDirectory = await mkdtemp(
			join(
				resolve(import.meta.dirname, "../apps/platform-worker/dist"),
				"cli-test-",
			),
		);
		await copyFile(
			resolve(
				import.meta.dirname,
				"../apps/platform-worker/dist/deployment.mjs",
			),
			join(moduleDirectory, "deployment.mjs"),
		);
		const configSource = `import { readFile } from 'node:fs/promises'; import { createPrivateKey } from 'node:crypto';
export const signing = { ...${JSON.stringify(signing)}, privateKey: createPrivateKey(await readFile(${JSON.stringify(join(directory, "signing.pem"))})) };
export const serviceToken = 'synthetic-runtime-token';
export const directory = { async resolveUser(userId) { if (!['user-cli', 'user-second'].includes(userId)) return null; return { schemaVersion: 1, userId, accountStatus:'active',organizationIds:[],authorizationRevision:'identity-1'}; } };
const workerDatabaseUrl = new URL(${JSON.stringify(database.databaseUrl)});
workerDatabaseUrl.searchParams.set('application_name', 'conversation-worker-' + process.pid);
export const workloadInput = { databaseUrl: workerDatabaseUrl.toString(), policy: ${JSON.stringify(policy)},
kubernetes: { mode:'kubeconfig', path:${JSON.stringify(kubePath)}, context:'test', expectedServer:${JSON.stringify(kubeUrl)} },
registry: { endpoint:'https://registry.example.test', imageReferencePrefix:'registry.example.test', policy:{authorize:async()=>({status:'rejected'})} },
admissionPolicyRef:'policy',registrySubjectRef:'worker', templateModelBindings:${JSON.stringify(keyedRuntime ? [{ templateId: "worker-controlled-codex", imageDigest: desired.imageDigest, protocol: "openai-responses-v1" }] : [])}, runtimeModelVersion:${keyedRuntime ? 4 : "undefined"}, executionCapacityProfiles:[${JSON.stringify(capacity)}],
keyring: { keys:[{keyVersion:${JSON.stringify(keyedRuntime ? "worker-key" : "key")},privateKeyPkcs8DerBase64:(await readFile(${JSON.stringify(join(directory, "wrapping.der"))})).toString('base64')}] },
modelCatalog:{load:async()=>(${JSON.stringify(keyedRuntime ? controlledCatalog : {})})}, runtimeFetch: (url, init)=> fetch(${JSON.stringify(runtimeUrl)} + new URL(url).pathname,init), pollIntervalMs:100 };
`;
		await writeFile(join(moduleDirectory, "configuration.mjs"), configSource, {
			mode: 0o600,
		});
		const start = () => {
			const child = spawn(
				process.execPath,
				[
					resolve(
						import.meta.dirname,
						"../apps/platform-worker/dist/index.mjs",
					),
				],
				{
					env: {
						...process.env,
						...(runtimeCertificatePath
							? { NODE_EXTRA_CA_CERTS: runtimeCertificatePath }
							: {}),
						PLATFORM_WORKER_DEPLOYMENT_MODULE: pathToFileURL(
							join(moduleDirectory ?? "", "deployment.mjs"),
						).href,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			child.stdout?.on("data", (data) => output.push(String(data)));
			child.stderr?.on("data", (data) => output.push(String(data)));
			children.push(child);
			return child;
		};
		execution = new PostgresConversationExecutionTransactionV1({
			databaseUrl: database.databaseUrl,
		});
		authorization = new PostgresTaskAuthorizationStoreV1({
			databaseUrl: database.databaseUrl,
		});
		const taskStore = authorization;
		const api = createConversationExecutionUseCaseV1({
			transaction: execution,
			authorization: {
				async authorize() {
					const boundary = await taskStore.captureUserBoundary({
						user: {
							schemaVersion: 1,
							userId: "user-cli",
							accountStatus: "active",
							organizationIds: [],
							authorizationRevision: "identity-1",
						},
						agentId: desired.agentId,
						channelId: "web",
					});
					if (!boundary) return { outcome: "denied" as const };
					return {
						outcome: "allowed" as const,
						authority: {
							schemaVersion: 1 as const,
							actorId: "user-cli",
							agentId: desired.agentId,
							channelId: "web",
							authorizationRevision: boundary.agentAuthorizationRevision,
							supportsSupplementaryInstruction: true,
							taskBoundary: boundary,
						},
					};
				},
			},
		});
		const admit = async (id: string) => {
			const created = await api.createConversation({
				schemaVersion: 1,
				agentId: desired.agentId,
				idempotencyKey: id,
				requestId: id,
				traceId: id,
			});
			if (created.outcome !== "accepted")
				throw Error(`Create: ${created.outcome}`);
			const accepted = await api.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: created.result.conversationId,
				text: "controlled dispatch",
				idempotencyKey: id,
				requestId: id,
				traceId: id,
			});
			if (accepted.outcome !== "accepted")
				throw Error(`Accept: ${accepted.outcome}`);
			return {
				...accepted.result,
				conversationId: created.result.conversationId,
			};
		};
		const admitHttp = async (
			userId: keyof typeof apiCredentials,
			key: string,
		) => {
			const command = (path: string, key: string, body: unknown) =>
				fetch(`${apiOrigin}${path}`, {
					method: "POST",
					headers: {
						...(keyedRuntime
							? { authorization: `Bearer ${apiCredentials[userId]}` }
							: { cookie: browserSessionCookies[userId] }),
						"content-type": "application/json",
						"Idempotency-Key": key,
					},
					body: JSON.stringify(body),
				});
			if (!keyedRuntime) {
				const createdResponse = await command(
					`/api/v1/agents/${desired.agentId}/conversations`,
					`${key}-create`,
					{ schemaVersion: 1 },
				);
				const createdBody = await createdResponse.json();
				expect(createdResponse.status, JSON.stringify(createdBody)).toBe(201);
				const created = ConversationProjectionV1Schema.parse(createdBody);
				const acceptedResponse = await command(
					`/api/v1/conversations/${created.conversationId}/messages`,
					`${key}-message`,
					{ schemaVersion: 1, text: "controlled dispatch" },
				);
				const acceptedBody = await acceptedResponse.json();
				expect(acceptedResponse.status, JSON.stringify(acceptedBody)).toBe(202);
				const accepted = CommandAcceptedProjectionV1Schema.parse(acceptedBody);
				if (!accepted.executionId) throw Error("HTTP command had no execution");
				return {
					conversationId: created.conversationId,
					executionId: accepted.executionId,
				};
			}
			const acceptedResponse = await command(
				`/api/v1/agents/${desired.agentId}/tasks`,
				key,
				{ schemaVersion: 1, text: "controlled dispatch" },
			);
			const acceptedBody = await acceptedResponse.json();
			expect(acceptedResponse.status, JSON.stringify(acceptedBody)).toBe(202);
			const accepted = TaskAcceptedV1Schema.parse(acceptedBody);
			return {
				conversationId: accepted.conversationId,
				executionId: accepted.executionId,
			};
		};
		const admitFirst = async () => {
			const input: ProductionPlatformApiInputV1 = {
				databaseUrl: database.databaseUrl,
				imageRepository: "registry.example.test/agents/codex",
				identity: {
					resolve: async (request) => {
						const cookie = request.headers.get("cookie");
						const userId = Object.entries(browserSessionCookies).find(
							([, session]) => session === cookie,
						)?.[0];
						if (!userId || !["user-cli", "user-second"].includes(userId))
							return null;
						return {
							schemaVersion: 1,
							userId,
							displayName: "Controlled user",
							accountStatus: "active",
							organizationIds: [],
							roles: ["employee"],
							authorizationRevision: "identity-1",
						};
					},
					hydrateUsers: async (ids) =>
						ids.map((userId) => ({
							userId,
							displayName: "Controlled user",
							roles: ["employee"],
						})),
					resolveUser: async (userId) =>
						["user-cli", "user-second"].includes(userId)
							? {
									schemaVersion: 1,
									userId,
									accountStatus: "active",
									organizationIds: [],
									authorizationRevision: "identity-1",
								}
							: null,
				},
				loadAuthorityContext: async () => ({
					schemaVersion: 1,
					users: ["user-cli", "user-second"].map((userId) => ({
						userId,
						accountStatus: "active" as const,
					})),
					organizationIds: [],
				}),
				registry: {
					endpoint: "https://registry.example.test",
					imageReferencePrefix: "registry.example.test/agents",
					admissionPolicyRef: "controlled-policy",
					fetch: async () => new Response(null, { status: 404 }),
					policy: { authorize: async () => ({ status: "rejected" }) },
				},
				templates: [
					{
						templateId: "worker-controlled-codex",
						imageDigest: desired.imageDigest,
						imageReference: `registry.example.test/agents/codex@${desired.imageDigest}`,
						allowedEnvironmentKeys: [],
						allowedSecretKeys: [],
						platformManagedKeys: [],
						connectionEnabled: false,
					},
				],
				modelCatalog: {
					revision: "worker-controlled-catalog",
					load: async () => controlledCatalog,
				},
				channelPolicy: { revision: "channels-1", bindings: [] },
				encryptionKeys,
				resourceProfile: {
					profileId: "standard-medium",
					displayName: "Standard medium",
					estimatedResources: {
						cpuMillicores: 2000,
						memoryMiB: 4096,
						storageGiB: 20,
					},
				},
			};
			setProductionDeploymentInput(input);
			apiRunning = await startPlatformApiFromDeployment({
				moduleSpecifier: new URL(
					"./fixtures/platform-api-production-deployment.ts",
					import.meta.url,
				).href,
				port: 0,
				log: () => {},
			});
			apiOrigin = `http://127.0.0.1:${(apiRunning.server.address() as AddressInfo).port}`;
			if (!keyedRuntime) {
				// Browser admission requires a server-resolved session. An API header
				// must never fall back to that session, even when its cookie is valid.
				const rejectedBrowserHeaders: Record<string, string>[] = [
					{},
					{ cookie: "worker_session=unregistered" },
					{
						cookie: browserSessionCookies["user-cli"],
						authorization: "controlled-user-cli",
					},
					{
						cookie: browserSessionCookies["user-cli"],
						authorization: "Bearer invalid-browser-api-credential",
					},
				];
				for (const [index, headers] of rejectedBrowserHeaders.entries()) {
					const rejected = await fetch(
						`${apiOrigin}/api/v1/agents/${desired.agentId}/conversations`,
						{
							method: "POST",
							headers: {
								...headers,
								"content-type": "application/json",
								"Idempotency-Key": `worker-browser-auth-negative-${index}`,
							},
							body: JSON.stringify({ schemaVersion: 1 }),
						},
					);
					const body = await rejected.json();
					expect(rejected.status, JSON.stringify(body)).toBe(401);
					expect(body).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
				}
			}
			return admitHttp("user-cli", "worker-http");
		};
		if (!realCodexE2e && !packagedV4Fake) {
			// A database failure must not acknowledge a Runtime event that did not commit.
			await sql.unsafe("create sequence platform.test_event_attempts");
			await sql.unsafe(
				"create function platform.test_event_failure() returns trigger language plpgsql as $$ begin perform nextval('platform.test_event_attempts'); raise exception 'injected event transaction failure'; end $$",
			);
			await sql.unsafe(
				"create trigger test_event_failure before insert on platform.conversation_events for each row when (new.source = 'runtime') execute function platform.test_event_failure()",
			);
		}
		if (keyedRuntime) {
			start();
			start();
			await waitUntil(async () => {
				const sessions = await sql<{ application_name: string }[]>`
					select distinct application_name from pg_stat_activity
					where application_name like 'conversation-worker-%'
					  and query like '%select id, operation from platform.outbox_items%'
				`;
				return children
					.slice(0, 2)
					.every((child) =>
						sessions.some(
							(session) =>
								session.application_name === `conversation-worker-${child.pid}`,
						),
					);
			}, "both packaged Workers polling before first admission");
		}
		const first = await admitFirst();
		if (keyedRuntime) {
			await waitUntil(
				async () => (await dispatchCount()) === 1,
				"first HTTP dispatch",
			);
			const [pinned] = await sql<
				{ keyId: string; keyVersion: number; source: string }[]
			>`
				select relay_key_id as "keyId", relay_key_version::int as "keyVersion",
				       execution_source as source
				from platform.conversation_executions
				where execution_id=${first.executionId}
			`;
			expect(pinned).toEqual({
				keyId: "relay-agent-k1",
				keyVersion: 1,
				source: "platform-api",
			});
			await sql`insert into platform.relay_key_versions
				(purpose, subject_id, key_version, key_id, ciphertext)
				values ('agent-default', ${desired.agentId}, 2, 'relay-agent-k2',
					${sql.json(
						JSON.parse(
							JSON.stringify(
								relayEncryptor.encrypt({
									purpose: "agent-default",
									subjectId: desired.agentId,
									keyId: "relay-agent-k2",
									keyVersion: 2,
									plaintext: relayKeys.rotated,
								}),
							),
						),
					)})`;
			await sql`update platform.relay_key_subjects
				set last_version=2, current_version=2
				where purpose='agent-default' and subject_id=${desired.agentId}`;
		}
		const second = keyedRuntime
			? await admitHttp("user-second", "worker-second")
			: await admit("second");
		if (keyedRuntime) {
			const [admission] = await sql<
				{ actorId: string; principalId: string; accessKind: string }[]
			>`
				select e.actor_id as "actorId",
				       r.boundary->'principal'->>'id' as "principalId",
				       r.boundary->'accessSources'->0->>'kind' as "accessKind"
				from platform.conversation_executions e
				join platform.task_authorization_records r on r.execution_id=e.execution_id
				where e.execution_id=${second.executionId}
			`;
			expect(admission).toEqual({
				actorId: "user-second",
				principalId: "user-second",
				accessKind: "user",
			});
		}
		if (!keyedRuntime) {
			start();
			start();
		}
		await waitUntil(
			async () => (await dispatchCount()) === 1,
			"single effective first dispatch",
		);
		if (realCodexE2e) {
			expect(modelRequests[0]?.credential).toBe(relayKeys.first);
			expect(
				requests.find(
					(request) => request.path === "/internal/runtime/v4/turns",
				),
			).toMatchObject({
				executionId: first.executionId,
				transportTls: true,
				keyId: "relay-agent-k1",
				keyVersion: 1,
				privateKeyMatches: true,
				keyInBusinessRequest: false,
				responseStatus: 200,
			});
			expect(modelRequests[0]?.body).toContain("controlled dispatch");
			expect(modelJournalAtArrival).toHaveLength(1);
		}
		if (packagedV4Fake) {
			expect(modelRequests).toHaveLength(0);
			expect(
				requests.find(
					(request) => request.path === "/internal/runtime/v4/turns",
				),
			).toMatchObject({
				executionId: first.executionId,
				transportTls: true,
				keyId: "relay-agent-k1",
				keyVersion: 1,
				privateKeyMatches: true,
				keyInBusinessRequest: false,
				responseStatus: 200,
			});
			await waitUntil(
				async () =>
					(
						await sql`
							select 1 from platform.persisted_events
							where event_type='outbox.retry_scheduled'
							  and payload->>'errorCode' = 'RUNTIME_UNAVAILABLE'
						`
					).length >= 1,
				"V4 transient event retry is durable",
			);
			await sql`
				update platform.outbox_items
				set available_at=clock_timestamp(), lease_expires_at=null
				where payload->>'executionId'=${first.executionId}
				  and status='retry_scheduled'
			`;
			for (const child of children) child.kill("SIGKILL");
			await Promise.all(children.map((child) => once(child, "exit")));
			start();
			start();
			await waitUntil(
				async () =>
					(
						await sql<{ application_name: string }[]>`
							select distinct application_name from pg_stat_activity
							where application_name like 'conversation-worker-%'
							  and query like '%select id, operation from platform.outbox_items%'
						`
					).length >= 2,
				"replacement Workers polling after V4 retry",
			);
			await waitUntil(
				async () =>
					requests.some(
						(request) =>
							request.path === "/internal/runtime/v4/events/read" &&
							request.executionId === first.executionId &&
							request.responseStatus === 200,
					),
				"V4 replay succeeds after replacement Worker recovery",
			);
			await waitUntil(
				async () =>
					requests.some(
						(request) =>
							request.path === "/internal/runtime/v4/events/ack" &&
							request.executionId === first.executionId &&
							request.responseStatus === 200,
					),
				"V4 replay cursor acknowledgement after recovery",
			);
			const readRequests = requests.filter(
				(request) =>
					request.path === "/internal/runtime/v4/events/read" &&
					request.executionId === first.executionId,
			);
			expect(
				readRequests.some((request) => request.responseStatus === 503),
			).toBe(true);
			expect(
				readRequests.some((request) => request.responseStatus === 200),
			).toBe(true);
			expect(
				readRequests.every((request) => request.keyId === "relay-agent-k1"),
			).toBe(true);
			expect(
				requests
					.filter(
						(request) =>
							request.path === "/internal/runtime/v4/events/ack" &&
							request.executionId === first.executionId,
					)
					.every((request) => request.keyId === "relay-agent-k1"),
			).toBe(true);
			const [recovered] = await sql<
				{ status: string; fence: number; cursor: string | null }[]
			>`
				select e.status, e.delivery_fence::int as fence,
				       e.last_runtime_cursor as cursor
				from platform.conversation_executions e
				where e.execution_id=${first.executionId}
			`;
			expect(recovered?.status).toBe("processing");
			expect(recovered?.cursor).toBeTruthy();
			expect(
				readRequests
					.filter((request) => request.responseStatus === 200)
					.every((request) => request.deliveryFence === recovered?.fence),
			).toBe(true);
			const [retryOutbox] = await sql<{ attemptCount: number }[]>`
				select attempt_count::int as "attemptCount"
				from platform.outbox_items
				where payload->>'executionId'=${first.executionId}
			`;
			expect(retryOutbox?.attemptCount).toBeGreaterThan(0);
			expect(
				requests.filter(
					(request) => request.path === "/internal/runtime/v3/status",
				),
			).toHaveLength(0);
			if (!apiOrigin) throw Error("Production API did not start");
			const stopResponse = await fetch(
				`${apiOrigin}/api/v1/conversations/${first.conversationId}/tasks/${first.executionId}/cancel`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${apiCredentials["user-cli"]}`,
						"content-type": "application/json",
						"Idempotency-Key": "packaged-v4-stop",
					},
					body: JSON.stringify({ schemaVersion: 1 }),
				},
			);
			expect(stopResponse.status).toBe(202);
			await waitUntil(
				async () =>
					(
						await sql`
							select 1 from platform.conversation_executions
							where execution_id=${first.executionId} and status='cancelled'
						`
					).length === 1,
				"first V4 execution stops before the second Key dispatch",
			);
			await sql`
				update platform.outbox_items
				set available_at=clock_timestamp(), lease_expires_at=null
				where payload->>'executionId'=${second.executionId}
			`;
			await waitUntil(
				async () =>
					requests.some(
						(request) =>
							request.path === "/internal/runtime/v4/turns" &&
							request.executionId === second.executionId &&
							request.responseStatus === 200,
					),
				"second packaged Execution uses its pinned V4 Key",
			);
			const secondTurnRequests = requests.filter(
				(request) =>
					request.path === "/internal/runtime/v4/turns" &&
					request.executionId === second.executionId,
			);
			expect(secondTurnRequests).toHaveLength(1);
			expect(secondTurnRequests[0]).toMatchObject({
				keyId: "relay-agent-k2",
				keyVersion: 2,
				privateKeyMatches: true,
				keyInBusinessRequest: false,
				transportTls: true,
			});
			return;
		}
		expect(children.every((child) => child.exitCode === null)).toBe(true);
		if (!realCodexE2e) {
			await waitUntil(
				async () =>
					(await sql`select is_called from platform.test_event_attempts`)[0]
						?.is_called === true,
				"injected event transaction failure",
			);
			expect(
				await sql`select 1 from platform.conversation_events where source='runtime'`,
			).toHaveLength(0);
			expect(ackCount).toBe(0);
			await sql.unsafe(
				"drop trigger test_event_failure on platform.conversation_events",
			);
		}

		await waitUntil(
			async () =>
				(
					await sql`select 1 from platform.conversation_events where source='runtime' and (execution_id=${first.executionId} or execution_id=${second.executionId})`
				).length >= 1,
			"persisted running event",
		);
		const [active] =
			await sql`select execution_id, conversation_id from platform.conversation_executions where status='processing'`;
		if (!active) throw Error("No running execution");
		expect(await dispatchCount()).toBe(1);
		if (!realCodexE2e) {
			const response = await fetch(
				`${apiOrigin}/api/v2/conversations/${first.conversationId}/executions/${first.executionId}`,
				{ headers: { cookie: browserSessionCookies["user-cli"] } },
			);
			const body = await response.json();
			expect(response.status, JSON.stringify(body)).toBe(200);
			const detail = ExecutionDetailProjectionV2Schema.parse(body);
			expect(detail.executionId).toBe(first.executionId);
		}
		if (realCodexE2e) {
			expect(active.execution_id).toBe(first.executionId);
			expect(active.conversation_id).toBe(first.conversationId);
			const intent = modelJournalAtArrival[0];
			if (!intent) throw Error("No model intent in durable journal at arrival");
			expect(intent.executionId).toBe(active.execution_id);
			expect(intent.operationRef).toBeTruthy();
			expect(intent.attemptRef).toBeTruthy();
			expect(intent.operationRef).not.toBe(intent.attemptRef);
		}
		// The first ACK committed in Host, but its HTTP response never reached the
		// original Worker. Kill both owners and recover through automatic discovery.
		await waitUntil(async () => ackCount > 0, "committed event acknowledged");
		if (realCodexE2e) {
			expect(ackCount).toBe(1);
			expect(withheldAck?.executionId).toBe(active.execution_id);
			expect(withheldAck?.response.headersSent).toBe(false);
			const [confirmed] = await sql<{ cursor: string | null }[]>`
				select last_runtime_cursor as cursor from platform.conversation_executions
				where execution_id=${active.execution_id}
			`;
			expect(withheldAck?.confirmedCursor).toBe(confirmed?.cursor);
			const hostState = JSON.parse(
				await readFile(join(directory, "host.json"), "utf8"),
			) as {
				sessions: Record<
					string,
					{
						executionAuthorities?: Record<string, { confirmedCursor?: string }>;
					}
				>;
			};
			expect(
				Object.values(hostState.sessions).find(
					(session) => session.executionAuthorities?.[active.execution_id],
				)?.executionAuthorities?.[active.execution_id]?.confirmedCursor,
			).toBe(confirmed?.cursor);
		}
		const [before] =
			await sql`select delivery_fence::int as fence, host_session_ref, turn_id from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id=${active.execution_id}`;
		const readPersistedRows = async () => {
			const events = await sql<
				{
					eventId: string;
					adapterEventKey: string;
					eventDigest: string;
					eventType: string;
					eventPayloadText: string;
					sequence: number;
					conversationCursor: number;
				}[]
			>`
				select event_id as "eventId", adapter_event_key as "adapterEventKey",
				       event_digest as "eventDigest", event_type as "eventType",
				       event_payload::text as "eventPayloadText", sequence::int as sequence,
				       conversation_cursor::int as "conversationCursor"
				from platform.conversation_events
				where execution_id=${active.execution_id} order by sequence
			`;
			const audits = await sql<{ id: string }[]>`
				select id from platform.audit_events
				where target_id=${active.execution_id}
				  and action='execution.operation.observed'
				order by id
			`;
			return { events, auditIds: audits.map((audit) => audit.id) };
		};
		const beforeRows = realCodexE2e ? await readPersistedRows() : undefined;
		if (realCodexE2e) expect(beforeRows?.events.length).toBeGreaterThan(0);
		const priorRequests = requests.length;
		for (const child of children) child.kill("SIGKILL");
		await Promise.all(children.map((child) => once(child, "exit")));
		if (realCodexE2e) {
			await waitUntil(
				async () => withheldAck?.response.destroyed === true,
				"withheld ACK response socket closes after both Workers die",
			);
		}
		const [target] = await sql<
			{ id: string; attemptCount: number; fence: number }[]
		>`
			update platform.outbox_items
			set lease_expires_at=clock_timestamp()+interval '1 hour'
			where payload->>'executionId'=${active.execution_id} and status='processing'
			returning id, attempt_count::int as "attemptCount", delivery_fence::int as fence
		`;
		if (!target) throw Error("No expired outbox lease for takeover");
		const [queued] = await sql<
			{
				id: string;
				status: string;
				availableAt: Date;
				leaseExpiresAt: Date | null;
			}[]
		>`
			select id, status, available_at as "availableAt",
				lease_expires_at as "leaseExpiresAt" from platform.outbox_items
			where payload->>'executionId'=${second.executionId}
		`;
		if (
			!queued ||
			!["pending", "retry_scheduled", "processing"].includes(queued.status)
		)
			throw Error("No deferred outbox item for second execution");
		await sql`
			update platform.outbox_items
			set available_at=clock_timestamp()+interval '1 hour',
				lease_expires_at=case when status='processing'
					then clock_timestamp()+interval '1 hour' else lease_expires_at end
			where id=${queued.id}
		`;
		try {
			start();
			start();
			const ready = new Set<number>();
			await waitUntil(async () => {
				const sessions = await sql<{ application_name: string }[]>`
					select distinct application_name from pg_stat_activity
					where datname=current_database()
						and query like '%select id, operation from platform.outbox_items%'
				`;
				for (const child of children.slice(2))
					if (
						child.pid &&
						sessions.some(
							(session) =>
								session.application_name === `conversation-worker-${child.pid}`,
						)
					)
						ready.add(child.pid);
				return ready.size === 2;
			}, "both replacement Workers polling before lease expiry");
			await sql`
				update platform.outbox_items
				set lease_expires_at=clock_timestamp()+interval '3 seconds'
				where id=${target.id}
			`;
			await sql.begin(async (transaction) => {
				const [locked] = await transaction<{ notExpired: boolean }[]>`
					select lease_expires_at > clock_timestamp() as "notExpired"
					from platform.outbox_items where id=${target.id} for update
				`;
				expect(locked?.notExpired).toBe(true);
				let observedSessions: {
					applicationName: string;
					waitEventType: string | null;
					claimQuery: boolean;
				}[] = [];
				try {
					await waitUntil(async () => {
						observedSessions = await sql<typeof observedSessions>`
							select application_name as "applicationName",
								wait_event_type as "waitEventType",
								query like '%from platform.outbox_items where id =%' as "claimQuery"
							from pg_stat_activity where datname=current_database()
								and application_name like 'conversation-worker-%'
						`;
						return children
							.slice(2)
							.every((child) =>
								observedSessions.some(
									(session) =>
										session.applicationName ===
											`conversation-worker-${child.pid}` &&
										session.waitEventType === "Lock" &&
										session.claimQuery,
								),
							);
					}, "both replacement Workers blocked on the same outbox claim");
				} catch (error) {
					throw new Error(JSON.stringify(observedSessions), { cause: error });
				}
				const [held] = await sql<{ attemptCount: number; fence: number }[]>`
					select attempt_count::int as "attemptCount", delivery_fence::int as fence
					from platform.outbox_items where id=${target.id}
				`;
				expect(held).toEqual({
					attemptCount: target.attemptCount,
					fence: target.fence,
				});
			});
		} finally {
			if (!realCodexE2e)
				await sql`
					update platform.outbox_items
					set available_at=${queued.availableAt}, lease_expires_at=${queued.leaseExpiresAt}
					where id=${queued.id}
				`;
		}
		await waitUntil(
			async () =>
				requests
					.slice(priorRequests)
					.some((request) =>
						keyedRuntime
							? request.path === "/internal/runtime/v4/turns" &&
								request.executionId === active.execution_id &&
								request.operationId === active.execution_id &&
								request.responseStatus === 200
							: request.path.endsWith("/status") &&
								request.executionId === active.execution_id,
					),
			"takeover queries original Runtime execution",
		);
		const takeoverRequest = requests
			.slice(priorRequests)
			.find((request) =>
				keyedRuntime
					? request.path === "/internal/runtime/v4/turns" &&
						request.executionId === active.execution_id &&
						request.operationId === active.execution_id &&
						request.responseStatus === 200
					: request.path.endsWith("/status") &&
						request.executionId === active.execution_id,
			);
		if (!takeoverRequest)
			throw Error("Takeover Runtime request was not observed");
		if (keyedRuntime) {
			expect(takeoverRequest).toMatchObject({
				path: "/internal/runtime/v4/turns",
				executionId: active.execution_id,
				operationId: active.execution_id,
				sessionGeneration: 1,
				deliveryFence: target.fence + 1,
				keyId: "relay-agent-k1",
				keyVersion: 1,
				privateKeyMatches: true,
				keyInBusinessRequest: false,
				responseStatus: 200,
			});
		}
		await waitUntil(
			async () =>
				requests
					.slice(priorRequests)
					.some(
						(request) =>
							request.path.endsWith("/ack") &&
							request.executionId === active.execution_id &&
							request.responseStatus === 200,
					),
			"takeover acknowledges existing committed cursor",
		);
		const [claimed] = await sql<{ attemptCount: number; fence: number }[]>`
			select attempt_count::int as "attemptCount", delivery_fence::int as fence
			from platform.outbox_items where id=${target.id}
		`;
		expect(claimed).toEqual({
			attemptCount: target.attemptCount + 1,
			fence: target.fence + 1,
		});
		expect(await dispatchCount()).toBe(1);
		if (realCodexE2e) {
			if (!beforeRows) throw Error("Pre-kill event rows are unavailable");
			const afterRows = await readPersistedRows();
			expect(afterRows.events.slice(0, beforeRows.events.length)).toEqual(
				beforeRows.events,
			);
			const firstEvent = beforeRows.events[0];
			if (!firstEvent) throw Error("Pre-kill event is unavailable");
			expect(
				afterRows.events.filter(
					(event) =>
						event.eventType === firstEvent.eventType &&
						event.eventPayloadText === firstEvent.eventPayloadText,
				),
			).toHaveLength(1);
			expect(afterRows.auditIds).toEqual(
				expect.arrayContaining(beforeRows.auditIds),
			);
		}
		const activeTurnRequests = requests.filter(
			(request) =>
				request.path.endsWith("/turns") &&
				request.executionId === active.execution_id,
		);
		expect(activeTurnRequests).toHaveLength(keyedRuntime ? 2 : 1);
		if (keyedRuntime)
			expect(
				activeTurnRequests.every(
					(request) => request.operationId === active.execution_id,
				),
			).toBe(true);
		const [after] =
			await sql`select delivery_fence::int as fence, host_session_ref, turn_id from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id=${active.execution_id}`;
		expect(after?.host_session_ref).toBe(before?.host_session_ref);
		expect(after?.turn_id).toBe(before?.turn_id);
		expect(after?.fence).toBeGreaterThan(before?.fence);
		expect(
			requests
				.slice(priorRequests)
				.filter((request) => request.executionId === active.execution_id)
				.every((request) => request.deliveryFence === after?.fence),
		).toBe(true);
		if (realCodexE2e) {
			releaseModelResponse?.();
			await waitUntil(async () => {
				const facts = await sql<{ phase: string }[]>`
						select event_payload->'fact'->>'phase' as phase
						from platform.conversation_events
						where execution_id=${active.execution_id}
						  and event_type='execution.operation'
					`;
				const phases = new Set(facts.map((fact) => fact.phase));
				return ["intent", "started", "completed"].every((phase) =>
					phases.has(phase),
				);
			}, "persisted Codex model operation facts");
			const operationFacts = await sql<
				{
					eventId: string;
					phase: string;
					kind: string;
					modelOptionId: string | null;
					operationRef: string;
					attemptRef: string;
					auditEventId: string | null;
					auditOperationRef: string | null;
					auditAttemptRef: string | null;
					auditPhase: string | null;
				}[]
			>`
				select e.event_id as "eventId",
				       e.event_payload->'fact'->>'phase' as phase,
				       e.event_payload->'fact'->>'kind' as kind,
				       e.event_payload->'fact'->'model'->>'modelOptionId' as "modelOptionId",
				       e.event_payload->'fact'->>'operationRef' as "operationRef",
				       e.event_payload->'fact'->>'attemptRef' as "attemptRef",
				       a.details->>'eventId' as "auditEventId",
				       a.details->'fact'->>'operationRef' as "auditOperationRef",
				       a.details->'fact'->>'attemptRef' as "auditAttemptRef",
				       a.details->'fact'->>'phase' as "auditPhase"
				from platform.conversation_events e
				left join platform.audit_events a
				  on a.id='operation-observed:' || e.event_id
				 and a.target_id=e.execution_id
				 and a.action='execution.operation.observed'
				where e.execution_id=${active.execution_id}
				  and e.event_type='execution.operation'
				order by e.sequence
			`;
			expect(operationFacts.map((fact) => fact.phase)).toEqual([
				"intent",
				"started",
				"completed",
			]);
			if (!beforeRows) throw Error("Pre-kill event rows are unavailable");
			const finalRows = await readPersistedRows();
			expect(finalRows.events.slice(0, beforeRows.events.length)).toEqual(
				beforeRows.events,
			);
			const firstEvent = beforeRows.events[0];
			if (!firstEvent) throw Error("Pre-kill event is unavailable");
			expect(
				finalRows.events.filter(
					(event) =>
						event.eventType === firstEvent.eventType &&
						event.eventPayloadText === firstEvent.eventPayloadText,
				),
			).toHaveLength(1);
			expect(
				finalRows.events.every((event, index) => {
					if (index === 0) return true;
					const previous = finalRows.events[index - 1];
					return (
						previous !== undefined &&
						event.sequence === previous.sequence + 1 &&
						event.conversationCursor === previous.conversationCursor + 1
					);
				}),
			).toBe(true);
			expect(finalRows.auditIds).toEqual(
				operationFacts
					.map((fact) => `operation-observed:${fact.eventId}`)
					.sort(),
			);
			expect(operationFacts.every((fact) => fact.kind === "model")).toBe(true);
			expect(
				operationFacts.every(
					(fact) => fact.modelOptionId === "worker-controlled-model",
				),
			).toBe(true);
			const intent = modelJournalAtArrival[0];
			if (!intent) throw Error("No model intent in durable journal at arrival");
			expect(
				operationFacts.every(
					(fact) =>
						fact.operationRef === intent.operationRef &&
						fact.attemptRef === intent.attemptRef &&
						fact.auditEventId === fact.eventId &&
						fact.auditOperationRef === intent.operationRef &&
						fact.auditAttemptRef === intent.attemptRef &&
						fact.auditPhase === fact.phase,
				),
			).toBe(true);
			expect(modelJournalAtArrival).toHaveLength(1);
			expect(await dispatchCount()).toBe(1);
			await waitUntil(
				async () =>
					(
						await sql`select 1 from platform.conversation_executions where execution_id=${active.execution_id} and status='completed'`
					).length === 1,
				"recovered Codex execution completes",
			);
			if (!apiOrigin) throw Error("Production API did not start");
			const taskPath = `/api/v1/conversations/${first.conversationId}/tasks/${first.executionId}`;
			const readTask = async (path: string) => {
				const response = await fetch(`${apiOrigin}${path}`, {
					headers: {
						authorization: `Bearer ${apiCredentials["user-cli"]}`,
					},
				});
				const body = await response.json();
				expect(response.status, JSON.stringify(body)).toBe(200);
				return body;
			};
			const task = TaskProjectionV1Schema.parse(await readTask(taskPath));
			expect(task).toMatchObject({
				conversationId: first.conversationId,
				executionId: first.executionId,
				status: "completed",
			});
			const assertPersistedOperations = (events: typeof task.events) => {
				const operations = events.filter(
					(event) => event.type === "execution.operation",
				);
				for (const fact of operationFacts) {
					const event = operations.find(
						(item) => item.eventId === fact.eventId,
					);
					expect(event).toMatchObject({
						eventId: fact.eventId,
						conversationId: first.conversationId,
						executionId: first.executionId,
						payload: {
							kind: "model",
							phase: fact.phase,
							operationRef: fact.operationRef,
							attemptRef: fact.attemptRef,
						},
					});
				}
			};
			assertPersistedOperations(task.events);
			const webRead = async (path: string) => {
				const response = await fetch(`${apiOrigin}${path}`, {
					headers: { cookie: browserSessionCookies["user-cli"] },
				});
				const body = await response.json();
				expect(response.status, JSON.stringify(body)).toBe(404);
				expect(body).toMatchObject({
					schemaVersion: 1,
					code: "RESOURCE_UNAVAILABLE",
				});
			};
			await webRead(`/api/v2/conversations/${first.conversationId}`);
			await webRead(
				`/api/v2/conversations/${first.conversationId}/executions/${first.executionId}`,
			);
			const secondPrincipal = await fetch(`${apiOrigin}${taskPath}`, {
				headers: {
					authorization: `Bearer ${apiCredentials["user-second"]}`,
				},
			});
			const secondPrincipalBody = await secondPrincipal.json();
			expect(secondPrincipal.status, JSON.stringify(secondPrincipalBody)).toBe(
				404,
			);
			const invalidCredential = await fetch(`${apiOrigin}${taskPath}`, {
				headers: { authorization: "Bearer invalid-task-credential" },
			});
			const invalidCredentialBody = await invalidCredential.json();
			expect(
				invalidCredential.status,
				JSON.stringify(invalidCredentialBody),
			).toBe(401);
			const [cursorFact, ...replayedFacts] = operationFacts;
			if (!cursorFact) throw Error("No persisted operation replay cursor");
			expect(cursorFact.phase).toBe("intent");
			expect(replayedFacts.length).toBeGreaterThan(0);
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10_000);
			try {
				const response = await fetch(`${apiOrigin}${taskPath}/events`, {
					headers: {
						authorization: `Bearer ${apiCredentials["user-cli"]}`,
						"Last-Event-ID": cursorFact.eventId,
					},
					signal: controller.signal,
				});
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toContain(
					"text/event-stream",
				);
				if (!response.body) throw Error("V2 SSE body is missing");
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				const pending = new Set(replayedFacts.map((fact) => fact.eventId));
				let buffer = "";
				while (pending.size > 0) {
					const next = await reader.read();
					if (next.done) throw Error("V2 SSE ended before operation replay");
					buffer += decoder.decode(next.value, { stream: true });
					let end = buffer.indexOf("\n\n");
					while (end >= 0) {
						const frame = buffer.slice(0, end);
						buffer = buffer.slice(end + 2);
						const eventId = frame.match(/^id: (.+)$/m)?.[1];
						const data = frame.match(/^data: (.+)$/m)?.[1];
						expect(eventId).not.toBe(cursorFact.eventId);
						if (eventId && data && pending.has(eventId)) {
							const parsed = TaskSseMessageV1Schema.parse(JSON.parse(data));
							const fact = operationFacts.find(
								(item) => item.eventId === eventId,
							);
							expect(parsed).toMatchObject({
								eventId,
								type: "execution.operation",
								conversationId: first.conversationId,
								executionId: first.executionId,
								payload: {
									phase: fact?.phase,
									operationRef: fact?.operationRef,
									attemptRef: fact?.attemptRef,
								},
							});
							pending.delete(eventId);
						}
						end = buffer.indexOf("\n\n");
					}
				}
			} finally {
				clearTimeout(timeout);
				controller.abort();
			}
			expect(await dispatchCount()).toBe(1);
			await sql`
				update platform.outbox_items
				set available_at=clock_timestamp(),
				    lease_expires_at=case when status='processing'
				      then clock_timestamp() else lease_expires_at end
				where id=${queued.id}
			`;
			await waitUntil(
				async () => modelRequests.length === 2,
				"second principal reaches controlled native model endpoint",
			);
			expect(modelRequests[1]?.credential).toBe(relayKeys.rotated);
			expect(modelRequests[1]?.body).toContain("controlled dispatch");
			await waitUntil(
				async () =>
					modelJournalAtArrival.some(
						(intent) => intent.executionId === second.executionId,
					),
				"second principal model intent preceded provider request",
			);
			const secondIntent = modelJournalAtArrival.find(
				(intent) => intent.executionId === second.executionId,
			);
			if (!secondIntent) throw Error("Second principal model intent missing");
			recordNativeStage("third.admit.begin");
			const third = await admitHttp("user-second", "worker-third");
			recordNativeStage("third.admit.done", { executionId: third.executionId });
			await waitUntil(async () => {
				const [queuedThird] = await sql<{ status: string }[]>`
					select status from platform.outbox_items
					where payload->>'executionId'=${third.executionId}
				`;
				return ["pending", "retry_scheduled"].includes(
					queuedThird?.status ?? "",
				);
			}, "third task remains queued behind second principal");
			recordNativeStage("third.pending.observed", {
				executionId: third.executionId,
			});
			let heldThird: { id: string; status: string }[];
			try {
				recordNativeStage("third.hold.begin", {
					executionId: third.executionId,
				});
				heldThird = await sql.begin(async (transaction) => {
					await transaction`
						select set_config('lock_timeout', '3s', true),
						       set_config('statement_timeout', '5s', true)
					`;
					return transaction<{ id: string; status: string }[]>`
						update platform.outbox_items o
						set available_at=clock_timestamp()+interval '1 hour'
						where o.id=${`conversation:turn:${third.executionId}`}
						  and o.payload->>'executionId'=${third.executionId}
						  and o.status in ('pending','retry_scheduled')
						  and exists (
							select 1 from platform.conversation_executions e
							where e.execution_id=${third.executionId} and e.status='waiting'
						  )
								returning o.id, o.status
							`;
				});
				recordNativeStage("third.hold.commit", {
					executionId: third.executionId,
					rows: heldThird.length,
				});
			} catch (error) {
				recordNativeStage("third.hold.error", {
					error: error instanceof Error ? error.message : String(error),
				});
				await sampleBlocking("third.hold");
				throw error;
			}
			expect(heldThird).toHaveLength(1);
			recordNativeStage("second.response.release");
			releaseSecondModelResponse?.();
			await waitUntil(
				async () =>
					(
						await sql`
							select 1 from platform.conversation_executions
							where execution_id=${second.executionId} and status='completed'
						`
					).length === 1,
				"second principal native Codex execution completes",
			);
			recordNativeStage("second.completed", {
				executionId: second.executionId,
			});
			const secondFacts = await sql<
				{
					phase: string;
					operationRef: string;
					attemptRef: string;
					auditEventId: string | null;
					eventId: string;
				}[]
			>`
				select e.event_id as "eventId",
				       e.event_payload->'fact'->>'phase' as phase,
				       e.event_payload->'fact'->>'operationRef' as "operationRef",
				       e.event_payload->'fact'->>'attemptRef' as "attemptRef",
				       a.details->>'eventId' as "auditEventId"
				from platform.conversation_events e
				left join platform.audit_events a
				  on a.id='operation-observed:' || e.event_id
				 and a.target_id=e.execution_id
				 and a.action='execution.operation.observed'
				where e.execution_id=${second.executionId}
				  and e.event_type='execution.operation'
			`;
			expect(secondFacts.map((fact) => fact.phase)).toEqual(
				expect.arrayContaining(["intent", "started", "completed"]),
			);
			expect(
				secondFacts.every(
					(fact) =>
						fact.operationRef === secondIntent.operationRef &&
						fact.attemptRef === secondIntent.attemptRef &&
						fact.auditEventId === fact.eventId,
				),
			).toBe(true);
			const revokedRevision = "authority-2";
			recordNativeStage("third.revoke.begin", {
				executionId: third.executionId,
			});
			let revokedGrant: { principal_id: string; grant_type: string }[];
			try {
				revokedGrant = await sql.begin(async (transaction) => {
					await transaction`
						select set_config('lock_timeout', '3s', true),
						       set_config('statement_timeout', '5s', true)
					`;
					await transaction`
						select id from platform.agents
						where id=${desired.agentId} for update
					`;
					const revoked = await transaction<
						{ principal_id: string; grant_type: string }[]
					>`
						update platform.agent_principal_grants
						set revoked_at=clock_timestamp()
						where agent_id=${desired.agentId}
						  and principal_type='user'
						  and principal_id='user-second'
						  and grant_type='use'
						  and revoked_at is null
						returning principal_id, grant_type
					`;
					if (revoked.length !== 1)
						throw Error("Expected one API grant to revoke");
					const [agent] = await transaction<
						{ authorization_revision: string }[]
					>`
						update platform.agents
						set authorization_revision=${revokedRevision}
						where id=${desired.agentId}
						returning authorization_revision
					`;
					if (agent?.authorization_revision !== revokedRevision)
						throw Error("Agent authorization revision did not advance");
					await transaction`
						update platform.agent_principal_grants
						set authorization_revision=${revokedRevision}
						where agent_id=${desired.agentId} and revoked_at is null
					`;
					return revoked;
				});
				recordNativeStage("third.revoke.commit", {
					executionId: third.executionId,
					rows: revokedGrant.length,
				});
			} catch (error) {
				recordNativeStage("third.revoke.error", {
					error: error instanceof Error ? error.message : String(error),
				});
				await sampleBlocking("third.revoke");
				throw error;
			}
			expect(revokedGrant).toEqual([
				{ principal_id: "user-second", grant_type: "use" },
			]);
			const grants = await sql<
				{
					principalId: string;
					grantType: string;
					authorizationRevision: string;
					revoked: boolean;
				}[]
			>`
					select principal_id as "principalId", grant_type as "grantType",
					       authorization_revision as "authorizationRevision",
					       revoked_at is not null as revoked
					from platform.agent_principal_grants
					where agent_id=${desired.agentId} and principal_type='user'
					order by principal_id, grant_type
				`;
			expect(grants).toEqual([
				{
					principalId: "user-cli",
					grantType: "use",
					authorizationRevision: revokedRevision,
					revoked: false,
				},
				{
					principalId: "user-second",
					grantType: "use",
					authorizationRevision: "authority-1",
					revoked: true,
				},
			]);
			await sql`
					update platform.outbox_items set available_at=clock_timestamp()
					where payload->>'executionId'=${third.executionId}
				`;
			await waitUntil(
				async () =>
					(
						await sql`
								select 1 from platform.conversation_executions
								where execution_id=${third.executionId} and status='cancelled'
							`
					).length === 1,
				"revoked queued principal is rejected before Runtime dispatch",
			);
			recordNativeStage("third.cancelled", { executionId: third.executionId });
			expect(
				requests.filter(
					(request) =>
						request.path.endsWith("/turns") &&
						request.executionId === third.executionId,
				),
			).toHaveLength(0);
			const [rejectedOutbox] = await sql<{ status: string }[]>`
					select status from platform.outbox_items
					where id=${`conversation:turn:${third.executionId}`}
				`;
			expect(rejectedOutbox?.status).toBe("failed");
			const [rejectedMessage] = await sql<
				{ status: string; failureCode: string | null }[]
			>`
					select status, failure_code as "failureCode"
					from platform.conversation_messages
					where execution_id=${third.executionId}
				`;
			expect(rejectedMessage).toEqual({
				status: "failed",
				failureCode: "AUTHORIZATION_REVOKED",
			});
			const cancelledStatusAudits = await sql<
				{ reason: string | null; originalPrincipal: unknown }[]
			>`
					select details->>'reason' as reason,
					       details->'originalPrincipal' as "originalPrincipal"
					from platform.audit_events
					where target_id=${third.executionId}
					  and action='task.status.changed'
					  and details->>'status'='cancelled'
				`;
			expect(cancelledStatusAudits).toEqual([
				{
					reason: "AUTHORIZATION_REVOKED",
					originalPrincipal: { kind: "user", id: "user-second" },
				},
			]);
			const controls = await sql<{ reason: string }[]>`
				select reason from platform.task_control_records
				where execution_id=${third.executionId}
			`;
			expect(controls).toEqual([{ reason: "authorization_revoked" }]);
			const controlAudits = await sql`
					select id from platform.audit_events
					where target_id=${third.executionId}
					  and action='task.control.created' and actor_type='system'
				`;
			expect(controlAudits).toHaveLength(1);
			const [authorizationRecord] = await sql<{ revoked: boolean }[]>`
					select revoked_at is not null as revoked
					from platform.task_authorization_records
					where execution_id=${third.executionId}
				`;
			expect(authorizationRecord?.revoked).toBe(true);
			expect(modelRequests).toHaveLength(2);
			expect(await dispatchCount()).toBe(2);
		}
		if (!realCodexE2e) {
			// The same Conversation cannot start another concurrent reply.
			const supplement = await api.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: active.conversation_id,
				text: "supplement",
				idempotencyKey: "supplement",
				requestId: "supplement",
				traceId: "supplement",
			});
			expect(supplement.outcome).toBe("accepted");
			if (supplement.outcome !== "accepted")
				throw Error("Expected supplementary instruction");
			expect(supplement.result.executionId).toBe(active.execution_id);
			await waitUntil(
				async () =>
					requests.some(
						(request) =>
							request.path.endsWith("/instructions") &&
							request.executionId === active.execution_id &&
							request.responseStatus === 200,
					),
				"supplement preserves the active Execution",
			);
			const stop = await api.stop({
				schemaVersion: 1,
				command: "stop",
				targetExecutionId: active.execution_id,
				conversationId: active.conversation_id,
				idempotencyKey: "stop",
				requestId: "stop",
				traceId: "stop",
			});
			expect(stop.outcome).toBe("accepted");
			await waitUntil(
				async () =>
					(
						await sql`select 1 from platform.conversation_executions where execution_id=${active.execution_id} and status='cancelled'`
					).length === 1,
				"durable stop completion",
			);
			await waitUntil(
				async () =>
					(
						await sql`select 1 from platform.conversation_executions where execution_id<>${active.execution_id} and status='processing'`
					).length === 1,
				"deferred conversation after capacity release",
			);
		}
		expect(ackCount).toBeGreaterThan(0);
		for (const child of children.slice(2)) child.kill("SIGTERM");
		await Promise.all(
			children.map((child) =>
				child.exitCode !== null || child.signalCode
					? Promise.resolve()
					: once(child, "exit"),
			),
		);
		expect(children.slice(2).map((child) => child.exitCode)).toEqual([0, 0]);
		expect(children.slice(0, 2).map((child) => child.signalCode)).toEqual([
			"SIGKILL",
			"SIGKILL",
		]);
		expect(output.join("")).not.toContain("PRIVATE KEY");
	} catch (error) {
		recordNativeStage("catch", {
			stageAtFailure: nativeStage,
			error:
				error instanceof Error
					? {
							name: error.name,
							message: error.message,
							stack: error.stack?.slice(0, 1200),
						}
					: String(error),
		});
		const snapshot = async <T>(
			label: string,
			query: Promise<T> & { cancel?: () => void },
		) => {
			try {
				return await settleQuery(query, label);
			} catch (snapshotError) {
				return {
					error:
						snapshotError instanceof Error
							? snapshotError.message
							: String(snapshotError),
				};
			}
		};
		const [audit, outbox, execution] = await Promise.all([
			snapshot(
				"audit snapshot",
				sql`select event_type, payload->>'errorCode' as error_code from platform.persisted_events`,
			),
			snapshot(
				"outbox snapshot",
				sql`select id, status, attempt_count, delivery_fence, available_at, lease_expires_at from platform.outbox_items`,
			),
			snapshot(
				"execution snapshot",
				sql`select execution_id, status, execution_source, relay_key_id from platform.conversation_executions`,
			),
		]);
		recordNativeStage("catch.snapshots.done");
		throw new Error(
			JSON.stringify({
				traces: traces.slice(-30),
				requests: requests.slice(-20),
				workerOutput: output
					.join("")
					.replaceAll(relayKeys.first, "[redacted]")
					.replaceAll(relayKeys.rotated, "[redacted]")
					.replaceAll(relayKeys.second, "[redacted]")
					.slice(-1200),
				processes: children.map((child) => ({
					exitCode: child.exitCode,
					signalCode: child.signalCode,
				})),
				audit,
				outbox,
				execution,
			}),
			{ cause: error },
		);
	} finally {
		recordNativeStage("cleanup.begin");
		releaseModelResponse?.();
		releaseSecondModelResponse?.();
		recordNativeStage("provider.gates.released");
		for (const child of children)
			if (child.exitCode === null) child.kill("SIGKILL");
		const cleanup = async (label: string, action: () => Promise<unknown>) => {
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					action(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(`Cleanup timed out: ${label}`)),
							5_000,
						);
					}),
				]);
				recordNativeStage(`cleanup.${label}.done`);
			} catch (cleanupError) {
				recordNativeStage(`cleanup.${label}.error`, {
					error:
						cleanupError instanceof Error
							? cleanupError.message
							: String(cleanupError),
				});
			} finally {
				if (timer) clearTimeout(timer);
			}
		};
		await cleanup("children", async () => {
			await Promise.all(
				children.map((child) =>
					child.exitCode !== null || child.signalCode
						? Promise.resolve()
						: once(child, "exit"),
				),
			);
		});
		await cleanup("stores", async () => {
			await Promise.all([
				execution?.close(),
				authorization?.close(),
				apiRunning ? createPlatformApiShutdown(apiRunning)() : undefined,
			]);
		});
		await cleanup("sql", () => sql.end({ timeout: 0 }));
		await cleanup("diagnostic-sql", () => diagnosticSql.end({ timeout: 0 }));
		await cleanup("host", async () => host?.close());
		modelServer?.closeAllConnections();
		runtimeServer?.closeAllConnections();
		kube.closeAllConnections();
		await cleanup("servers", async () => {
			await Promise.all([
				runtimeServer
					? new Promise<void>((done) => runtimeServer?.close(() => done()))
					: undefined,
				new Promise<void>((done) => kube.close(() => done())),
				modelServer
					? new Promise<void>((done) => modelServer?.close(() => done()))
					: undefined,
			]);
		});
		await cleanup("database", () => database.stop());
		if (moduleDirectory)
			await cleanup("module-directory", () =>
				rm(moduleDirectory as string, { recursive: true, force: true }),
			);
		await cleanup("fixture-directory", () =>
			rm(directory, { recursive: true, force: true }),
		);
	}
}, 120_000);
