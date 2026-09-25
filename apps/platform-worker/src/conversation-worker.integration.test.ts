import {
	type ChildProcess,
	execFile as execFileCallback,
	spawn,
} from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	CodexRuntimeDriver,
	createRuntimeExecutionGrantVerifierV2,
	createWorkloadReadinessVerifierV1,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	verifyCodexPilotInstallation,
} from "@agent-infra/agent-runtime";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	createFakeModelAccessValidatorV1,
	createFakeModelCatalogAdapterV1,
	projectRuntimeModelConfigurationV1,
} from "@agent-infra/model-catalog";
import {
	type AgentConfigurationRecordV2,
	createConversationExecutionUseCaseV1,
} from "@agent-infra/platform-core";
import {
	PostgresConversationExecutionTransactionV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import { KubeConfig } from "@kubernetes/client-node";
import postgres from "postgres";
import { expect, it } from "vitest";
import { catalogFixture } from "../../../packages/model-catalog/src/catalog.fixture.js";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";

const execFile = promisify(execFileCallback);
const realCodexE2e = process.env.AGENT_INFRA_REAL_CODEX_E2E === "1";

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

async function waitUntil(check: () => Promise<boolean>, label: string) {
	for (let attempt = 0; attempt < 150; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw Error(`Timed out: ${label}`);
}

// Real PostgreSQL and the packaged production module/CLI, with controlled Kubernetes
// and Runtime HTTP. AGENT_INFRA_REAL_CODEX_E2E adds the fixed Codex/provider lane;
// neither mode is identity-provider, Connection, or browser acceptance.
it("automatically dispatches lawful Core admissions through two packaged Worker processes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "worker-766-"));
	const database = await startPostgresTestDatabase("766-worker-dispatch");
	const sql = postgres(database.databaseUrl, { max: 2 });
	const children: ChildProcess[] = [];
	const output: string[] = [];
	const traces: string[] = [];
	const requests: {
		path: string;
		executionId?: string;
		deliveryFence?: number;
		confirmedCursor?: string;
		responseStatus?: number;
	}[] = [];
	const modelRequests: { body: string; authenticated: boolean }[] = [];
	let modelServer: ReturnType<typeof createServer> | undefined;
	let modelPort: number | undefined;
	let releaseModelResponse: (() => void) | undefined;
	const modelResponseGate = realCodexE2e
		? new Promise<void>((resolve) => {
				releaseModelResponse = resolve;
			})
		: Promise.resolve();
	const keys = generateKeyPairSync("ed25519");
	const wrapping = generateKeyPairSync("rsa", { modulusLength: 3072 });
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
	let runtimeServer: ReturnType<typeof createServer> | undefined;
	let execution: PostgresConversationExecutionTransactionV1 | undefined;
	let authorization: PostgresTaskAuthorizationStoreV1 | undefined;
	let moduleDirectory: string | undefined;
	try {
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		if (realCodexE2e) {
			modelServer = createServer(async (request, response) => {
				const chunks: Uint8Array[] = [];
				for await (const chunk of request) chunks.push(chunk);
				const body = Buffer.concat(chunks).toString();
				modelRequests.push({
					body,
					authenticated:
						request.headers.authorization ===
						"Bearer worker-controlled-model-credential",
				});
				if (!modelRequests.at(-1)?.authenticated) {
					response.writeHead(401);
					response.end();
					return;
				}
				// Keep the controlled provider response open until the Worker has
				// durably observed the accepted running Execution. Otherwise the
				// synthetic model can complete before the takeover assertions read
				// the processing state that this test is exercising.
				if (!response.destroyed)
					await writeSyntheticModelResponse(response, modelResponseGate);
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
			source: realCodexE2e
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
			modelConfiguration: realCodexE2e
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
		const modelSecretRef = {
			schemaVersion: 1 as const,
			ownerType: "agent-owner" as const,
			ownerId: "user-cli",
			agentId: baseDesired.agentId,
			secretId: "worker-controlled-secret",
			secretVersion: 1,
			configRevision: 1,
			algorithmVersion: "aes-256-gcm:v1" as const,
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
			wrappingKeyVersion: "worker-key",
			name: "worker-controlled-model-secret",
		};
		const modelSecretKey = `MODEL_CREDENTIAL_${createHash("sha256")
			.update("model:worker-controlled-model")
			.digest("hex")
			.toUpperCase()}`;
		const catalog = catalogFixture();
		const catalogEndpoint = catalog.endpoints[0];
		if (!catalogEndpoint) throw Error("Controlled model endpoint is missing");
		const modelProjection = realCodexE2e
			? await projectRuntimeModelConfigurationV1({
					configuration,
					protocol: "openai-responses-v1",
					catalog: createFakeModelCatalogAdapterV1({
						...catalog,
						revision: "worker-controlled-catalog",
						endpoints: [
							{
								...catalogEndpoint,
								endpointId: "worker-controlled-endpoint",
							},
						],
					}),
					access: createFakeModelAccessValidatorV1([
						{
							endpointId: "worker-controlled-endpoint",
							modelId: "gpt-5.6-sol",
							reasoningLevels: ["medium"],
							credential: "worker-controlled-model-credential",
						},
					]),
					signal: AbortSignal.timeout(1000),
					credentialFor: async () => ({
						reference: {
							secretId: modelSecretRef.secretId,
							secretVersion: 1,
							configRevision: 1,
							name: modelSecretRef.name,
						},
						key: modelSecretKey,
						plaintext: new TextEncoder().encode(
							"worker-controlled-model-credential",
						),
					}),
				})
			: undefined;
		const desired = realCodexE2e
			? validateAgentWorkloadDesiredV1({
					...baseDesired,
					secretRefs: [modelSecretRef],
				})
			: baseDesired;
		const adapter = createKubernetesRuntimeAdapterV1({
			client: fake.client,
			policy,
			...(modelProjection ? { modelProjection } : {}),
			probe: async () => true,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending")
			throw Error("Expected controlled Workload identity");
		if (realCodexE2e) {
			const secretUid = await adapter.applyImmutableSecret(
				desired,
				modelSecretRef.name,
				modelSecretKey,
				new TextEncoder().encode("worker-controlled-model-credential"),
			);
			await adapter.bindSecretFence(
				desired,
				identity,
				modelSecretRef.name,
				1,
				secretUid,
			);
		}
		await adapter.promote(desired, identity);
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
				modelSelection: false,
				attachments: false,
				resultFiles: false,
				supplementaryInstruction: true,
				connection: false,
			},
		};
		await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision) values (${desired.agentId}, 1, 'authority-1')`;
		await sql`insert into platform.agent_applications (id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at, management_revision, approval_revision, desired_state, service_availability, workload_revision, fence) values ('application-cli', ${desired.agentId}, 'user-cli', 'Controlled Agent', 'Fixture', 'available', 'trace', 'request', now(), 1, 1, 'running', 'ready', 1, 1)`;
		await sql`insert into platform.agent_owners (agent_id, owner_id, created_at) values (${desired.agentId}, 'user-cli', now())`;
		await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at, configuration) values (${desired.agentId}, 1, 'admitted', now(), ${sql.json(JSON.parse(JSON.stringify(configuration)))})`;
		await sql`insert into platform.workload_reconciliations (agent_id, revision, state, next_attempt_at) values (${desired.agentId}, 1, ${sql.json(JSON.parse(JSON.stringify(state)))}, now() + interval '1 hour')`;
		const fakeDriver = realCodexE2e
			? undefined
			: await FakeRuntimeDriver.open(join(directory, "driver.json"));
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
								credential: "worker-controlled-model-credential",
							},
						],
						authorizeExternalAction: async () => undefined,
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
		});
		const app = createRuntimeHostApp({
			host,
			runtimeWorkerId: signing.workerId,
			readinessWorkerId: signing.workerId,
			serviceToken: "synthetic-runtime-token",
			verifyGrant: () => {
				throw Error("V1 disabled");
			},
			verifyGrantV2: createRuntimeExecutionGrantVerifierV2(
				new Map([[signing.keyId, keys.publicKey]]),
			),
		});
		let ackCount = 0;
		runtimeServer = createServer(async (req, res) => {
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
				executionId: parsed.executionId,
				deliveryFence: parsed.operation?.executionDeliveryFence,
				confirmedCursor: parsed.confirmedCursor,
			};
			requests.push(observedRequest);
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
			res.writeHead(response.status, Object.fromEntries(response.headers));
			if (response.body) {
				const stream = Readable.fromWeb(response.body as never);
				res.on("close", () => stream.destroy());
				stream.pipe(res);
			} else res.end();
		});
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
		const runtimeUrl = `http://127.0.0.1:${runtimeAddress.port}`;
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
			cwd: resolve(import.meta.dirname, ".."),
			timeout: 30_000,
		});
		moduleDirectory = await mkdtemp(
			join(resolve(import.meta.dirname, "../dist"), "cli-test-"),
		);
		await copyFile(
			resolve(import.meta.dirname, "../dist/deployment.mjs"),
			join(moduleDirectory, "deployment.mjs"),
		);
		const configSource = `import { readFile } from 'node:fs/promises'; import { createPrivateKey } from 'node:crypto';
export const signing = { ...${JSON.stringify(signing)}, privateKey: createPrivateKey(await readFile(${JSON.stringify(join(directory, "signing.pem"))})) };
export const serviceToken = 'synthetic-runtime-token';
export const directory = { async resolveUser(userId) { if (userId !== 'user-cli') return null; return { schemaVersion: 1, userId, accountStatus:'active',organizationIds:[],authorizationRevision:'identity-1'}; } };
export const workloadInput = { databaseUrl: ${JSON.stringify(database.databaseUrl)}, policy: ${JSON.stringify(policy)},
kubernetes: { mode:'kubeconfig', path:${JSON.stringify(kubePath)}, context:'test', expectedServer:${JSON.stringify(kubeUrl)} },
registry: { endpoint:'https://registry.example.test', imageReferencePrefix:'registry.example.test', policy:{authorize:async()=>({status:'rejected'})} },
admissionPolicyRef:'policy',registrySubjectRef:'worker', templateModelBindings:[], executionCapacityProfiles:[${JSON.stringify(capacity)}],
keyring: { keys:[{keyVersion:'key',privateKeyPkcs8DerBase64:(await readFile(${JSON.stringify(join(directory, "wrapping.der"))})).toString('base64')}] },
modelCatalog:{load:async()=>({})}, runtimeFetch: (url, init)=> fetch(${JSON.stringify(runtimeUrl)} + new URL(url).pathname,init), pollIntervalMs:100 };
`;
		await writeFile(join(moduleDirectory, "configuration.mjs"), configSource, {
			mode: 0o600,
		});
		const start = () => {
			const child = spawn(
				process.execPath,
				[resolve(import.meta.dirname, "../dist/index.mjs")],
				{
					env: {
						...process.env,
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
		const first = await admit("first");
		const second = await admit("second");

		// A database failure must not acknowledge a Runtime event that did not commit.
		await sql.unsafe("create sequence platform.test_event_attempts");
		await sql.unsafe(
			"create function platform.test_event_failure() returns trigger language plpgsql as $$ begin if nextval('platform.test_event_attempts') = 1 then raise exception 'injected event transaction failure'; end if; return new; end $$",
		);
		await sql.unsafe(
			"create trigger test_event_failure before insert on platform.conversation_events for each row execute function platform.test_event_failure()",
		);
		start();
		start();
		await waitUntil(
			async () => (await dispatchCount()) === 1,
			"single effective first dispatch",
		);
		if (realCodexE2e) {
			expect(modelRequests[0]?.authenticated).toBe(true);
			expect(modelRequests[0]?.body).toContain("controlled dispatch");
		}
		expect(children.every((child) => child.exitCode === null)).toBe(true);
		await waitUntil(
			async () =>
				(await sql`select is_called from platform.test_event_attempts`)[0]
					?.is_called === true,
			"injected event transaction failure",
		);
		expect(await sql`select 1 from platform.conversation_events`).toHaveLength(
			0,
		);
		expect(ackCount).toBe(0);
		await sql.unsafe(
			"drop trigger test_event_failure on platform.conversation_events",
		);

		await waitUntil(
			async () =>
				(
					await sql`select 1 from platform.conversation_events where execution_id=${first.executionId} or execution_id=${second.executionId}`
				).length === 1,
			"persisted running event",
		);
		const [active] =
			await sql`select execution_id, conversation_id from platform.conversation_executions where status='processing'`;
		if (!active) throw Error("No running execution");
		expect(await dispatchCount()).toBe(1);
		if (realCodexE2e) {
			await waitUntil(async () => {
				const facts = await sql<{ phase: string }[]>`
						select event_payload->'fact'->>'phase' as phase
						from platform.conversation_events
						where execution_id=${active.execution_id}
						  and event_type='execution.operation'
					`;
				const phases = new Set(facts.map((fact) => fact.phase));
				return phases.has("intent") && phases.has("started");
			}, "persisted Codex model operation start facts");
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
					phase: string;
					kind: string;
					modelOptionId: string | null;
				}[]
			>`
				select event_payload->'fact'->>'phase' as phase,
				       event_payload->'fact'->>'kind' as kind,
				       event_payload->'fact'->'model'->>'modelOptionId' as "modelOptionId"
				from platform.conversation_events
				where execution_id=${active.execution_id}
				  and event_type='execution.operation'
				order by sequence
			`;
			expect(operationFacts.map((fact) => fact.phase)).toEqual(
				expect.arrayContaining(["intent", "started", "completed"]),
			);
			expect(operationFacts.every((fact) => fact.kind === "model")).toBe(true);
			expect(
				operationFacts.every(
					(fact) => fact.modelOptionId === "worker-controlled-model",
				),
			).toBe(true);
			const operationAudits = await sql`
				select id
				from platform.audit_events
				where target_id=${active.execution_id}
				  and action='execution.operation.observed'
			`;
			expect(operationAudits.length).toBeGreaterThanOrEqual(3);
		}
		// Kill both process owners, expire only this test's owned lease, and recover
		// through automatic discovery. The Execution and Host session remain the same while the lease fence advances.
		await waitUntil(async () => ackCount > 0, "committed event acknowledged");
		const [before] =
			await sql`select delivery_fence::int as fence, host_session_ref from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id=${active.execution_id}`;
		const priorRequests = requests.length;
		for (const child of children) child.kill("SIGKILL");
		await Promise.all(children.map((child) => once(child, "exit")));
		await sql`update platform.outbox_items set lease_expires_at=now()-interval '1 second' where payload->>'executionId'=${active.execution_id} and status='processing'`;
		start();
		start();
		await waitUntil(
			async () =>
				requests
					.slice(priorRequests)
					.some(
						(request) =>
							request.path.endsWith("/status") &&
							request.executionId === active.execution_id,
					),
			"takeover queries original Runtime execution",
		);
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
		expect(await dispatchCount()).toBe(1);
		expect(
			requests.filter((request) => request.path.endsWith("/turns")),
		).toHaveLength(1);
		const [after] =
			await sql`select delivery_fence::int as fence, host_session_ref from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id=${active.execution_id}`;
		expect(after?.host_session_ref).toBe(before?.host_session_ref);
		expect(after?.fence).toBeGreaterThan(before?.fence);
		expect(
			requests
				.slice(priorRequests)
				.filter((request) => request.executionId === active.execution_id)
				.every((request) => request.deliveryFence === after?.fence),
		).toBe(true);
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
		throw new Error(
			JSON.stringify({
				traces: traces.slice(-30),
				processes: children.map((child) => ({
					exitCode: child.exitCode,
					signalCode: child.signalCode,
				})),
				audit:
					await sql`select event_type, payload->>'errorCode' as error_code from platform.persisted_events`,
				execution:
					await sql`select execution_id,status from platform.conversation_executions`,
			}),
			{ cause: error },
		);
	} finally {
		releaseModelResponse?.();
		for (const child of children)
			if (child.exitCode === null) child.kill("SIGKILL");
		await Promise.all(
			children.map((child) =>
				child.exitCode !== null || child.signalCode
					? Promise.resolve()
					: once(child, "exit"),
			),
		);
		await Promise.all([
			execution?.close(),
			authorization?.close(),
			sql.end({ timeout: 0 }),
		]);
		await host?.close();
		modelServer?.closeAllConnections();
		runtimeServer?.closeAllConnections();
		kube.closeAllConnections();
		await Promise.all([
			runtimeServer
				? new Promise<void>((done) => runtimeServer?.close(() => done()))
				: undefined,
			new Promise<void>((done) => kube.close(() => done())),
			modelServer
				? new Promise<void>((done) => modelServer?.close(() => done()))
				: undefined,
		]);
		await database.stop();
		if (moduleDirectory)
			await rm(moduleDirectory, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
}, 120_000);
