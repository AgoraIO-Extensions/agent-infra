import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import { createAgentManagementV1 } from "@agent-infra/platform-core";
import { PostgresAgentManagementTransactionV1 } from "@agent-infra/platform-store";
import { KubeConfig, type V1Pod } from "@kubernetes/client-node";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import { seedSessionSandboxFixture } from "../../../packages/platform-store/src/session-sandbox.fixture.js";
import { createProductionSessionSandboxReceiverV1 } from "./conversation-deployment.js";
import { createPlatformConversationWorkerV2 } from "./conversation-worker.js";
import {
	workloadDesiredFixture,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createWorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { sessionSandboxLabelsV1 } from "./session-workload-adapter.js";
import {
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";

const execFile = promisify(execFileCallback);
const enabled = process.env.WORKLOAD_KIND_SESSION_TEST === "1";
const namespace =
	process.env.WORKLOAD_KIND_SESSION_NAMESPACE ??
	`sandbox-${Date.now().toString(36)}-${process.pid}`;
function kubeArgs() {
	const kubeconfig = process.env.KUBECONFIG;
	const context = process.env.WORKLOAD_KIND_CONTEXT;
	if (!kubeconfig || !context)
		throw new Error(
			"Explicit KUBECONFIG and WORKLOAD_KIND_CONTEXT are required",
		);
	return ["--kubeconfig", kubeconfig, "--context", context];
}
async function kubectl(...args: string[]) {
	return (
		await execFile(
			"kubectl",
			[...kubeArgs(), "--namespace", namespace, ...args],
			{ timeout: 30_000 },
		)
	).stdout.trim();
}
async function eventually<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
) {
	for (let attempt = 0; attempt < 180; attempt++) {
		const value = await read();
		if (done(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error("Session Sandbox resources did not converge");
}

describe.skipIf(!enabled)("real SessionSandbox Worker isolation", () => {
	it("reconciles two Store allocations through the Worker loop and proves isolation", async () => {
		const imageDigest = process.env.WORKLOAD_KIND_IMAGE_A;
		const imageRepository = process.env.WORKLOAD_KIND_REPOSITORY;
		const evidenceDirectory = process.env.WORKLOAD_KIND_EVIDENCE_DIR;
		assert(imageDigest && imageRepository && evidenceDirectory);
		const admin = new KubeConfig();
		admin.loadFromFile(process.env.KUBECONFIG ?? "");
		admin.setCurrentContext(process.env.WORKLOAD_KIND_CONTEXT ?? "");
		await execFile("kubectl", [
			...kubeArgs(),
			"create",
			"namespace",
			namespace,
		]);
		const client = createWorkerKubernetesClientV1(namespace, admin);
		const policy = { ...workloadTestPolicy, namespace, imageRepository };
		const desiredBase = workloadDesiredFixture(
			1,
			"agent-kind",
			"internal-only",
		);
		const desired = validateAgentWorkloadDesiredV1({
			...desiredBase,
			imageDigest,
			registryAdmission: {
				...desiredBase.registryAdmission,
				immutableDigest: imageDigest,
				policyEvidence: {
					...desiredBase.registryAdmission.policyEvidence,
					imageDigest,
				},
			},
		});
		const configuration = {
			schemaVersion: 2,
			agentId: desired.agentId,
			revision: 1,
			source: {
				kind: "custom",
				imageDigest: desired.imageDigest,
				admissionRevision: "kind",
				interactionMode: "platform-adapter",
				connectionEnabled: false,
			},
			modelConfiguration: null,
			environment: [],
			secrets: [],
			channels: [],
			channelRevision: "kind",
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
			identity: { uid: "controlled", generation: 1 },
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
		const database = await startPostgresTestDatabase("session-sandbox-kind");
		const sql = postgres(database.databaseUrl, { onnotice: () => undefined });
		const controller = new AbortController();
		let worker:
			| ReturnType<typeof createPlatformConversationWorkerV2>
			| undefined;
		try {
			await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
			for (const sessionId of ["session-kind-a", "session-kind-b"]) {
				await sql`insert into platform.conversations (id, agent_id, actor_id, principal_type, channel_id, status, session_generation, authorization_revision, created_at, updated_at) values (${sessionId}, 'agent-kind', ${`actor-${sessionId}`}, 'user', 'web', 'ready', 1, 'kind', now(), now())`;
				await seedSessionSandboxFixture(sql, sessionId);
			}
			await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision) values ('agent-kind', 1, 'kind')`;
			await sql`insert into platform.agent_owners (agent_id, owner_id, created_at) values ('agent-kind', 'actor-session-kind-a', now()), ('agent-kind', 'actor-session-kind-b', now())`;
			await sql`insert into platform.agent_applications (id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at, management_revision, approval_revision, desired_state, service_availability, workload_revision, fence) values ('application-kind', 'agent-kind', 'kind-user', 'Kind Agent', 'Test', 'available', 'trace', 'request', now(), 1, 1, 'running', 'ready', 1, 1)`;
			await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at, configuration) values ('agent-kind', 1, 'kind', now(), ${sql.json(configuration)})`;
			await sql`insert into platform.workload_reconciliations (agent_id, revision, state, next_attempt_at) values ('agent-kind', 1, ${sql.json(state)}, now() + interval '1 hour')`;
			// The fixture supplies only controlled admission. Store owns every lifecycle transition below.
			await sql`update platform.session_sandbox_allocations set status = 'allocated', resource_observation = null, updated_at = now() where conversation_id in ('session-kind-a', 'session-kind-b')`;
			await sql`update platform.outbox_items set status = 'pending', lease_owner = null, lease_expires_at = null, available_at = now(), updated_at = now() where scope_type = 'conversation' and scope_id in ('session-kind-a', 'session-kind-b') and operation = 'conversation.sandbox.reconcile.v1'`;
			await sql`insert into platform.outbox_items (id, scope_type, scope_id, operation, payload, trace_id, request_id, available_at, created_at, updated_at, status) select 'conversation:sandbox:' || conversation_id || ':1', 'conversation', conversation_id, 'conversation.sandbox.reconcile.v1', jsonb_build_object('schemaVersion', 1, 'conversationId', conversation_id, 'sessionGeneration', 1), 'trace', 'request', now(), now(), now(), 'pending' from platform.session_sandbox_allocations where conversation_id in ('session-kind-a', 'session-kind-b') on conflict (id) do update set status = 'pending', available_at = now(), lease_owner = null, lease_expires_at = null`;
			const workload: WorkloadRuntimeOptionsV1 = {
				workerId: "kind-session-worker",
				client,
				policy,
				registry: workloadRegistryFixture(),
				admissionPolicyRef: "kind-policy",
				registrySubjectRef: "kind-subject",
				templateModelBindings: [],
				decryptor: {
					decrypt: async () => ({
						outcome: "failed",
						code: "SECRET_KEY_UNAVAILABLE",
					}),
				},
				probeRuntime: async () => ({ core: "passed", capabilities: {} }),
			};
			const receiveSandbox = createProductionSessionSandboxReceiverV1(workload);
			const keys = generateKeyPairSync("ed25519");
			worker = createPlatformConversationWorkerV2({
				databaseUrl: database.databaseUrl,
				workerId: "kind-session-worker",
				signing: {
					issuer: "kind",
					workerId: "kind-session-worker",
					keyId: "kind-key",
					privateKey: keys.privateKey,
				},
				directory: {
					resolveUser: async (userId) => ({
						schemaVersion: 1,
						userId,
						accountStatus: "active",
						organizationIds: [],
						authorizationRevision: "kind",
					}),
				},
				resolveRuntimeHost: async () => ({
					baseUrl: "http://unused.invalid",
					serviceToken: "kind",
					workerId: "kind-session-worker",
				}),
				sandboxPolicy: {
					namespace,
					resourceConfigurationHash:
						workloadResourceConfigurationHashV1(policy),
				},
				receiveSandbox,
				signal: controller.signal,
				pollIntervalMs: 100,
				leaseDurationMs: 30_000,
				log: () => undefined,
			});
			worker.start();
			const readyRows = await eventually(
				async () =>
					sql`select sandbox_id, conversation_id, agent_id, resource_name, session_generation, resource_fence, status, resource_observation from platform.session_sandbox_allocations where conversation_id in ('session-kind-a', 'session-kind-b') order by conversation_id`,
				(rows) =>
					rows.length === 2 && rows.every((row) => row.status === "ready"),
			);
			const observations = readyRows.map(
				(row) =>
					row.resource_observation as {
						resources: Array<{
							kind: string;
							name: string;
							namespace: string;
							uid: string;
							resourceVersion: string;
						}>;
					},
			);
			for (const observation of observations) {
				expect(observation.resources).toHaveLength(5);
				expect(
					new Set(observation.resources.map((resource) => resource.kind)),
				).toEqual(
					new Set([
						"Pod",
						"Service",
						"ServiceAccount",
						"PersistentVolumeClaim",
						"NetworkPolicy",
					]),
				);
				for (const resource of observation.resources) {
					expect(resource.namespace).toBe(namespace);
					expect(resource.uid).toBeTruthy();
					expect(resource.resourceVersion).toBeTruthy();
				}
			}
			expect(new Set(readyRows.map((row) => row.resource_name)).size).toBe(2);
			for (const row of readyRows) {
				const observation = row.resource_observation as {
					resources: Array<{
						kind: string;
						name: string;
						uid: string;
						resourceVersion: string;
					}>;
				};
				for (const identity of observation.resources) {
					const resource = await client.read(
						identity.kind as Parameters<typeof client.read>[0],
						identity.name,
					);
					expect(resource?.metadata?.labels).toMatchObject(
						sessionSandboxLabelsV1({
							agentId: row.agent_id,
							sessionId: row.conversation_id,
							sandboxId: row.sandbox_id,
							generation: Number(row.session_generation),
						}),
					);
					expect(resource?.metadata?.annotations).toMatchObject({
						"agent-infra.agora.io/agent-id": row.agent_id,
						"agent-infra.agora.io/session-id": row.conversation_id,
						"agent-infra.agora.io/managed": "session-sandbox-v1",
						"agent-infra.agora.io/fence": String(row.resource_fence),
					});
				}
			}
			const [a, b] = readyRows.map((row) => row.resource_name as string);
			assert(a && b);
			const workerProbe = "session-worker-probe";
			await kubectl(
				"run",
				workerProbe,
				"--image",
				`${imageRepository}@${imageDigest}`,
				"--restart=Never",
				"--labels",
				"component=worker",
				"--command",
				"--",
				"node",
				"-e",
				"setInterval(()=>{},60000)",
			);
			await kubectl(
				"wait",
				"pods",
				"--all",
				"--for=condition=Ready",
				"--timeout=120s",
			);
			for (const target of [a, b])
				await kubectl(
					"exec",
					workerProbe,
					"--",
					"node",
					"-e",
					`fetch('http://${target}.${namespace}.svc:8080/healthz',{signal:AbortSignal.timeout(2500)}).then(async r=>{const body=await r.json();if(r.status!==200||body.marker!=='retained')process.exit(2)}).catch(()=>process.exit(3))`,
				);
			for (const pod of [a, b])
				await kubectl(
					"exec",
					pod,
					"--",
					"node",
					"-e",
					"fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(2500)}).then(async r=>{const body=await r.json();if(r.status!==200||body.marker!=='retained')process.exit(2)}).catch(()=>process.exit(3))",
				);
			const podA = await client.read<V1Pod>("Pod", a);
			const podB = await client.read<V1Pod>("Pod", b);
			assert(podA?.status?.podIP && podB?.status?.podIP);
			for (const [source, targetIp] of [
				[a, podB.status.podIP],
				[b, podA.status.podIP],
			] as const) {
				const result = await execFile(
					"kubectl",
					[
						...kubeArgs(),
						"--namespace",
						namespace,
						"exec",
						source,
						"--",
						"node",
						"-e",
						`fetch('http://${targetIp}:8080/healthz',{signal:AbortSignal.timeout(2500)}).then(()=>process.exit(2)).catch(error=>{if(error.name==='TimeoutError'){console.log('DENIED_NETWORK_POLICY');process.exit(0)}console.error('UNEXPECTED_FETCH_FAILURE',error.name);process.exit(3)})`,
					],
					{ timeout: 30_000 },
				);
				expect(result.stdout.trim()).toMatch(
					/^DENIED_(HTTP_403|NETWORK_POLICY)$/,
				);
			}
			const managementTransaction = new PostgresAgentManagementTransactionV1({
				databaseUrl: database.databaseUrl,
			});
			try {
				const management = createAgentManagementV1(managementTransaction);
				await management.executeManagementCommand(
					{
						schemaVersion: 1,
						command: "stop_agent",
						agentId: "agent-kind",
						expectedRevision: 1,
						idempotencyKey: "kind-stop",
						requestId: "request-kind-stop",
						traceId: "trace-kind-stop",
					},
					{
						schemaVersion: 1,
						userId: "actor-session-kind-a",
						accountStatus: "active",
						organizationIds: [],
						isAdministrator: false,
					},
				);
			} finally {
				await managementTransaction.close();
			}
			const stoppedRows = await eventually(
				async () =>
					sql`select sandbox_id, resource_name, status, resource_observation from platform.session_sandbox_allocations where conversation_id in ('session-kind-a', 'session-kind-b') order by conversation_id`,
				(rows) =>
					rows.length === 2 && rows.every((row) => row.status === "stopped"),
			);
			for (const row of stoppedRows) {
				expect(
					await client.read("Pod", row.resource_name as string),
				).toBeNull();
				expect(
					await client.read("Service", row.resource_name as string),
				).toBeNull();
				expect(
					await client.read("ServiceAccount", row.resource_name as string),
				).toBeNull();
				expect(
					await client.read("NetworkPolicy", row.resource_name as string),
				).toBeNull();
				expect(
					await client.read(
						"PersistentVolumeClaim",
						row.resource_name as string,
					),
				).not.toBeNull();
				expect(
					(
						row.resource_observation as { resources: Array<{ kind: string }> }
					).resources.map((resource) => resource.kind),
				).toEqual(["PersistentVolumeClaim"]);
			}
			await mkdir(evidenceDirectory, { recursive: true });
			await writeFile(
				`${evidenceDirectory}/session-sandbox-isolation.json`,
				`${JSON.stringify({ schemaVersion: 1, namespace, context: process.env.WORKLOAD_KIND_CONTEXT, databaseRows: readyRows, stoppedRows, crossSessionAccess: "denied", lifecycle: "stopped-with-retained-PVC", evidenceKind: "controlled-runtime" }, null, 2)}\n`,
			);
			await kubectl(
				"delete",
				"pod",
				workerProbe,
				"--ignore-not-found=true",
			).catch((error) => {
				console.warn("SESSION_SANDBOX_PROBE_CLEANUP_FAILED", error);
			});
		} finally {
			controller.abort();
			if (worker) await worker.stop().catch(() => undefined);
			await sql`delete from platform.session_sandbox_allocations where conversation_id in ('session-kind-a', 'session-kind-b')`;
			await sql`delete from platform.conversation_audit_events where conversation_id in ('session-kind-a', 'session-kind-b')`;
			await sql`delete from platform.conversations where id in ('session-kind-a', 'session-kind-b')`;
			await sql.end();
			await database.stop();
			await execFile(
				"kubectl",
				[
					...kubeArgs(),
					"delete",
					"namespace",
					namespace,
					"--ignore-not-found=true",
					"--wait=true",
				],
				{ timeout: 120_000 },
			).catch((error) => {
				console.warn("SESSION_SANDBOX_NAMESPACE_CLEANUP_FAILED", error);
			});
		}
	}, 600_000);
});
