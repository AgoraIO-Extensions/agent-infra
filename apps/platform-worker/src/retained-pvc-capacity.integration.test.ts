import { generateKeyPairSync } from "node:crypto";
import {
	createAgentManagementV1,
	decideConversationDispatchCapacityV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentManagementTransactionV1,
	PostgresOperationsResourceStoreV2,
} from "@agent-infra/platform-store";
import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import { seedStandardWorkloadHostV1 } from "../../../tests/fixtures/standard-workload-host-deployment.js";
import {
	fakeKubernetesApi,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";
import { createPlatformWorkloadWorkerV1 } from "./workload-worker.js";

it.each([false, true])(
	"keeps dispatch capacity through promotion and restart with PVC UID writes=%s",
	async (enabled) => {
		const database = await startPostgresTestDatabase("pvc-capacity");
		const sql = postgres(database.databaseUrl, { onnotice: () => undefined });
		const ops = new PostgresOperationsResourceStoreV2({
			databaseUrl: database.databaseUrl,
			scope: {
				namespace: workloadTestPolicy.namespace,
				clusterId: "fixture",
			},
			workloadNamespaceRef: workloadTestPolicy.namespaceRef,
		});
		const management = new PostgresAgentManagementTransactionV1(database);
		let worker: ReturnType<typeof createPlatformWorkloadWorkerV1> | undefined;
		try {
			await migratePlatformDatabase(database);
			const imageDigest = `sha256:${"a".repeat(64)}`;
			const { agentId, configuration, workerOptions } =
				await seedStandardWorkloadHostV1(database.databaseUrl, imageDigest);
			const custom = {
				...configuration,
				source: {
					kind: "custom",
					imageDigest,
					admissionRevision: "fixture",
					interactionMode: "platform-adapter",
					connectionEnabled: false,
				},
				modelConfiguration: null,
			};
			await sql`update platform.agent_configuration_revisions set configuration=${sql.json(custom)} where agent_id=${agentId}`;
			const kube = fakeKubernetesApi();
			const name = `${workloadResourceNameV1(agentId)}-data`;
			const client = {
				...kube.client,
				async read<T extends Parameters<typeof kube.seed>[0]>(
					kind: Parameters<typeof kube.client.read>[0],
					name: string,
				) {
					const object = await kube.client.read<T>(kind, name);
					if (object && kind === "PersistentVolumeClaim")
						(object as V1PersistentVolumeClaim).status = { phase: "Bound" };
					return object;
				},
			};
			const { publicKey } = generateKeyPairSync("ed25519");
			const workerId = "pvc-worker";
			const policy = {
				...workloadTestPolicy,
				runtimeAuth: {
					workerId,
					grantKeyId: "pvc-grant",
					grantIssuer: "pvc-issuer",
					grantPublicKey: publicKey
						.export({ type: "spki", format: "pem" })
						.toString(),
					serviceTokenSecret: { name: "pvc-runtime-token", key: "token" },
				},
			};
			kube.seed({
				apiVersion: "v1",
				kind: "Secret",
				metadata: { name: "pvc-runtime-token", namespace: policy.namespace },
				immutable: true,
				data: { token: "Zml4dHVyZQ==" },
			} as Parameters<typeof kube.seed>[0]);
			const options = {
				...workerOptions,
				workerId,
				client,
				policy,
				retainedPvcIdentityWrites: enabled,
				registry: workloadRegistryFixture({
					schemaVersion: 1,
					interactionMode: "platform-adapter",
					protocol: "acp",
					service: { port: 3003 },
					health: { path: "/healthz" },
				}),
				executionCapacityProfiles: [
					{
						schemaVersion: 1 as const,
						imageDigest,
						resourceProfileRef: policy.resourceProfileRef,
						resourceConfigurationHash:
							workloadResourceConfigurationHashV1(policy),
						maximumConcurrentExecutions: 1,
						conformanceEvidenceHash: "b".repeat(64),
					},
				],
				fetch: async () => new Response(null, { status: 200 }),
				probeRuntime: async () => ({
					core: "passed" as const,
					capabilities: {},
				}),
				pollIntervalMs: 1,
			};
			worker = createPlatformWorkloadWorkerV1(options);
			async function converge(
				phase: "ready" | "stopped",
				lifecycleRevision: number,
			) {
				for (let attempt = 0; attempt < 45; attempt++) {
					await sql`update platform.workload_reconciliations set next_attempt_at=clock_timestamp() where agent_id=${agentId}`;
					await worker?.tick();
					const [row] = await sql<
						{ state: WorkloadReconciliationStateV1 }[]
					>`select state from platform.workload_reconciliations where agent_id=${agentId}`;
					if (
						row?.state.phase === phase &&
						row.state.sourceLifecycleRevision === lifecycleRevision
					)
						return row.state;
				}
				const [row] =
					await sql`select state->>'phase' as phase,state->>'failureCode' as failure from platform.workload_reconciliations where agent_id=${agentId}`;
				throw new Error(`Workload did not converge: ${JSON.stringify(row)}`);
			}
			async function command(command: "stop_agent" | "restart_agent") {
				const [row] =
					await sql`select management_revision as revision from platform.agent_applications where agent_id=${agentId}`;
				expect(
					await createAgentManagementV1(management).executeManagementCommand(
						{
							schemaVersion: 1,
							command,
							agentId,
							expectedRevision: Number(row?.revision),
							requestId: command,
							traceId: command,
							idempotencyKey: command,
						},
						{
							schemaVersion: 1,
							userId: "selector-host-owner",
							accountStatus: "active",
							organizationIds: [],
							isAdministrator: false,
						},
					),
				).toMatchObject({ outcome: "accepted" });
			}
			function dispatch(workload: WorkloadReconciliationStateV1) {
				return decideConversationDispatchCapacityV1({
					agentId,
					status: workload.phase === "stopped" ? "stopped" : "available",
					desiredState: workload.phase === "stopped" ? "stopped" : "running",
					serviceAvailability: "ready",
					runtimeRevision: 1,
					modelConfigurationRevision: null,
					workloadRevision: workload.sourceLifecycleRevision,
					fence: workload.fence,
					workload,
					deployment: {
						agentId,
						configurationRevision: 1,
						interactionMode: "platform-adapter",
						imageDigest,
						resourceProfileRef: policy.resourceProfileRef,
					},
					occupancy: { processing: 0, unknown: 0 },
				});
			}
			const promoted = await converge("ready", 1);
			const uid = (
				await client.read<V1PersistentVolumeClaim>(
					"PersistentVolumeClaim",
					name,
				)
			)?.metadata?.uid;
			expect(uid).toBeTruthy();
			expect(promoted.verified?.persistentVolumeUid).toBe(
				enabled ? uid : undefined,
			);
			expect(dispatch(promoted)).toBe("admit");

			// Roll back observation writes before stopping and restarting. An already
			// persisted production UID must remain usable and attributable.
			await worker.stop();
			worker = createPlatformWorkloadWorkerV1({
				...options,
				retainedPvcIdentityWrites: false,
			});
			await command("stop_agent");
			const stopped = await converge("stopped", 2);
			expect(dispatch(stopped)).toBe("capacity_unavailable");
			expect(
				(await ops.readBindings()).filter(
					(binding) => binding.agentId === agentId && binding.retainedStorage,
				),
			).toEqual(
				enabled
					? [
							expect.objectContaining({
								identities: [{ kind: "PersistentVolumeClaim", name, uid }],
							}),
						]
					: [],
			);
			await command("restart_agent");
			const restarted = await converge("ready", 3);
			expect(restarted.verified?.persistentVolumeUid).toBe(
				enabled ? uid : undefined,
			);
			expect(
				(
					await client.read<V1PersistentVolumeClaim>(
						"PersistentVolumeClaim",
						name,
					)
				)?.metadata?.uid,
			).toBe(uid);
			expect(dispatch(restarted)).toBe("admit");
		} finally {
			await worker?.stop();
			await management.close();
			await ops.close();
			await sql.end();
			await database.stop();
		}
	},
	45_000,
);
