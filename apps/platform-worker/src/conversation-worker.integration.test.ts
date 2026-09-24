import {
	type ChildProcess,
	execFile as execFileCallback,
	spawn,
} from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	createRuntimeExecutionGrantVerifierV2,
	createWorkloadReadinessVerifierV1,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import { createConversationExecutionUseCaseV1 } from "@agent-infra/platform-core";
import {
	PostgresConversationExecutionTransactionV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import { KubeConfig } from "@kubernetes/client-node";
import postgres from "postgres";
import { expect, it } from "vitest";
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
async function waitUntil(check: () => Promise<boolean>, label: string) {
	for (let attempt = 0; attempt < 150; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw Error(`Timed out: ${label}`);
}

// Real PostgreSQL and the packaged production module/CLI, with controlled Kubernetes
// and Runtime HTTP. This is not real model, identity-provider or Connection acceptance.
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
		const desired = workloadDesiredFixture(1, "agent-cli", "internal-only");
		const adapter = createKubernetesRuntimeAdapterV1({
			client: fake.client,
			policy,
			probe: async () => true,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending")
			throw Error("Expected controlled Workload identity");
		await adapter.promote(desired, identity);
		const configuration = {
			schemaVersion: 2,
			agentId: desired.agentId,
			revision: 1,
			source: {
				kind: "custom",
				imageDigest: desired.imageDigest,
				admissionRevision: "admitted",
				interactionMode: "platform-adapter",
				connectionEnabled: false,
			},
			modelConfiguration: null,
			environment: [],
			secrets: [],
			channels: [],
			channelRevision: "channels-1",
		};
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
		await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at, configuration) values (${desired.agentId}, 1, 'admitted', now(), ${sql.json(configuration)})`;
		await sql`insert into platform.workload_reconciliations (agent_id, revision, state, next_attempt_at) values (${desired.agentId}, 1, ${sql.json(state)}, now() + interval '1 hour')`;
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
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
			"create function platform.test_event_failure() returns trigger language plpgsql as $$ begin perform nextval('platform.test_event_attempts'); raise exception 'injected event transaction failure'; end $$",
		);
		await sql.unsafe(
			"create trigger test_event_failure before insert on platform.conversation_events for each row execute function platform.test_event_failure()",
		);
		start();
		start();
		await waitUntil(
			async () => (await driver.sideEffectCount()) === 1,
			"single effective first dispatch",
		);
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
		expect(await driver.sideEffectCount()).toBe(1);
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
		expect(await driver.sideEffectCount()).toBe(1);
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
		runtimeServer?.closeAllConnections();
		kube.closeAllConnections();
		await Promise.all([
			runtimeServer
				? new Promise<void>((done) => runtimeServer?.close(() => done()))
				: undefined,
			new Promise<void>((done) => kube.close(() => done())),
		]);
		await database.stop();
		if (moduleDirectory)
			await rm(moduleDirectory, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
}, 120_000);
