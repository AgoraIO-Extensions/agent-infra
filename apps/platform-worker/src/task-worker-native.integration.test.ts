import {
	type ChildProcess,
	execFile as execFileCallback,
	spawn,
} from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	TaskAcceptedV1Schema,
	TaskProjectionV1Schema,
	TaskSseMessageV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	projectRuntimeModelConfigurationV1,
	runtimeModelInjectionV1,
} from "@agent-infra/model-catalog";
import {
	type AgentConfigurationRecordV2,
	platformIdempotencyV1,
} from "@agent-infra/platform-core";
import { KubeConfig } from "@kubernetes/client-node";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import { setProductionDeploymentInput } from "../../../tests/fixtures/platform-api-production-deployment.js";
import type { ProductionPlatformApiInputV1 } from "../../platform-api/src/deployment.js";
import type {
	IdentityAdapter,
	IdentityContext,
} from "../../platform-api/src/http/identity.js";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "../../platform-api/src/index.js";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "../../..");
const enabled = process.env.AGENT_INFRA_TASK_NATIVE_TEST === "1";
async function waitUntil(check: () => Promise<boolean>, label: string) {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (await check()) return;
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error(`Timed out: ${label}`);
}
async function replayWebEvents(
	response: Response,
	eventIds: readonly string[],
	executionIds: string | readonly string[],
) {
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("TASK_NATIVE_WEB_SSE_BODY_REQUIRED");
	const remaining = new Set(eventIds);
	const messages: ReturnType<typeof TaskSseMessageV1Schema.parse>[] = [];
	let buffer = "";
	const decoder = new TextDecoder();
	try {
		while (remaining.size > 0) {
			const next = await reader.read();
			if (next.done) throw new Error("TASK_NATIVE_WEB_SSE_INCOMPLETE");
			buffer += decoder.decode(next.value, { stream: true });
			let end = buffer.indexOf("\n\n");
			while (end !== -1) {
				const data = buffer
					.slice(0, end)
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data: "))
					.map((line) => line.slice(6))
					.join("\n");
				buffer = buffer.slice(end + 2);
				if (data) {
					const message = TaskSseMessageV1Schema.parse(JSON.parse(data));
					messages.push(message);
					if (message.kind === "event") {
						expect(message.schemaVersion).toBe(1);
						expect(eventIds.includes(message.eventId)).toBe(true);
						expect(
							(typeof executionIds === "string"
								? [executionIds]
								: executionIds
							).includes(message.executionId),
						).toBe(true);
						remaining.delete(message.eventId);
					}
				}
				end = buffer.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel();
	}
	const deliveredIds = messages
		.filter((message) => message.kind === "event")
		.map((message) => (message.kind === "event" ? message.eventId : ""));
	expect(new Set(deliveredIds).size).toBe(deliveredIds.length);
	expect(deliveredIds).toHaveLength(eventIds.length);
}
const user: IdentityContext = {
	schemaVersion: 1,
	userId: "user-cli",
	displayName: "Synthetic owner",
	accountStatus: "active",
	organizationIds: [],
	roles: ["employee", "system_admin"],
	authorizationRevision: "identity-1",
};
const admin: IdentityContext = {
	...user,
	userId: "admin-cli",
	displayName: "Synthetic administrator",
};
const directory: IdentityAdapter = {
	async resolve(request) {
		return request.headers.get("cookie") === "synthetic-owner-session"
			? user
			: request.headers.get("cookie") === "synthetic-admin-session"
				? admin
				: null;
	},
	async resolveUser(id) {
		return id === user.userId
			? {
					schemaVersion: 1,
					userId: id,
					accountStatus: user.accountStatus,
					organizationIds: [],
					authorizationRevision: user.authorizationRevision,
				}
			: null;
	},
	async hydrateUsers(ids) {
		return ids.map((userId) => ({
			userId,
			displayName: "Synthetic owner",
			roles: ["employee"],
		}));
	},
};

// Explicit activation is mandatory in the native CI job. Missing/wrong images or
// broken launchers fail that job. This does not prove production IdP/registry/Kubernetes admission.
it.skipIf(!enabled)(
	"executes user and application HTTP tasks through packaged Workers and image Codex",
	async () => {
		const image = process.env.AGENT_INFRA_TASK_NATIVE_IMAGE;
		const revision = process.env.AGENT_INFRA_TASK_NATIVE_IMAGE_REVISION;
		const sourceTree = process.env.AGENT_INFRA_TASK_NATIVE_SOURCE_TREE;
		if (
			!image ||
			!revision ||
			!sourceTree ||
			!/^[a-f0-9]{40}$/.test(revision) ||
			!/^[a-f0-9]{40}$/.test(sourceTree)
		)
			throw new Error("TASK_NATIVE_IMAGE_IDENTITY_REQUIRED");
		const { stdout: inspected } = await execFile("docker", [
			"image",
			"inspect",
			image,
			"--format",
			"{{json .}}",
		]);
		const imageMetadata = JSON.parse(inspected);
		const repositoryDigests = [
			...new Set<string>(
				(imageMetadata.RepoDigests ?? []).map((value: string) =>
					value.slice(value.lastIndexOf("@") + 1),
				),
			),
		];
		const imageDigest: string =
			imageMetadata.Descriptor?.digest ??
			(repositoryDigests.length === 1 ? repositoryDigests[0] : undefined);
		const imageDigestSource = imageMetadata.Descriptor?.digest
			? "oci-descriptor"
			: "repository-digest";
		if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest))
			throw new Error("TASK_NATIVE_OCI_DESCRIPTOR_REQUIRED");
		expect(
			imageMetadata.Config.Labels["org.opencontainers.image.revision"],
		).toBe(revision);
		const { stdout: tree } = await execFile(
			"git",
			["rev-parse", `${revision}^{tree}`],
			{ cwd: root },
		);
		expect(tree.trim()).toBe(sourceTree);
		const { stdout: head } = await execFile("git", ["rev-parse", "HEAD"], {
			cwd: root,
		});
		// Exercise the actual kernel rule used by Codex; a version string cannot
		// prove enforcement, and an unsupported sandbox must not become a skip.
		try {
			await execFile(
				"docker",
				[
					"run",
					"--rm",
					"--read-only",
					"--network",
					"none",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--entrypoint",
					"/bin/setpriv",
					imageMetadata.Id,
					"--no-new-privs",
					"--landlock-access",
					"fs:ioctl-dev",
					"--",
					"/bin/true",
				],
				{ timeout: 30_000 },
			);
		} catch {
			throw new Error("TASK_NATIVE_LANDLOCK_V5_REQUIRED");
		}
		const directoryPath = await mkdtemp(join(tmpdir(), "task-native-482-"));
		const database = await startPostgresTestDatabase("482-task-native");
		const sql = postgres(database.databaseUrl, { max: 2 });
		let upgradeDatabase:
			| Awaited<ReturnType<typeof startPostgresTestDatabase>>
			| undefined;
		let upgradeSql: ReturnType<typeof postgres> | undefined;
		const children: ChildProcess[] = [];
		const traces: string[] = [];
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
		const containerName = `agent-infra-task-native-${randomUUID()}`;
		const requests: {
			path: string;
			executionId?: string;
			deliveryFence?: number;
			responseStatus?: number;
			responseCode?: string;
			originalOperationDigest?: string;
			hostSessionRef?: string | null;
			responseHostSessionRef?: string;
			inputDigest?: string;
			responseOutcome?: string;
			responseRuntimeStatus?: string;
			responseLost?: boolean;
		}[] = [];
		let ackCount = 0;
		let runtimeOrigin = "";
		let controlOrigin = "";
		let moduleDirectory: string | undefined;
		let running:
			| Awaited<ReturnType<typeof startPlatformApiFromDeployment>>
			| undefined;
		let apiOrigin = "";
		let outputBytes = 0;
		let unsafeOutput = false;
		let uncertaintyIds: string[] = [];
		let responseLoss:
			| { inputDigest: string; executionId?: string; dropped: number }
			| undefined;
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

		const runtimeServer = createServer(async (req, res) => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = Buffer.concat(chunks).toString();
			const parsed = body ? JSON.parse(body) : {};
			const observed = {
				path: req.url ?? "",
				executionId: parsed.executionId,
				deliveryFence: parsed.operation?.executionDeliveryFence,
				originalOperationDigest: parsed.originalOperationDigest,
				hostSessionRef: parsed.hostSessionRef,
				inputDigest:
					typeof parsed.input?.text === "string"
						? createHash("sha256").update(parsed.input.text).digest("hex")
						: undefined,
				responseStatus: 0,
				responseCode: undefined as string | undefined,
				responseHostSessionRef: undefined as string | undefined,
				responseOutcome: undefined as string | undefined,
				responseRuntimeStatus: undefined as string | undefined,
				responseLost: false,
			};
			requests.push(observed);
			if (
				responseLoss &&
				req.url?.endsWith("/turns") &&
				observed.inputDigest === responseLoss.inputDigest
			)
				responseLoss.executionId = parsed.executionId;
			const abort = new AbortController();
			res.on("close", () => abort.abort());
			try {
				const response = await fetch(`${runtimeOrigin}${req.url}`, {
					method: req.method,
					signal: abort.signal,
					headers: req.headers as Record<string, string>,
					...(body ? { body } : {}),
				});
				observed.responseStatus = response.status;
				if (
					response.ok &&
					["/turns", "/status"].some((path) => req.url?.endsWith(path))
				) {
					const outcome = (await response.clone().json()) as {
						hostSessionRef?: unknown;
						result?: { outcome?: unknown; status?: unknown };
						outcome?: unknown;
						status?: unknown;
					};
					if (typeof outcome.hostSessionRef === "string")
						observed.responseHostSessionRef = outcome.hostSessionRef;
					const resultOutcome = outcome.result?.outcome ?? outcome.outcome;
					if (
						typeof resultOutcome === "string" &&
						/^(accepted|found|not_found|recovery_failed|unknown|busy|rejected)$/.test(
							resultOutcome,
						)
					)
						observed.responseOutcome = resultOutcome;
					const runtimeStatus = outcome.result?.status ?? outcome.status;
					if (
						typeof runtimeStatus === "string" &&
						/^(running|idle|completed|cancelled|failed|unknown|unavailable)$/.test(
							runtimeStatus,
						)
					)
						observed.responseRuntimeStatus = runtimeStatus;
				}
				if (!response.ok) {
					const detail = (await response
						.clone()
						.json()
						.catch(() => ({}))) as { code?: unknown };
					if (
						typeof detail.code === "string" &&
						/^[A-Z_]+$/.test(detail.code)
					) {
						observed.responseCode = detail.code;
						traces.push(`runtime-code:${detail.code}`);
					}
				}
				if (req.url?.endsWith("/ack") && response.ok) ackCount++;
				traces.push(`runtime:${req.url}:${response.status}`);
				if (
					responseLoss &&
					responseLoss.executionId === parsed.executionId &&
					["/turns", "/status", "/events"].some((path) =>
						req.url?.endsWith(path),
					)
				) {
					responseLoss.dropped++;
					observed.responseLost = true;
					res.destroy();
					await response.body?.cancel();
					return;
				}
				res.writeHead(response.status, Object.fromEntries(response.headers));
				if (response.body) {
					const stream = Readable.fromWeb(response.body as never);
					res.on("close", () => stream.destroy());
					stream.pipe(res);
				} else res.end();
			} catch {
				if (!res.destroyed) res.writeHead(502).end();
			}
		});
		try {
			await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
			const baseDesired = workloadDesiredFixture(
				1,
				"agent-cli",
				"internal-only",
			);
			const modelSecret = {
				schemaVersion: 1 as const,
				algorithmVersion: "aes-256-gcm:v1" as const,
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
				agentId: baseDesired.agentId,
				ownerType: "agent-owner" as const,
				ownerId: user.userId,
				secretId: "synthetic-model-secret",
				secretVersion: 1,
				configRevision: 1,
				wrappingKeyVersion: "key",
				name: "synthetic-model-secret-v1-r1",
			};
			const desired = {
				...baseDesired,
				imageDigest,
				registryAdmission: {
					...baseDesired.registryAdmission,
					immutableDigest: imageDigest,
					policyEvidence: {
						...baseDesired.registryAdmission.policyEvidence,
						imageDigest,
					},
				},
				secretRefs: [modelSecret],
			};
			const configuration: AgentConfigurationRecordV2 = {
				schemaVersion: 2,
				agentId: desired.agentId,
				revision: 1,
				source: {
					kind: "standard",
					templateId: "codex",
					imageDigest: desired.imageDigest,
					admissionRevision: "admitted",
					allowedEnvironmentKeys: [],
					allowedSecretKeys: [],
					platformManagedKeys: [],
					connectionEnabled: false,
				},
				modelConfiguration: {
					catalogRevision: "native-catalog",
					options: [
						{
							optionId: "native-option",
							endpointId: "native-endpoint",
							modelId: "gpt-5.6-sol",
							reasoningLevels: ["medium"],
							credential: {
								secretId: modelSecret.secretId,
								version: 1,
								isSet: true,
							},
						},
					],
					defaultOptionId: "native-option",
					defaultReasoningLevel: "medium",
				},
				environment: [],
				secrets: [],
				channels: [],
				channelRevision: "channels-1",
			};
			const endpoint = {
				endpointId: "native-endpoint",
				baseUrl: "http://127.0.0.1:3005/v1",
				origin: "http://127.0.0.1:3005",
				protocol: "openai-responses-v1" as const,
				security: {
					tls: "loopback-http" as const,
					redirects: "reject" as const,
				},
				capabilities: {
					streaming: true as const,
					tools: true as const,
					reasoningLevels: ["medium"],
				},
				allowedModels: ["gpt-5.6-sol"],
				available: true,
			};
			const secretKey = `MODEL_CREDENTIAL_${createHash("sha256").update("model:native-option").digest("hex").toUpperCase()}`;
			const modelProjection = await projectRuntimeModelConfigurationV1({
				configuration,
				protocol: "openai-responses-v1",
				catalog: { resolve: async () => endpoint },
				access: { validate: async () => {} },
				signal: AbortSignal.timeout(1000),
				credentialFor: async () => ({
					reference: {
						secretId: modelSecret.secretId,
						secretVersion: modelSecret.secretVersion,
						configRevision: modelSecret.configRevision,
						name: modelSecret.name,
					},
					key: secretKey,
					plaintext: new TextEncoder().encode("synthetic-native-model"),
				}),
			});
			const adapter = createKubernetesRuntimeAdapterV1({
				client: fake.client,
				policy,
				modelProjection,
				probe: async () => true,
			});
			const secretUid = await adapter.applyImmutableSecret(
				desired,
				modelSecret.name,
				secretKey,
				new TextEncoder().encode("synthetic-native-model"),
			);
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending")
				throw new Error("Expected controlled Workload identity");
			await adapter.bindSecretFence(
				desired,
				identity,
				modelSecret.name,
				1,
				secretUid,
			);
			await adapter.promote(desired, identity);
			const modelInjection = runtimeModelInjectionV1(modelProjection);
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
				modelProjection,
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
					modelSelection: true,
					attachments: false,
					resultFiles: false,
					supplementaryInstruction: false,
					connection: false,
				},
			};
			await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision) values (${desired.agentId}, 1, 'authority-1')`;
			await sql`insert into platform.agent_applications (id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at, management_revision, approval_revision, desired_state, service_availability, workload_revision, fence) values ('application-cli', ${desired.agentId}, 'user-cli', 'Controlled Agent', 'Fixture', 'available', 'trace', 'request', now(), 1, 1, 'running', 'ready', 1, 1)`;
			await sql`insert into platform.agent_owners (agent_id, owner_id, created_at) values (${desired.agentId}, 'user-cli', now())`;
			await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at, configuration) values (${desired.agentId}, 1, 'codex', now(), ${sql.json(JSON.parse(JSON.stringify(configuration)))})`;
			await sql`insert into platform.workload_reconciliations (agent_id, revision, state, next_attempt_at) values (${desired.agentId}, 1, ${sql.json(JSON.parse(JSON.stringify(state)))}, now() + interval '1 hour')`;

			const nativeConfiguration = {
				agentId: desired.agentId,
				workerId: signing.workerId,
				issuer: signing.issuer,
				keyId: signing.keyId,
				publicKey: policy.runtimeAuth.grantPublicKey,
				modelConfiguration: JSON.parse(modelInjection.configuration),
				readinessBinding: {
					workerId: signing.workerId,
					agentId: desired.agentId,
					workloadRevision: 1,
					fence: 1,
					imageDigest: desired.imageDigest,
				},
			};
			await execFile("docker", [
				"run",
				"--detach",
				"--init",
				"--name",
				containerName,
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,mode=1777",
				"--tmpfs",
				"/var/lib/agent-runtime:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700",
				"--publish",
				"127.0.0.1::3003",
				"--publish",
				"127.0.0.1::3004",
				"--env",
				`TASK_NATIVE_CONFIGURATION=${JSON.stringify(nativeConfiguration)}`,
				"--entrypoint",
				"node",
				imageMetadata.Id,
				"--input-type=module",
				"--eval",
				await readFile(
					join(root, "tests/support/task-worker-native-runtime.mjs"),
					"utf8",
				),
			]);
			const { stdout: ports } = await execFile("docker", [
				"inspect",
				containerName,
				"--format",
				"{{json .NetworkSettings.Ports}}",
			]);
			const portMap = JSON.parse(ports);
			runtimeOrigin = `http://127.0.0.1:${portMap["3003/tcp"][0].HostPort}`;
			controlOrigin = `http://127.0.0.1:${portMap["3004/tcp"][0].HostPort}`;
			async function control(path = "/stats") {
				const response = await fetch(`${controlOrigin}${path}`, {
					method: path === "/stats" ? "GET" : "POST",
					signal: AbortSignal.timeout(path === "/restart" ? 15_000 : 2000),
				});
				if (!response.ok) throw new Error("TASK_NATIVE_CONTROL_UNAVAILABLE");
				return (await response.json()) as {
					requests: number;
					pending: number;
					closed: number;
					ready: boolean;
					exitCode: number | null;
					startupCode?: string;
				};
			}
			await waitUntil(async () => {
				let status: Awaited<ReturnType<typeof control>>;
				try {
					status = await control();
				} catch {
					return false;
				}
				if (status.exitCode !== null || status.startupCode)
					throw new Error(
						`TASK_NATIVE_HOST_FAILED:${status.startupCode ?? status.exitCode}`,
					);
				return status.ready;
			}, "protected image Host startup");
			kube.listen(0, "127.0.0.1");
			runtimeServer.listen(0, "127.0.0.1");
			await Promise.all([
				once(kube, "listening"),
				once(runtimeServer, "listening"),
			]);
			const kubeUrl = `http://127.0.0.1:${(kube.address() as AddressInfo).port}`;
			const runtimeUrl = `http://127.0.0.1:${(runtimeServer.address() as AddressInfo).port}`;
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
			const kubePath = join(directoryPath, "kubeconfig");
			await writeFile(kubePath, config.exportConfig(), { mode: 0o600 });
			await writeFile(
				join(directoryPath, "signing.pem"),
				keys.privateKey.export({ type: "pkcs8", format: "pem" }),
				{ mode: 0o600 },
			);
			await writeFile(
				join(directoryPath, "wrapping.der"),
				wrapping.privateKey.export({ type: "pkcs8", format: "der" }),
				{ mode: 0o600 },
			);
			// The build publishes the real deployment module without the mounted configuration.
			await execFile(
				"pnpm",
				["--filter", "@agent-infra/platform-worker...", "build"],
				{
					cwd: root,
					timeout: 60_000,
				},
			);
			moduleDirectory = await mkdtemp(
				join(resolve(import.meta.dirname, "../dist"), "cli-test-"),
			);
			await copyFile(
				resolve(import.meta.dirname, "../dist/deployment.mjs"),
				join(moduleDirectory, "deployment.mjs"),
			);
			const configSource = `import { readFile } from 'node:fs/promises'; import { createPrivateKey } from 'node:crypto';
export const signing = { ...${JSON.stringify(signing)}, privateKey: createPrivateKey(await readFile(${JSON.stringify(join(directoryPath, "signing.pem"))})) };
export const serviceToken = 'synthetic-runtime-token';
export const directory = { async resolveUser(userId) { if (userId !== 'user-cli') return null; return { schemaVersion: 1, userId, accountStatus:'active',organizationIds:[],authorizationRevision:'identity-1'}; } };
export const workloadInput = { databaseUrl: ${JSON.stringify(database.databaseUrl)}, policy: ${JSON.stringify(policy)},
kubernetes: { mode:'kubeconfig', path:${JSON.stringify(kubePath)}, context:'test', expectedServer:${JSON.stringify(kubeUrl)} },
registry: { endpoint:'https://registry.example.test', imageReferencePrefix:'registry.example.test', policy:{authorize:async()=>({status:'rejected'})} },
admissionPolicyRef:'policy',registrySubjectRef:'worker', templateModelBindings:[{templateId:"codex",imageDigest:${JSON.stringify(desired.imageDigest)},protocol:"openai-responses-v1"}], executionCapacityProfiles:[${JSON.stringify(capacity)}],
keyring: { keys:[{keyVersion:'key',privateKeyPkcs8DerBase64:(await readFile(${JSON.stringify(join(directoryPath, "wrapping.der"))})).toString('base64')}] },
modelCatalog:{load:async()=>({})}, runtimeFetch: (url, init)=> fetch(${JSON.stringify(runtimeUrl)} + new URL(url).pathname,init), pollIntervalMs:100 };
`;
			await writeFile(
				join(moduleDirectory, "configuration.mjs"),
				configSource,
				{
					mode: 0o600,
				},
			);
			const start = () => {
				const child = spawn(
					process.execPath,
					[resolve(import.meta.dirname, "../dist/index.mjs")],
					{
						env: {
							PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
							PLATFORM_WORKER_DEPLOYMENT_MODULE: pathToFileURL(
								join(moduleDirectory ?? "", "deployment.mjs"),
							).href,
						},
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				const observeOutput = (data: Buffer) => {
					outputBytes += data.byteLength;
					if (data.includes("PRIVATE KEY") || data.includes("Bearer "))
						unsafeOutput = true;
				};
				child.stdout?.on("data", observeOutput);
				child.stderr?.on("data", observeOutput);
				children.push(child);
				return child;
			};

			const der = wrapping.publicKey.export({ type: "spki", format: "der" });
			const input: ProductionPlatformApiInputV1 = {
				databaseUrl: database.databaseUrl,
				imageRepository: policy.imageRepository,
				identity: directory,
				loadAuthorityContext: async () => ({
					schemaVersion: 1,
					users: [{ userId: user.userId, accountStatus: "active" }],
					organizationIds: [],
				}),
				registry: {
					endpoint: "https://registry.example.test",
					imageReferencePrefix: "registry.example.test",
					admissionPolicyRef: "synthetic-policy",
					policy: { authorize: async () => ({ status: "rejected" }) },
				},
				templates: [],
				modelCatalog: { revision: "synthetic-catalog", load: async () => ({}) },
				channelPolicy: { revision: "synthetic-channels", bindings: [] },
				encryptionKeys: {
					schemaVersion: 1,
					activeWrappingKeyVersion: "key",
					keys: [
						{
							schemaVersion: 1,
							keyVersion: "key",
							wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
							publicKeySpkiDerBase64: der.toString("base64"),
							publicKeyFingerprint: createHash("sha256")
								.update(der)
								.digest("hex"),
							rsaModulusBits: 3072,
							status: "active",
						},
					],
				},
				resourceProfile: {
					profileId: "standard",
					displayName: "Synthetic",
					estimatedResources: {
						cpuMillicores: 100,
						memoryMiB: 128,
						storageGiB: 1,
					},
				},
			};
			setProductionDeploymentInput(input);
			const taskWaitingTimeoutMs = 30_000;
			const apiDeployment = join(directoryPath, "api-deployment.mjs");
			await writeFile(
				apiDeployment,
				`import { createPlatformApiAssemblyInput as production } from ${JSON.stringify(new URL("../../../tests/fixtures/platform-api-production-deployment.ts", import.meta.url).href)};
export function createPlatformApiAssemblyInput() { return { ...production(), taskAdmissionPolicy: { maximumWaitingTasksPerAgent: 3, waitingTimeoutMs: ${taskWaitingTimeoutMs} } }; }
`,
				{ mode: 0o600 },
			);
			running = await startPlatformApiFromDeployment({
				moduleSpecifier: pathToFileURL(apiDeployment).href,
				port: 0,
				log: () => {},
			});
			apiOrigin = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
			const management = (
				path: string,
				body?: unknown,
				method = "POST",
				session = "synthetic-owner-session",
			) =>
				fetch(`${apiOrigin}/api/v1${path}`, {
					method,
					headers: {
						cookie: session,
						"content-type": "application/json",
					},
					...(body ? { body: JSON.stringify(body) } : {}),
				});
			async function checkedJson<T>(
				response: Response,
				expected: number,
			): Promise<T> {
				if (response.status !== expected) {
					const error = (await response.json().catch(() => ({}))) as {
						code?: unknown;
					};
					throw new Error(
						`TASK_NATIVE_HTTP:${response.status}:${typeof error.code === "string" ? error.code : "unknown"}`,
					);
				}
				return (await response.json()) as T;
			}
			type Issued = { credential: string; metadata: { credentialId: string } };
			const issue = {
				schemaVersion: 1,
				scopes: ["agent:use"],
				expiresAt: null,
			};
			const userCredential = await checkedJson<Issued>(
				await management("/api-credentials", issue),
				201,
			);
			const application = await checkedJson<{ applicationId: string }>(
				await management("/applications", {
					schemaVersion: 1,
					name: "Synthetic native caller",
				}),
				201,
			);
			expect(
				(
					await management(
						`/applications/${application.applicationId}/credential-delivery`,
						{ kind: "user", id: user.userId },
						"POST",
						"synthetic-admin-session",
					)
				).status,
			).toBe(204);
			const applicationCredential = await checkedJson<Issued>(
				await management(
					`/applications/${application.applicationId}/credentials`,
					issue,
				),
				201,
			);
			expect(typeof userCredential.credential).toBe("string");
			expect(typeof applicationCredential.credential).toBe("string");
			await checkedJson(
				await management(`/agents/${desired.agentId}/grants`, {
					schemaVersion: 1,
					principal: { kind: "user", id: user.userId },
					grantType: "use",
				}),
				200,
			);
			await checkedJson(
				await management(`/agents/${desired.agentId}/grants`, {
					schemaVersion: 1,
					principal: { kind: "application", id: application.applicationId },
					grantType: "use",
				}),
				200,
			);
			const taskRequest = (
				path: string,
				credential: string,
				body?: unknown,
				key = "task-native",
				signal?: AbortSignal,
			) =>
				fetch(`${apiOrigin}/api/v1${path}`, {
					method: body === undefined ? "GET" : "POST",
					headers: {
						authorization: `Bearer ${credential}`,
						"content-type": "application/json",
						"Idempotency-Key": key,
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					signal,
				});
			const taskPath = (task: {
				conversationId: string;
				executionId: string;
			}) => `/conversations/${task.conversationId}/tasks/${task.executionId}`;
			async function submit(
				credential: string,
				key: string,
				conversationId?: string,
				text = "synthetic native input",
			) {
				return TaskAcceptedV1Schema.parse(
					await checkedJson(
						await taskRequest(
							`/agents/${desired.agentId}/tasks`,
							credential,
							{
								schemaVersion: 1,
								text,
								...(conversationId ? { conversationId } : {}),
							},
							key,
						),
						202,
					),
				);
			}
			async function completed(executionId: string) {
				await waitUntil(
					async () =>
						(
							await sql`select 1 from platform.conversation_executions where execution_id=${executionId} and status='completed'`
						).length === 1,
					"native execution completed",
				);
			}
			start();
			const first = await submit(userCredential.credential, "user-native");
			const replay = await submit(userCredential.credential, "user-native");
			expect(replay.executionId).toBe(first.executionId);
			await completed(first.executionId);
			const firstRead = TaskProjectionV1Schema.parse(
				await checkedJson(
					await taskRequest(taskPath(first), userCredential.credential),
					200,
				),
			);
			expect(firstRead.status).toBe("completed");
			const events = await taskRequest(
				`${taskPath(first)}/events`,
				userCredential.credential,
				undefined,
				"events",
				AbortSignal.timeout(10000),
			);
			expect(events.status).toBe(200);
			const eventReader = events.body?.getReader();
			if (!eventReader) throw new Error("TASK_NATIVE_SSE_BODY_REQUIRED");
			const expectedEventIds = new Set(
				firstRead.events.map((event) => event.eventId),
			);
			const sseMessages: ReturnType<typeof TaskSseMessageV1Schema.parse>[] = [];
			const decoder = new TextDecoder();
			let sseBuffer = "";
			try {
				while (expectedEventIds.size > 0) {
					const next = await eventReader.read();
					if (next.done) throw new Error("TASK_NATIVE_SSE_INCOMPLETE");
					sseBuffer += decoder.decode(next.value, { stream: true });
					let end = sseBuffer.indexOf("\n\n");
					while (end !== -1) {
						const frame = sseBuffer.slice(0, end);
						sseBuffer = sseBuffer.slice(end + 2);
						const data = frame
							.split(/\r?\n/)
							.filter((line) => line.startsWith("data: "))
							.map((line) => line.slice(6))
							.join("\n");
						if (data) {
							const message = TaskSseMessageV1Schema.parse(JSON.parse(data));
							sseMessages.push(message);
							if (message.kind === "event") {
								expect(message.executionId).toBe(first.executionId);
								expectedEventIds.delete(message.eventId);
							}
						}
						end = sseBuffer.indexOf("\n\n");
					}
				}
			} finally {
				await eventReader.cancel();
			}
			expect(
				sseMessages.some(
					(message) =>
						message.kind === "event" &&
						message.type === "text.delta" &&
						message.payload.text === "synthetic native task answer",
				),
			).toBe(true);
			expect(
				(await taskRequest(taskPath(first), applicationCredential.credential))
					.status,
			).toBe(404);
			start();
			const second = await submit(
				applicationCredential.credential,
				"application-native",
			);
			await completed(second.executionId);
			expect(
				TaskProjectionV1Schema.parse(
					await checkedJson(
						await taskRequest(
							taskPath(second),
							applicationCredential.credential,
						),
						200,
					),
				).status,
			).toBe("completed");
			const scopes =
				await sql`select channel_id from platform.conversation_executions order by created_at`;
			expect(scopes.map((row) => row.channel_id)).toEqual([
				"api:user",
				"api:application",
			]);
			expect((await control()).requests).toBe(2);
			expect(
				requests.filter(
					(request) =>
						request.path.endsWith("/turns") && request.responseStatus === 200,
				),
			).toHaveLength(2);
			await waitUntil(
				async () => ackCount >= 2,
				"native committed events acknowledged",
			);
			expect(children.every((child) => child.exitCode === null)).toBe(true);
			expect(unsafeOutput).toBe(false);
			const checks = [
				"landlock-ioctl-dev-enforced",
				"production-http-user-credential-and-task",
				"production-http-application-credential-and-task",
				"http-idempotent-replay",
				"principal-isolation",
				"native-standard-codex-output-and-sse",
				"two-packaged-workers-automatic-discovery",
				"committed-events-acknowledged",
			];
			expect(
				(
					await taskRequest(
						`/agents/${desired.agentId}/tasks`,
						userCredential.credential,
						{ schemaVersion: 1, text: "different synthetic native input" },
						"user-native",
					)
				).status,
			).toBe(409);
			checks.push("http-idempotency-conflict");

			// Fail only Runtime-origin inserts; admission's platform status event
			// must still commit. A failed Runtime transaction must not be ACKed.
			await control("/hold");
			await sql.unsafe("create sequence platform.test_event_attempts");
			await sql.unsafe(
				"create function platform.test_event_failure() returns trigger language plpgsql as $$ begin perform nextval('platform.test_event_attempts'); raise exception 'injected runtime event transaction failure'; end $$",
			);
			await sql.unsafe(
				"create trigger test_event_failure before insert on platform.conversation_events for each row when (NEW.source = 'runtime') execute function platform.test_event_failure()",
			);
			const held = await submit(userCredential.credential, "held-user-native");
			await waitUntil(
				async () => (await control()).pending === 1,
				"real native model request held",
			);
			await waitUntil(
				async () =>
					(await sql`select is_called from platform.test_event_attempts`)[0]
						?.is_called === true,
				"runtime event transaction failed",
			);
			expect(
				await sql`select 1 from platform.conversation_events where execution_id=${held.executionId} and source='runtime'`,
			).toHaveLength(0);
			expect(
				requests.filter(
					(request) =>
						request.executionId === held.executionId &&
						request.path.endsWith("/ack") &&
						request.responseStatus === 200,
				),
			).toHaveLength(0);
			await sql.unsafe(
				"drop trigger test_event_failure on platform.conversation_events",
			);
			await waitUntil(
				async () =>
					requests.some(
						(request) =>
							request.executionId === held.executionId &&
							request.path.endsWith("/ack") &&
							request.responseStatus === 200,
					),
				"retried Runtime event committed before ACK",
			);
			checks.push("runtime-transaction-failure-no-premature-ack");
			const queued = await submit(
				applicationCredential.credential,
				"queued-application-native",
			);
			const queuedProjection = TaskProjectionV1Schema.parse(
				await checkedJson(
					await taskRequest(taskPath(queued), applicationCredential.credential),
					200,
				),
			);
			expect(queuedProjection.status).toBe("waiting");
			expect((await control()).requests).toBe(3);
			expect(
				requests.filter(
					(request) =>
						request.executionId === queued.executionId &&
						request.path.endsWith("/turns"),
				),
			).toHaveLength(0);

			const [beforeTakeover] =
				await sql`select delivery_fence::int as fence, host_session_ref from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id=${held.executionId}`;
			const priorRequests = requests.length;
			for (const child of children) child.kill("SIGKILL");
			await Promise.all(children.map((child) => once(child, "exit")));
			// Only this test-owned Execution's lease is expired. The replacement
			// processes must discover it without test dispatch or renewed admission.
			await sql`update platform.outbox_items set lease_expires_at=now()-interval '1 second' where payload->>'executionId'=${held.executionId} and status='processing'`;
			start();
			start();
			await waitUntil(
				async () =>
					requests
						.slice(priorRequests)
						.some(
							(request) =>
								request.executionId === held.executionId &&
								request.path.endsWith("/status") &&
								request.responseStatus === 200,
						),
				"new packaged Workers query original native turn",
			);
			const [afterTakeover] =
				await sql`select delivery_fence::int as fence, host_session_ref from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id=${held.executionId}`;
			expect(afterTakeover?.fence).toBeGreaterThan(beforeTakeover?.fence);
			expect(afterTakeover?.host_session_ref).toBe(
				beforeTakeover?.host_session_ref,
			);
			expect((await control()).requests).toBe(3);
			expect(
				requests.filter(
					(request) =>
						request.executionId === held.executionId &&
						request.path.endsWith("/turns") &&
						request.responseStatus === 200,
				),
			).toHaveLength(1);
			checks.push("two-worker-sigkill-native-takeover-no-repeat-turn");

			// Credential revocation controls HTTP access, while the already accepted
			// task retains its captured principal authority and native execution.
			expect(
				(
					await management(
						`/api-credentials/${userCredential.metadata.credentialId}`,
						undefined,
						"DELETE",
					)
				).status,
			).toBe(204);
			expect(
				(await taskRequest(taskPath(held), userCredential.credential)).status,
			).toBe(401);
			const replacementCredential = await checkedJson<Issued>(
				await management("/api-credentials", issue),
				201,
			);
			await control("/release");
			await completed(held.executionId);
			await completed(queued.executionId);
			expect((await control()).requests).toBe(4);
			expect(
				TaskProjectionV1Schema.parse(
					await checkedJson(
						await taskRequest(taskPath(held), replacementCredential.credential),
						200,
					),
				).status,
			).toBe("completed");
			checks.push(
				"credential-revoke-blocks-http-without-cancelling-task",
				"capacity-waiting-drains-after-native-release",
			);
			const webRequest = (path: string, body?: unknown, key = "web-native") =>
				fetch(`${apiOrigin}/api/v1${path}`, {
					method: body === undefined ? "GET" : "POST",
					headers: {
						cookie: "synthetic-owner-session",
						"content-type": "application/json",
						"Idempotency-Key": key,
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
			async function webSubmit(key: string) {
				const conversation = await checkedJson<{ conversationId: string }>(
					await webRequest(
						`/agents/${desired.agentId}/conversations`,
						{ schemaVersion: 1 },
						`${key}-conversation`,
					),
					201,
				);
				const message = await checkedJson<{
					executionId: string;
					messageId: string;
				}>(
					await webRequest(
						`/conversations/${conversation.conversationId}/messages`,
						{ schemaVersion: 1, text: "synthetic historical Web input" },
						key,
					),
					202,
				);
				return { ...conversation, ...message };
			}
			const historicalComplete = await webSubmit("web-complete-native");
			await completed(historicalComplete.executionId);
			const completeEventIds =
				await sql`select event_id from platform.conversation_events where execution_id=${historicalComplete.executionId} and event_type <> 'execution.operation' order by sequence`;
			const completeNativeFacts =
				await sql`select event_id,event_payload from platform.conversation_events where execution_id=${historicalComplete.executionId} and event_type='execution.operation' order by sequence`;
			expect(completeNativeFacts.length).toBeGreaterThan(0);
			await replayWebEvents(
				await fetch(
					`${apiOrigin}/api/v1/conversations/${historicalComplete.conversationId}/events`,
					{
						headers: { cookie: "synthetic-owner-session" },
						signal: AbortSignal.timeout(10_000),
					},
				),
				completeEventIds.map((row) => String(row.event_id)),
				historicalComplete.executionId,
			);
			expect(
				await sql`select event_id,event_payload from platform.conversation_events where execution_id=${historicalComplete.executionId} and event_type='execution.operation' order by sequence`,
			).toEqual(completeNativeFacts);
			await control("/hold");
			const historicalActive = await webSubmit("web-active-native");
			await waitUntil(
				async () => (await control()).pending === 1,
				"real historical Web turn held",
			);
			await waitUntil(
				async () =>
					requests.some(
						(request) =>
							request.executionId === historicalActive.executionId &&
							request.path.endsWith("/ack") &&
							request.responseStatus === 200,
					),
				"historical Web running events durably committed",
			);
			const liveWorkers = children.filter(
				(child) => child.exitCode === null && !child.signalCode,
			);
			for (const child of liveWorkers) child.kill("SIGKILL");
			await Promise.all(liveWorkers.map((child) => once(child, "exit")));
			const historicalIds = [
				historicalComplete.executionId,
				historicalActive.executionId,
			];
			async function historicalSnapshot() {
				return {
					conversations:
						await sql`select * from platform.conversations where id in (${historicalComplete.conversationId},${historicalActive.conversationId}) order by id`,
					executions:
						await sql`select * from platform.conversation_executions where execution_id in ${sql(historicalIds)} order by execution_id`,
					events:
						await sql`select * from platform.conversation_events where execution_id in ${sql(historicalIds)} order by event_id`,
					outbox:
						await sql`select * from platform.outbox_items where payload->>'executionId' in ${sql(historicalIds)} order by id`,
					idempotency:
						await sql`select * from platform.idempotency_records where idempotency_key in ('web-complete-native','web-active-native') order by id`,
				};
			}
			const historicalBefore = await historicalSnapshot();
			const modelRequestsBeforeMigration = (await control()).requests;
			// This is deliberately labelled repeat-migration recovery, separately
			// from the pre-task-schema fixture below. It does not claim a DDL upgrade.
			await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
			expect(await historicalSnapshot()).toEqual(historicalBefore);
			await sql`update platform.outbox_items set lease_expires_at=now()-interval '1 second' where payload->>'executionId'=${historicalActive.executionId} and status='processing'`;
			const priorWebRequests = requests.length;
			start();
			start();
			await waitUntil(
				async () =>
					requests
						.slice(priorWebRequests)
						.some(
							(request) =>
								request.executionId === historicalActive.executionId &&
								request.path.endsWith("/status") &&
								request.responseStatus === 200,
						),
				"packaged Workers automatically resume original Web native execution",
			);
			const [historicalAfter] =
				await sql`select c.host_session_ref, e.turn_id, e.delivery_fence::int as fence from platform.conversations c join platform.conversation_executions e on e.conversation_id=c.id where e.execution_id=${historicalActive.executionId}`;
			const previousExecution = historicalBefore.executions.find(
				(row) => row.execution_id === historicalActive.executionId,
			);
			const previousConversation = historicalBefore.conversations.find(
				(row) => row.id === historicalActive.conversationId,
			);
			expect(historicalAfter?.host_session_ref).toBe(
				previousConversation?.host_session_ref,
			);
			expect(historicalAfter?.turn_id).toBe(previousExecution?.turn_id);
			expect(historicalAfter?.fence).toBeGreaterThan(
				Number(previousExecution?.delivery_fence),
			);
			expect((await control()).requests).toBe(modelRequestsBeforeMigration);
			for (const [old, key] of [
				[historicalComplete, "web-complete-native"],
				[historicalActive, "web-active-native"],
			] as const) {
				const replayed = await checkedJson<{
					executionId: string;
					messageId: string;
				}>(
					await webRequest(
						`/conversations/${old.conversationId}/messages`,
						{ schemaVersion: 1, text: "synthetic historical Web input" },
						key,
					),
					202,
				);
				expect(replayed.executionId).toBe(old.executionId);
				expect(replayed.messageId).toBe(old.messageId);
			}
			expect(
				requests
					.slice(priorWebRequests)
					.filter(
						(request) =>
							request.path.endsWith("/turns") &&
							historicalIds.includes(request.executionId ?? ""),
					),
			).toHaveLength(0);
			await control("/release");
			await completed(historicalActive.executionId);
			const recoveredWebEventIds =
				await sql`select event_id from platform.conversation_events where execution_id=${historicalActive.executionId} and event_type <> 'execution.operation' order by sequence`;
			await replayWebEvents(
				await fetch(
					`${apiOrigin}/api/v1/conversations/${historicalActive.conversationId}/events`,
					{
						headers: { cookie: "synthetic-owner-session" },
						signal: AbortSignal.timeout(10_000),
					},
				),
				recoveredWebEventIds.map((row) => String(row.event_id)),
				historicalActive.executionId,
			);
			const [lastNativeFact] =
				await sql`select event_id,conversation_cursor from platform.conversation_events where execution_id=${historicalActive.executionId} and event_type='execution.operation' order by sequence desc limit 1`;
			if (!lastNativeFact) throw new Error("TASK_NATIVE_WEB_FACT_REQUIRED");
			const continuation = await checkedJson<{ executionId: string }>(
				await webRequest(
					`/conversations/${historicalActive.conversationId}/messages`,
					{
						schemaVersion: 1,
						text: "synthetic Web continuation after native operation",
					},
					"web-continuation-native",
				),
				202,
			);
			await completed(continuation.executionId);
			const resumedEventIds =
				await sql`select event_id from platform.conversation_events where conversation_id=${historicalActive.conversationId} and conversation_cursor>${lastNativeFact.conversation_cursor} and event_type <> 'execution.operation' order by conversation_cursor`;
			await replayWebEvents(
				await fetch(
					`${apiOrigin}/api/v1/conversations/${historicalActive.conversationId}/events`,
					{
						headers: {
							cookie: "synthetic-owner-session",
							"Last-Event-ID": String(lastNativeFact.event_id),
						},
						signal: AbortSignal.timeout(10_000),
					},
				),
				resumedEventIds.map((row) => String(row.event_id)),
				[historicalActive.executionId, continuation.executionId],
			);
			checks.push(
				"web-v1-validates-and-retains-native-facts-and-reconnects-after-them",
			);
			checks.push(
				"real-web-repeat-migration-preserves-history-and-automatic-native-resume",
			);
			await control("/hold");
			const upgradeActive = await webSubmit("web-schema-upgrade-native");
			await waitUntil(
				async () => (await control()).pending === 1,
				"actual Web native turn held before schema upgrade",
			);
			await waitUntil(
				async () =>
					requests.some(
						(request) =>
							request.executionId === upgradeActive.executionId &&
							request.path.endsWith("/ack") &&
							request.responseStatus === 200,
					),
				"actual upgrade turn running events committed before snapshot",
			);
			// A separate database has the actual pre-0021 schema. Its explicitly
			// synthetic legacy references have no native Session in this Host.
			// The upgrade must preserve them and recover by metadata, never submit
			// their old inputs as a new native turn or replace their Session binding.
			const activeWorkers = children.filter(
				(child) => child.exitCode === null && !child.signalCode,
			);
			for (const child of activeWorkers) child.kill("SIGKILL");
			await Promise.all(activeWorkers.map((child) => once(child, "exit")));
			upgradeDatabase = await startPostgresTestDatabase(
				"482-task-native-upgrade",
			);
			const legacySql = postgres(upgradeDatabase.databaseUrl, { max: 2 });
			upgradeSql = legacySql;
			const requireStore = createRequire(
				import.meta.resolve("@agent-infra/platform-store"),
			);
			const readMigrationFiles = requireStore("drizzle-orm/migrator")
				.readMigrationFiles as (options: {
				migrationsFolder: string;
			}) => { sql: string[]; hash: string; folderMillis: number }[];
			const migrationsFolder = join(root, "migrations/platform");
			const journal = JSON.parse(
				await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"),
			) as { entries: { tag: string }[] };
			const taskMigrationIndex = journal.entries.findIndex(
				(entry) => entry.tag === "0021_task_wait_admission",
			);
			if (taskMigrationIndex < 1)
				throw new Error("TASK_NATIVE_UPGRADE_CHECKPOINT_REQUIRED");
			await legacySql.unsafe(
				"create schema platform_migrations; create table platform_migrations.history(id serial primary key,hash text not null,created_at bigint)",
			);
			for (const migration of readMigrationFiles({ migrationsFolder }).slice(
				0,
				taskMigrationIndex,
			)) {
				for (const statement of migration.sql)
					await legacySql.unsafe(statement);
				await legacySql`insert into platform_migrations.history(hash,created_at) values(${migration.hash},${migration.folderMillis})`;
			}
			for (const table of [
				"agents",
				"agent_applications",
				"agent_configuration_revisions",
				"agent_owners",
				"workload_reconciliations",
			] as const) {
				const rows = await sql.unsafe(`select * from platform.${table}`);
				for (const row of rows)
					await legacySql.unsafe(
						`insert into platform.${table} select * from json_populate_record(null::platform.${table},$1::text::json)`,
						[JSON.stringify(row)],
					);
			}
			const upgradeIds = [
				historicalComplete.executionId,
				upgradeActive.executionId,
			];
			const upgradeConversationIds = [
				historicalComplete.conversationId,
				upgradeActive.conversationId,
			];
			// This is a constructed old database populated from actual Web/Host
			// history. json_populate_record copies only the pre-0021 columns; the
			// original Host Session, authorization, input and native turn are untouched.
			for (const [table, rows] of [
				[
					"conversations",
					await sql`select * from platform.conversations where id in ${sql(upgradeConversationIds)}`,
				],
				[
					"conversation_executions",
					await sql`select * from platform.conversation_executions where execution_id in ${sql(upgradeIds)}`,
				],
				[
					"conversation_messages",
					await sql`select * from platform.conversation_messages where execution_id in ${sql(upgradeIds)}`,
				],
				[
					"conversation_events",
					await sql`select * from platform.conversation_events where execution_id in ${sql(upgradeIds)}`,
				],
				[
					"outbox_items",
					await sql`select * from platform.outbox_items where payload->>'executionId' in ${sql(upgradeIds)}`,
				],
				[
					"idempotency_records",
					await sql`select * from platform.idempotency_records where idempotency_key in ('web-complete-native','web-schema-upgrade-native')`,
				],
				[
					"task_authorization_records",
					await sql`select * from platform.task_authorization_records where execution_id in ${sql(upgradeIds)}`,
				],
			] as const) {
				for (const row of rows)
					await legacySql.unsafe(
						`insert into platform.${table} select * from json_populate_record(null::platform.${table},$1::text::json)`,
						[JSON.stringify(row)],
					);
			}
			await legacySql`update platform.outbox_items set lease_expires_at=now()-interval '1 second' where payload->>'executionId'=${upgradeActive.executionId} and status='processing'`;
			async function upgradeSnapshot() {
				return {
					conversations:
						await legacySql`select * from platform.conversations where id in ${legacySql(upgradeConversationIds)} order by id`,
					executions:
						await legacySql`select to_jsonb(e)-'task_wait_order'-'task_wait_deadline' as record from platform.conversation_executions e where execution_id in ${legacySql(upgradeIds)} order by execution_id`,
					messages:
						await legacySql`select * from platform.conversation_messages where execution_id in ${legacySql(upgradeIds)} order by message_id`,
					events:
						await legacySql`select * from platform.conversation_events where execution_id in ${legacySql(upgradeIds)} order by event_id`,
					outboxes:
						await legacySql`select * from platform.outbox_items where payload->>'executionId' in ${legacySql(upgradeIds)} order by id`,
					idempotency:
						await legacySql`select * from platform.idempotency_records where idempotency_key in ('web-complete-native','web-schema-upgrade-native') order by id`,
					authorization:
						await legacySql`select * from platform.task_authorization_records where execution_id in ${legacySql(upgradeIds)} order by id`,
				};
			}
			const upgradeBefore = await upgradeSnapshot();
			const originalUpgradeExecution = upgradeBefore.executions.find(
				(row) => row.record.execution_id === upgradeActive.executionId,
			)?.record;
			const originalUpgradeConversation = upgradeBefore.conversations.find(
				(row) => row.id === upgradeActive.conversationId,
			);
			expect(originalUpgradeExecution?.status).toBe("processing");
			expect(originalUpgradeConversation?.status).toBe("active");
			expect(originalUpgradeConversation?.host_session_ref).toEqual(
				expect.any(String),
			);
			const [agentRevision] =
				await legacySql`select authorization_revision from platform.agents where id=${desired.agentId}`;
			const [webAuthorization] =
				await sql`select boundary from platform.task_authorization_records where execution_id=${historicalActive.executionId}`;
			const legacyIds: string[] = [];
			for (const kind of ["complete", "active", "unknown"] as const) {
				const conversationId = `legacy_native_conversation_${kind}`;
				const executionId = `legacy_native_execution_${kind}`;
				const messageId = `legacy_native_message_${kind}`;
				const turnId = `legacy_native_turn_${kind}`;
				const hostSessionRef = `legacy_missing_native_session_${kind}`;
				const executionStatus =
					kind === "complete"
						? "completed"
						: kind === "active"
							? "processing"
							: "unknown";
				legacyIds.push(executionId);
				await legacySql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,host_session_ref,authorization_revision,last_conversation_cursor,selected_model_option_id,selected_reasoning_level,created_at) values(${conversationId},${desired.agentId},${user.userId},'web',${kind === "complete" ? "ready" : "active"},1,${hostSessionRef},${agentRevision?.authorization_revision},2,'native-option','medium','2026-09-04T00:00:00Z')`;
				await legacySql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,model_configuration_revision,model_option_id,reasoning_level,last_event_sequence,last_runtime_cursor,created_at) values(${executionId},${conversationId},${desired.agentId},${user.userId},'web',${turnId},${executionStatus},1,5,${agentRevision?.authorization_revision},1,'native-option','medium',2,${`legacy_runtime_${kind}_2`},'2026-09-04T00:00:01Z')`;
				await legacySql`insert into platform.conversation_messages(message_id,conversation_id,actor_id,role,text,execution_id,status,created_at) values(${messageId},${conversationId},${user.userId},'user','synthetic legacy Web input',${executionId},'submitted','2026-09-04T00:00:01Z')`;
				for (const [sequence, event] of [
					[1, { type: "text.delta", text: "synthetic legacy Web output" }],
					[2, { type: "execution.status", status: executionStatus }],
				] as const) {
					const eventId = `legacy_native_event_${kind}_${sequence}`;
					await legacySql`insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,source,occurred_at) values(${eventId},${conversationId},${executionId},${eventId},${sequence},${sequence},${event.type},${legacySql.json(event)},${createHash("sha256").update(JSON.stringify(event)).digest("hex")},${`legacy_runtime_${kind}_${sequence}`},'runtime','2026-09-04T00:00:02Z')`;
				}
				const payload = {
					schemaVersion: 1,
					conversationId,
					executionId,
					messageId,
					turnId,
					sessionGeneration: 1,
					modelConfigurationRevision: 1,
					modelOptionId: "native-option",
					reasoningLevel: "medium",
				};
				await legacySql`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id,request_id,status,delivery_fence,lease_owner,lease_expires_at) values(${`conversation:turn:${executionId}`},'conversation',${conversationId},'conversation.turn.submit.v1',${legacySql.json(payload)},'legacy_trace','legacy_request',${kind === "complete" ? "succeeded" : "processing"},5,${kind === "complete" ? null : "expired-legacy-worker"},${kind === "complete" ? null : "2026-09-04T00:00:03Z"})`;
				await legacySql`insert into platform.task_authorization_records(id,execution_id,boundary) values(${`legacy_native_authorization_${kind}`},${executionId},${legacySql.json(webAuthorization?.boundary)})`;
				const result = {
					schemaVersion: 1,
					status: "submitted",
					messageId,
					executionId,
				};
				const digest = platformIdempotencyV1.canonicalRequestDigest({
					schemaVersion: 1,
					command: "message",
					conversationId,
					text: "synthetic legacy Web input",
				});
				await legacySql`insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result) values(${`legacy_native_idempotency_${kind}`},'conversation',${conversationId},${user.userId},'message',${`legacy_native_${kind}`},${digest},'completed',${legacySql.json(result)})`;
			}
			async function legacySnapshot() {
				return {
					conversations:
						await legacySql`select id,agent_id,actor_id,channel_id,status,session_generation,host_session_ref,authorization_revision,last_conversation_cursor,created_at from platform.conversations where id like 'legacy_native_conversation_%' order by id`,
					executions:
						await legacySql`select execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,last_event_sequence,last_runtime_cursor,created_at from platform.conversation_executions where execution_id in ${legacySql(legacyIds)} order by execution_id`,
					events:
						await legacySql`select * from platform.conversation_events where execution_id in ${legacySql(legacyIds)} order by event_id`,
					outboxes:
						await legacySql`select * from platform.outbox_items where payload->>'executionId' in ${legacySql(legacyIds)} order by id`,
					idempotency:
						await legacySql`select * from platform.idempotency_records where id like 'legacy_native_idempotency_%' order by id`,
				};
			}
			const legacyBefore = await legacySnapshot();
			const historyBefore =
				await legacySql`select * from platform_migrations.history order by id`;
			await migratePlatformDatabase({
				databaseUrl: upgradeDatabase.databaseUrl,
			});
			expect(await legacySnapshot()).toEqual(legacyBefore);
			expect(await upgradeSnapshot()).toEqual(upgradeBefore);
			expect(
				(
					await legacySql`select * from platform_migrations.history order by id`
				).slice(0, historyBefore.length),
			).toEqual(historyBefore);
			const migrationHistory =
				await legacySql`select * from platform_migrations.history order by id`;
			expect(migrationHistory.length).toBeGreaterThan(historyBefore.length);
			await migratePlatformDatabase({
				databaseUrl: upgradeDatabase.databaseUrl,
			});
			expect(await legacySnapshot()).toEqual(legacyBefore);
			expect(await upgradeSnapshot()).toEqual(upgradeBefore);
			await writeFile(
				join(moduleDirectory, "configuration.mjs"),
				configSource.replace(
					JSON.stringify(database.databaseUrl),
					JSON.stringify(upgradeDatabase.databaseUrl),
				),
				{ mode: 0o600 },
			);
			const priorLegacyRequests = requests.length;
			const modelsBeforeLegacy = (await control()).requests;
			start();
			start();
			for (const kind of ["active", "unknown"] as const) {
				await waitUntil(
					async () =>
						requests
							.slice(priorLegacyRequests)
							.some(
								(request) =>
									request.executionId === `legacy_native_execution_${kind}` &&
									request.path.endsWith("/status") &&
									request.responseStatus !== 0,
							),
					`formal Worker discovers upgraded legacy ${kind} execution`,
				);
			}
			await waitUntil(
				async () =>
					(
						await legacySql`select 1 from platform.conversation_executions where execution_id in ('legacy_native_execution_active','legacy_native_execution_unknown') and delivery_fence>5`
					).length === 2,
				"legacy recovery fences advanced",
			);
			await waitUntil(
				async () =>
					(
						await legacySql`select distinct stream_id from platform.persisted_events where event_type='outbox.retry_scheduled' and payload->>'errorCode'='RUNTIME_SESSION_BINDING_MISMATCH' and stream_id in ('outbox:conversation:turn:legacy_native_execution_active','outbox:conversation:turn:legacy_native_execution_unknown')`
					).length === 2,
				"both legacy binding rejections durably retained for recovery",
			);
			const legacyRecoveryMetadata = {
				classification: "binding-rejected-original-occupancy-preserved",
				executions:
					await legacySql`select execution_id,status,delivery_fence::int as fence from platform.conversation_executions where execution_id in ${legacySql(legacyIds)} order by execution_id`,
				errors:
					await legacySql`select event_type,payload->>'errorCode' as error_code from platform.persisted_events`,
			};
			expect(
				await legacySql`select execution_id,status from platform.conversation_executions where execution_id in ${legacySql(legacyIds)} order by execution_id`,
			).toEqual(
				legacyBefore.executions.map((row) => ({
					execution_id: row.execution_id,
					status: row.status === "processing" ? "unknown" : row.status,
				})),
			);
			expect(
				await legacySql`select id,status from platform.conversations where id like 'legacy_native_conversation_%' order by id`,
			).toEqual(
				legacyBefore.conversations.map((row) => ({
					id: row.id,
					status: row.status,
				})),
			);
			for (const kind of ["active", "unknown"] as const) {
				expect(
					requests
						.slice(priorLegacyRequests)
						.some(
							(request) =>
								request.executionId === `legacy_native_execution_${kind}` &&
								request.path.endsWith("/status") &&
								request.responseStatus === 403 &&
								request.responseCode === "RUNTIME_SESSION_BINDING_MISMATCH",
						),
				).toBe(true);
			}
			expect((await control()).requests).toBe(modelsBeforeLegacy);
			expect(
				requests
					.slice(priorLegacyRequests)
					.filter(
						(request) =>
							legacyIds.includes(request.executionId ?? "") &&
							request.path.endsWith("/turns"),
					),
			).toHaveLength(0);
			expect(
				await legacySql`select id,host_session_ref from platform.conversations where id like 'legacy_native_conversation_%' order by id`,
			).toEqual(
				legacyBefore.conversations.map((row) => ({
					id: row.id,
					host_session_ref: row.host_session_ref,
				})),
			);
			expect(
				await legacySql`select * from platform.conversation_events where event_id like 'legacy_native_event_%' order by event_id`,
			).toEqual(legacyBefore.events);
			expect(
				await legacySql`select * from platform.idempotency_records where id like 'legacy_native_idempotency_%' order by id`,
			).toEqual(legacyBefore.idempotency);
			expect(
				await legacySql`select status from platform.conversation_executions where execution_id='legacy_native_execution_complete'`,
			).toEqual([{ status: "completed" }]);
			expect(
				await legacySql`select status from platform.conversation_executions where execution_id in ('legacy_native_execution_active','legacy_native_execution_unknown') and status in ('completed','failed','cancelled')`,
			).toHaveLength(0);
			checks.push(
				"pre-0021-schema-upgrade-preserves-legacy-history",
				"upgraded-legacy-binding-rejected-original-occupancy-preserved-no-replay",
			);
			await waitUntil(
				async () =>
					requests
						.slice(priorLegacyRequests)
						.some(
							(request) =>
								request.executionId === upgradeActive.executionId &&
								request.path.endsWith("/status") &&
								request.responseStatus === 200,
						),
				"upgraded packaged Workers query legal original Host Session",
			);
			const [upgradeRecovered] =
				await legacySql`select c.host_session_ref,c.session_generation::int as session_generation,e.turn_id,e.actor_id,e.channel_id,e.authorization_revision,e.delivery_fence::int as fence from platform.conversations c join platform.conversation_executions e on e.conversation_id=c.id where e.execution_id=${upgradeActive.executionId}`;
			expect(upgradeRecovered).toMatchObject({
				host_session_ref: originalUpgradeConversation?.host_session_ref,
				session_generation: originalUpgradeExecution?.session_generation,
				turn_id: originalUpgradeExecution?.turn_id,
				actor_id: originalUpgradeExecution?.actor_id,
				channel_id: originalUpgradeExecution?.channel_id,
				authorization_revision:
					originalUpgradeExecution?.authorization_revision,
			});
			expect(upgradeRecovered?.fence).toBeGreaterThan(
				Number(originalUpgradeExecution?.delivery_fence),
			);
			const originalOperationDigest = requests
				.slice(priorLegacyRequests)
				.find(
					(request) =>
						request.executionId === upgradeActive.executionId &&
						request.path.endsWith("/status") &&
						request.responseStatus === 200,
				)?.originalOperationDigest;
			expect(originalOperationDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect((await control()).pending).toBe(1);
			expect((await control()).requests).toBe(modelsBeforeLegacy);
			await control("/release");
			await waitUntil(
				async () =>
					(
						await legacySql`select 1 from platform.conversation_executions where execution_id=${upgradeActive.executionId} and status='completed'`
					).length === 1,
				"actual schema-upgraded original native turn completes automatically",
			);
			const upgradeAfter = await upgradeSnapshot();
			expect(upgradeAfter.authorization).toEqual(upgradeBefore.authorization);
			expect(upgradeAfter.idempotency).toEqual(upgradeBefore.idempotency);
			expect(
				upgradeAfter.messages.map(({ message_id, execution_id, text }) => ({
					message_id,
					execution_id,
					text,
				})),
			).toEqual(
				upgradeBefore.messages.map(({ message_id, execution_id, text }) => ({
					message_id,
					execution_id,
					text,
				})),
			);
			expect(
				upgradeAfter.events.filter((row) =>
					upgradeBefore.events.some((old) => old.event_id === row.event_id),
				),
			).toEqual(upgradeBefore.events);
			expect(
				upgradeAfter.executions.find(
					(row) => row.record.execution_id === historicalComplete.executionId,
				),
			).toEqual(
				upgradeBefore.executions.find(
					(row) => row.record.execution_id === historicalComplete.executionId,
				),
			);
			expect(
				requests
					.slice(priorLegacyRequests)
					.filter(
						(request) =>
							upgradeIds.includes(request.executionId ?? "") &&
							request.path.endsWith("/turns"),
					),
			).toHaveLength(0);
			expect(
				requests.filter(
					(request) =>
						request.executionId === upgradeActive.executionId &&
						request.path.endsWith("/turns") &&
						request.responseStatus === 200,
				),
			).toHaveLength(1);
			expect((await control()).requests).toBe(modelsBeforeLegacy);
			checks.push(
				"pre-0021-schema-upgrade-real-original-host-session-automatic-completion-no-repeat-turn",
			);
			const nativeUpgrade = {
				database: "constructed-pre-0021-with-actual-web-history",
				nativeSession: "actual-original-session-untouched",
				originalOperationDigest,
				inputDigest: createHash("sha256")
					.update(
						String(
							upgradeBefore.messages.find(
								(row) => row.execution_id === upgradeActive.executionId,
							)?.text,
						),
					)
					.digest("hex"),
				status: "completed",
				fenceBefore: Number(originalUpgradeExecution?.delivery_fence),
				fenceAfter: upgradeRecovered?.fence,
				newNativeTurns: 0,
			};
			const legacyWorkers = children.slice(-2);
			for (const child of legacyWorkers) child.kill("SIGKILL");
			await Promise.all(legacyWorkers.map((child) => once(child, "exit")));
			await writeFile(
				join(moduleDirectory, "configuration.mjs"),
				configSource,
				{ mode: 0o600 },
			);
			await sql`update platform.outbox_items set lease_expires_at=now()-interval '1 second' where payload->>'executionId'=${upgradeActive.executionId} and status='processing'`;
			start();
			start();
			await completed(upgradeActive.executionId);
			async function status(executionId: string, expected: string) {
				await waitUntil(
					async () =>
						(
							await sql`select 1 from platform.conversation_executions where execution_id=${executionId} and status::text=${expected}`
						).length === 1,
					`native execution ${expected}`,
				);
			}
			const fifoRequestStart = requests.length;
			await control("/hold");
			const fifoA = await submit(
				replacementCredential.credential,
				"fifo-native-a",
				undefined,
				"synthetic FIFO native input A",
			);
			await waitUntil(
				async () => (await control()).pending === 1,
				"FIFO native A held",
			);
			await status(fifoA.executionId, "processing");
			const [fifoSession] =
				await sql`select host_session_ref from platform.conversations where id=${fifoA.conversationId}`;
			expect(fifoSession?.host_session_ref).toEqual(expect.any(String));
			const fifoB = await submit(
				replacementCredential.credential,
				"fifo-native-b",
				fifoA.conversationId,
				"synthetic FIFO native input B",
			);
			const waitingCancel = await submit(
				replacementCredential.credential,
				"fifo-native-cancel",
				fifoA.conversationId,
				"synthetic FIFO waiting input to cancel",
			);
			const fifoC = await submit(
				replacementCredential.credential,
				"fifo-native-c",
				fifoA.conversationId,
				"synthetic FIFO native input C",
			);
			const fifoWaitingIds = [
				fifoB.executionId,
				waitingCancel.executionId,
				fifoC.executionId,
			];
			const fifoWaitingBefore =
				await sql`select execution_id,status,task_wait_order,task_wait_deadline from platform.conversation_executions where execution_id in ${sql(fifoWaitingIds)} order by task_wait_order`;
			expect(fifoWaitingBefore.map((row) => row.execution_id)).toEqual(
				fifoWaitingIds,
			);
			expect(fifoWaitingBefore.map((row) => row.status)).toEqual([
				"waiting",
				"waiting",
				"waiting",
			]);
			expect(
				await sql`select (extract(epoch from (task_wait_deadline-created_at))*1000)::int as waiting_ms from platform.conversation_executions where execution_id in ${sql(fifoWaitingIds)}`,
			).toEqual(
				fifoWaitingIds.map(() => ({ waiting_ms: taskWaitingTimeoutMs })),
			);
			const [capacityBefore] =
				await sql`select (select count(*) from platform.conversations)::int as conversations,(select count(*) from platform.conversation_executions)::int as executions,(select count(*) from platform.outbox_items)::int as outboxes,(select count(*) from platform.idempotency_records)::int as idempotency`;
			const fullResponse = await taskRequest(
				`/agents/${desired.agentId}/tasks`,
				replacementCredential.credential,
				{ schemaVersion: 1, text: "synthetic over-capacity input" },
				"fifo-native-full",
			);
			expect(fullResponse.status).toBe(409);
			expect(await fullResponse.json()).toMatchObject({ code: "AGENT_BUSY" });
			expect(
				(
					await sql`select (select count(*) from platform.conversations)::int as conversations,(select count(*) from platform.conversation_executions)::int as executions,(select count(*) from platform.outbox_items)::int as outboxes,(select count(*) from platform.idempotency_records)::int as idempotency`
				)[0],
			).toEqual(capacityBefore);
			checks.push(
				"formal-waiting-capacity-full-no-orphan-task-or-conversation",
			);
			const fifoLiveWorkers = children.filter(
				(child) => child.exitCode === null && !child.signalCode,
			);
			for (const child of fifoLiveWorkers) child.kill("SIGKILL");
			await Promise.all(fifoLiveWorkers.map((child) => once(child, "exit")));
			await sql`update platform.outbox_items set lease_expires_at=now()-interval '1 second' where payload->>'executionId'=${fifoA.executionId} and status='processing'`;
			const fifoRecoveryStart = requests.length;
			start();
			start();
			await waitUntil(
				async () =>
					requests
						.slice(fifoRecoveryStart)
						.some(
							(request) =>
								request.executionId === fifoA.executionId &&
								request.path.endsWith("/status") &&
								request.responseStatus === 200,
						),
				"FIFO active A recovered before waiting queue drains",
			);
			expect(
				await sql`select execution_id,status,task_wait_order,task_wait_deadline from platform.conversation_executions where execution_id in ${sql(fifoWaitingIds)} order by task_wait_order`,
			).toEqual(fifoWaitingBefore);
			expect(
				requests.filter(
					(request) =>
						fifoWaitingIds.includes(request.executionId ?? "") &&
						request.path.endsWith("/turns"),
				),
			).toHaveLength(0);
			const cancelWaiting = () =>
				taskRequest(
					`${taskPath(waitingCancel)}/cancel`,
					replacementCredential.credential,
					{ schemaVersion: 1 },
					"fifo-native-waiting-cancel",
				);
			const waitingCancellation = await checkedJson(await cancelWaiting(), 202);
			expect(await checkedJson(await cancelWaiting(), 202)).toEqual(
				waitingCancellation,
			);
			await status(waitingCancel.executionId, "cancelled");
			expect(
				TaskProjectionV1Schema.parse(
					await checkedJson(
						await taskRequest(
							taskPath(waitingCancel),
							replacementCredential.credential,
						),
						200,
					),
				).status,
			).toBe("cancelled");
			checks.push("formal-waiting-cancel-idempotent-no-native-turn");
			await control("/release");
			await completed(fifoA.executionId);
			await completed(fifoB.executionId);
			await completed(fifoC.executionId);
			expect(
				requests
					.slice(fifoRequestStart)
					.filter(
						(request) =>
							request.path.endsWith("/turns") && request.responseStatus === 200,
					)
					.map((request) => request.inputDigest),
			).toEqual(
				["A", "B", "C"].map((suffix) =>
					createHash("sha256")
						.update(`synthetic FIFO native input ${suffix}`)
						.digest("hex"),
				),
			);
			expect(
				requests
					.slice(fifoRequestStart)
					.filter(
						(request) =>
							request.path.endsWith("/turns") && request.responseStatus === 200,
					)
					.map((request) => request.hostSessionRef),
			).toEqual([
				null,
				fifoSession?.host_session_ref,
				fifoSession?.host_session_ref,
			]);
			expect(
				requests
					.slice(fifoRequestStart)
					.filter(
						(request) =>
							request.path.endsWith("/turns") && request.responseStatus === 200,
					)
					.map((request) => request.responseHostSessionRef),
			).toEqual([
				fifoSession?.host_session_ref,
				fifoSession?.host_session_ref,
				fifoSession?.host_session_ref,
			]);
			expect(
				requests
					.slice(fifoRequestStart)
					.filter(
						(request) =>
							request.path.endsWith("/turns") && request.responseStatus === 200,
					)
					.map((request) => request.executionId),
			).toEqual([fifoA.executionId, fifoB.executionId, fifoC.executionId]);
			expect(
				requests.filter(
					(request) =>
						request.executionId === waitingCancel.executionId &&
						(request.path.endsWith("/turns") ||
							request.path.endsWith("/stops")),
				),
			).toHaveLength(0);
			expect(
				await sql`select execution_id,task_wait_order,task_wait_deadline from platform.conversation_executions where execution_id in ${sql(fifoWaitingIds)} order by task_wait_order`,
			).toEqual(fifoWaitingBefore.map(({ status: _status, ...row }) => row));
			checks.push(
				"same-conversation-native-fifo-restart-preserves-order-and-deadlines",
			);
			await control("/hold");
			const grantRevoked = await submit(
				applicationCredential.credential,
				"grant-revoked-application-native",
			);
			await waitUntil(
				async () => (await control()).pending === 1,
				"application native turn held before use grant revoke",
			);
			await status(grantRevoked.executionId, "processing");
			expect(
				(
					await management(
						`/agents/${desired.agentId}/grants`,
						{
							schemaVersion: 1,
							principal: { kind: "application", id: application.applicationId },
							grantType: "use",
						},
						"DELETE",
					)
				).status,
			).toBe(204);
			await status(grantRevoked.executionId, "cancelled");
			await waitUntil(
				async () => (await control()).pending === 0,
				"real Codex stop closes revoked application model request",
			);
			expect(
				requests.some(
					(request) =>
						request.executionId === grantRevoked.executionId &&
						request.path.endsWith("/stops") &&
						request.responseStatus === 200,
				),
			).toBe(true);
			expect(
				(
					await taskRequest(
						taskPath(grantRevoked),
						applicationCredential.credential,
					)
				).status,
			).toBe(404);
			checks.push("formal-use-grant-revoke-durable-native-stop");
			const cancelled = await submit(
				replacementCredential.credential,
				"cancel-user-native",
			);
			await waitUntil(
				async () => (await control()).pending === 1,
				"native user turn held before HTTP cancel",
			);
			await status(cancelled.executionId, "processing");
			expect(
				(
					await taskRequest(
						`${taskPath(cancelled)}/cancel`,
						replacementCredential.credential,
						{ schemaVersion: 1 },
						"cancel-user-native-stop",
					)
				).status,
			).toBe(202);
			await status(cancelled.executionId, "cancelled");
			await waitUntil(
				async () => (await control()).pending === 0,
				"HTTP cancellation closes actual native model stream",
			);
			checks.push("http-cancel-confirmed-by-native-terminal-event");
			await control("/hold");
			const lostInput = "synthetic accepted native input with lost responses";
			responseLoss = {
				inputDigest: createHash("sha256").update(lostInput).digest("hex"),
				dropped: 0,
			};
			const lostTask = await submit(
				replacementCredential.credential,
				"accepted-native-response-lost",
				undefined,
				lostInput,
			);
			uncertaintyIds = [lostTask.executionId];
			await waitUntil(
				async () =>
					(await control()).pending === 1 &&
					requests.some(
						(request) =>
							request.executionId === lostTask.executionId &&
							request.path.endsWith("/turns") &&
							request.responseLost &&
							request.responseOutcome === "accepted",
					),
				"real accepted native turn response lost while model request held",
			);
			await status(lostTask.executionId, "unknown");
			const acceptedLostResponse = requests.find(
				(request) =>
					request.executionId === lostTask.executionId &&
					request.path.endsWith("/turns") &&
					request.responseLost,
			);
			expect(acceptedLostResponse?.responseHostSessionRef).toEqual(
				expect.any(String),
			);
			const [unknownSession] =
				await sql`select host_session_ref from platform.conversations where id=${lostTask.conversationId}`;
			const [lostOriginal] =
				await sql`select execution_id,conversation_id,turn_id,session_generation,actor_id,channel_id,authorization_revision from platform.conversation_executions where execution_id=${lostTask.executionId}`;
			const lostLiveWorkers = children.filter(
				(child) => child.exitCode === null && !child.signalCode,
			);
			for (const child of lostLiveWorkers) child.kill("SIGKILL");
			await Promise.all(lostLiveWorkers.map((child) => once(child, "exit")));
			await sql`update platform.outbox_items set lease_expires_at=now()-interval '1 second' where payload->>'executionId'=${lostTask.executionId} and status='processing'`;
			const responseLossRecoveryStart = requests.length;
			start();
			start();
			await waitUntil(
				async () =>
					requests
						.slice(responseLossRecoveryStart)
						.some(
							(request) =>
								request.executionId === lostTask.executionId &&
								request.path.endsWith("/status") &&
								request.responseLost,
						),
				"restarted packaged Workers query actual original Host through transport loss",
			);
			const unknownWaiting = await submit(
				replacementCredential.credential,
				"unknown-successor-wait-expiry",
				lostTask.conversationId,
				"synthetic successor behind original unknown turn",
			);
			uncertaintyIds.push(unknownWaiting.executionId);
			await status(unknownWaiting.executionId, "waiting");
			const [unknownWaitingBefore] =
				await sql`select task_wait_order,task_wait_deadline,created_at from platform.conversation_executions where execution_id=${unknownWaiting.executionId}`;
			expect(
				new Date(unknownWaitingBefore?.task_wait_deadline).getTime() -
					new Date(unknownWaitingBefore?.created_at).getTime(),
			).toBe(taskWaitingTimeoutMs);
			const modelRequestsBeforeExpiry = (await control()).requests;
			await new Promise((done) =>
				setTimeout(
					done,
					Math.max(
						0,
						new Date(unknownWaitingBefore?.task_wait_deadline).getTime() -
							Date.now(),
					),
				),
			);
			await status(unknownWaiting.executionId, "failed");
			expect(
				await sql`select task_wait_order,task_wait_deadline,created_at from platform.conversation_executions where execution_id=${unknownWaiting.executionId}`,
			).toEqual([unknownWaitingBefore]);
			expect(
				await sql`select 1 from platform.audit_events where target_id=${unknownWaiting.executionId} and action='task.status.changed' and details->>'status'='failed' and details->>'reason'='TASK_WAIT_TIMEOUT'`,
			).toHaveLength(1);
			expect(
				await sql`select e.status,c.status as conversation_status,c.host_session_ref from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id=${lostTask.executionId} and e.task_wait_deadline<now()`,
			).toEqual([
				{
					status: "unknown",
					conversation_status: "active",
					host_session_ref: unknownSession?.host_session_ref,
				},
			]);
			expect(
				requests.filter(
					(request) =>
						request.executionId === unknownWaiting.executionId &&
						request.path.endsWith("/turns"),
				),
			).toHaveLength(0);
			expect((await control()).requests).toBe(modelRequestsBeforeExpiry);
			expect(
				TaskProjectionV1Schema.parse(
					await checkedJson(
						await taskRequest(
							taskPath(lostTask),
							replacementCredential.credential,
						),
						200,
					),
				).status,
			).toBe("unknown");
			checks.push(
				"real-wait-deadline-expires-successor-without-releasing-original-unknown",
			);
			expect(
				requests.filter(
					(request) =>
						request.executionId === lostTask.executionId &&
						request.path.endsWith("/turns"),
				),
			).toHaveLength(1);
			const responseLossDropped = responseLoss.dropped;
			responseLoss = undefined;
			await control("/release");
			await waitUntil(
				async () =>
					(
						await sql`select 1 from platform.conversation_executions where execution_id=${lostTask.executionId} and status in ('completed','cancelled','failed')`
					).length === 1,
				"actual original terminal proof recovered after bounded response loss",
			);
			await waitUntil(
				async () =>
					(
						await sql`select 1 from platform.conversation_events where execution_id=${lostTask.executionId} and source='runtime' and event_type='execution.status' and event_payload->>'status' in ('completed','cancelled','failed')`
					).length === 1,
				"actual original native terminal event committed after response loss",
			);
			const [responseLossRecovered] =
				await sql`select e.status,e.turn_id,c.host_session_ref from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id=${lostTask.executionId}`;
			expect(
				(
					await sql`select execution_id,conversation_id,turn_id,session_generation,actor_id,channel_id,authorization_revision from platform.conversation_executions where execution_id=${lostTask.executionId}`
				)[0],
			).toEqual(lostOriginal);
			expect(responseLossRecovered?.host_session_ref).toBe(
				acceptedLostResponse?.responseHostSessionRef,
			);
			expect(
				requests.filter(
					(request) =>
						request.executionId === lostTask.executionId &&
						request.path.endsWith("/turns"),
				),
			).toHaveLength(1);
			expect((await control()).requests).toBe(modelRequestsBeforeExpiry);
			checks.push(
				"lost-accepted-response-automatic-original-terminal-recovery-no-repeat-turn",
			);
			const responseLossMetadata = {
				fault: "bounded-real-host-response-transport-loss",
				acceptedOutcome: acceptedLostResponse?.responseOutcome,
				originalPlatformSessionBinding: unknownSession?.host_session_ref,
				recoveredOriginalHostSession: responseLossRecovered?.host_session_ref,
				recoveredStatus: responseLossRecovered?.status,
				droppedResponses: responseLossDropped,
				newNativeTurns: 0,
			};
			await control("/hold");
			const restarted = await submit(
				replacementCredential.credential,
				"host-restart-user-native",
			);
			uncertaintyIds.push(restarted.executionId);
			await waitUntil(
				async () => (await control()).pending === 1,
				"native turn held before Host child restart",
			);
			await status(restarted.executionId, "processing");
			const [beforeHostRestart] =
				await sql`select host_session_ref from platform.conversations where id=${restarted.conversationId}`;
			const modelsBeforeHostRestart = (await control()).requests;
			await control("/restart");
			await waitUntil(
				async () => (await control()).ready,
				"protected Host restarted",
			);
			await status(restarted.executionId, "unknown");
			expect(
				(
					await sql`select host_session_ref from platform.conversations where id=${restarted.conversationId}`
				)[0]?.host_session_ref,
			).toBe(beforeHostRestart?.host_session_ref);
			expect(
				TaskProjectionV1Schema.parse(
					await checkedJson(
						await taskRequest(
							taskPath(restarted),
							replacementCredential.credential,
						),
						200,
					),
				).status,
			).toBe("unknown");
			expect((await control()).requests).toBe(modelsBeforeHostRestart);
			expect(
				requests.filter(
					(request) =>
						request.executionId === restarted.executionId &&
						request.path.endsWith("/turns") &&
						request.responseStatus === 200,
				),
			).toHaveLength(1);
			checks.push("host-child-restart-truthful-unknown-no-repeat-turn");
			// Restart retains this container's tmpfs. No Pod/PVC replacement is claimed.
			expect(children.slice(-2).every((child) => child.exitCode === null)).toBe(
				true,
			);
			expect(unsafeOutput).toBe(false);
			const evidence = {
				test: "task-api-native",
				head: head.trim(),
				imageRevision: revision,
				sourceTree,
				imageContentId: imageMetadata.Id,
				imageDigest,
				imageDigestSource,
				sourceKind: "standard",
				templateId: "codex",
				driver: "codex",
				principals: ["user", "application"],
				modelRequests: (await control()).requests,
				committedAcks: ackCount,
				workerProcesses: children.length,
				workerOutputBytes: outputBytes,
				upgrades: [
					{
						kind: "repeat-migration",
						history: "actual-web-http-and-native",
						ddlChanged: false,
					},
					{
						kind: "pre-0021-to-current",
						history: "synthetic-legacy-web",
						ddlChanged: true,
						nativeSession: "absent",
						recovery: "binding-rejected-original-occupancy-preserved",
					},
					{
						kind: "pre-0021-to-current",
						history: "actual-web-copied-to-constructed-old-database",
						ddlChanged: true,
						nativeSession: "actual-original-session-untouched",
						recovery: "automatic-original-turn-completion-no-repeat-turn",
					},
				],
				hostRestart: "child-process-retaining-container-tmpfs",
				controlledAdapters: ["directory", "kubernetes-api", "model-endpoint"],
				legacyRecovery: legacyRecoveryMetadata,
				nativeUpgrade,
				responseLoss: responseLossMetadata,
				waiting: {
					policy: {
						maximumWaitingTasksPerAgent: 3,
						waitingTimeoutMs: taskWaitingTimeoutMs,
					},
					restartPreserved: fifoWaitingBefore.map((row) => ({
						order: row.task_wait_order,
						deadline: new Date(row.task_wait_deadline).toISOString(),
					})),
					nativeOrder: ["A", "B", "C"],
					sameOriginalHostSession: true,
					waitingCancellationNativeTurns: 0,
					expiredSuccessorDeadline: new Date(
						unknownWaitingBefore?.task_wait_deadline,
					).toISOString(),
					originalAfterExpiry: "unknown-occupancy-retained",
				},
				checks,
			};
			const evidencePath = process.env.AGENT_INFRA_TASK_NATIVE_EVIDENCE;
			if (evidencePath) {
				await mkdir(dirname(evidencePath), { recursive: true });
				await writeFile(
					evidencePath,
					`${JSON.stringify(evidence, null, 2)}\n`,
					{
						mode: 0o600,
					},
				);
			}
			console.info(JSON.stringify(evidence));
		} catch (error) {
			const uncertainty = uncertaintyIds.length
				? {
						requests: requests
							.filter((request) =>
								uncertaintyIds.includes(request.executionId ?? ""),
							)
							.slice(-25),
						executions:
							await sql`select e.execution_id,e.conversation_id,e.turn_id,e.status,e.delivery_fence::int as fence,e.task_wait_deadline,c.status as conversation_status,c.host_session_ref from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id in ${sql(uncertaintyIds)} order by e.created_at`,
						events:
							await sql`select execution_id,event_type,source,event_payload->>'status' as status,event_payload->>'reason' as reason from platform.conversation_events where execution_id in ${sql(uncertaintyIds)} order by conversation_cursor`,
						controls:
							await sql`select execution_id,reason,created_at from platform.task_control_records where execution_id in ${sql(uncertaintyIds)}`,
						tombstones:
							await sql`select execution_id,status,failure_code,confirmed_at from platform.conversation_generation_tombstones where execution_id in ${sql(uncertaintyIds)}`,
					}
				: undefined;
			const diagnosticPath = process.env.AGENT_INFRA_TASK_NATIVE_EVIDENCE;
			if (diagnosticPath && uncertainty)
				await writeFile(
					`${diagnosticPath}.uncertainty-observation.json`,
					`${JSON.stringify(uncertainty, null, 2)}\n`,
					{ mode: 0o600 },
				);
			let controlMetadata: unknown;
			if (controlOrigin)
				controlMetadata = await fetch(`${controlOrigin}/stats`, {
					signal: AbortSignal.timeout(2000),
				})
					.then((response) => response.json())
					.catch(() => ({ unavailable: true }));
			throw new Error(
				JSON.stringify({
					uncertainty,
					traces: traces.slice(-20),
					control: controlMetadata,
					processes: children.map((child) => ({
						exitCode: child.exitCode,
						signalCode: child.signalCode,
					})),
					executions:
						await sql`select status,delivery_fence::int as fence,model_configuration_revision from platform.conversation_executions`,
					audit:
						await sql`select event_type,payload->>'errorCode' as error_code from platform.persisted_events`,
					upgradeExecutions: upgradeSql
						? await upgradeSql`select execution_id,status,delivery_fence::int as fence from platform.conversation_executions order by execution_id`
						: undefined,
					upgradeOutbox: upgradeSql
						? await upgradeSql`select operation,status,delivery_fence::int as fence from platform.outbox_items order by id`
						: undefined,
					upgradeErrors: upgradeSql
						? await upgradeSql`select event_type,payload->>'errorCode' as error_code from platform.persisted_events`
						: undefined,
				}),
				{ cause: error },
			);
		} finally {
			for (const child of children)
				if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
			await Promise.all(
				children.map((child) =>
					child.exitCode !== null || child.signalCode
						? Promise.resolve()
						: once(child, "exit"),
				),
			);
			if (running) await createPlatformApiShutdown(running)();
			runtimeServer.closeAllConnections();
			kube.closeAllConnections();
			await Promise.all([
				new Promise<void>((done) => runtimeServer.close(() => done())),
				new Promise<void>((done) => kube.close(() => done())),
			]);
			await execFile("docker", [
				"rm",
				"--force",
				"--volumes",
				containerName,
			]).catch(() => {});
			await sql.end({ timeout: 0 });
			await database.stop();
			await upgradeSql?.end({ timeout: 0 });
			await upgradeDatabase?.stop();
			if (moduleDirectory)
				await rm(moduleDirectory, { recursive: true, force: true });
			await rm(directoryPath, { recursive: true, force: true });
		}
	},
	300_000,
);
