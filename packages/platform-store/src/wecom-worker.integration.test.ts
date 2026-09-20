import { generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import { expect, it, vi } from "vitest";
import { createPlatformConversationWorkerV2 } from "../../../apps/platform-worker/src/conversation-worker.ts";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "../../../apps/platform-worker/src/kubernetes.fixture.ts";
import { workloadResourceConfigurationHashV1 } from "../../../apps/platform-worker/src/workload-runtime.ts";
import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
} from "../../platform-core/src/wecom-channel.ts";
import {
	createWecomAdapterV1,
	type WecomConfigurationV1,
} from "../../wecom/src/index.ts";
import { wecomCallbackFixtureV1 } from "../../wecom/src/testing.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import { startPostgresTestDatabase } from "./postgres-test.ts";
import { PostgresWecomChannelV1 } from "./wecom-channel.ts";

it.each([false, true])(
	"shared Worker executes a persisted WeCom callback and handles revocation=%s",
	async (revoke) => {
		const db = await startPostgresTestDatabase("wecom-worker");
		const sql = postgres(db.databaseUrl);
		const store = new PostgresWecomChannelV1(db);
		let worker:
			| ReturnType<typeof createPlatformConversationWorkerV2>
			| undefined;
		try {
			await migratePlatformDatabase(db);
			const agentId = "wecom-worker-agent";
			const deployment = workloadDesiredFixture(1, agentId, "internal-only");
			const configuration = {
				schemaVersion: 2,
				agentId,
				revision: 1,
				source: {
					kind: "standard",
					templateId: "codex",
					allowedEnvironmentKeys: [],
					allowedSecretKeys: [],
					platformManagedKeys: [],
					imageDigest: deployment.imageDigest,
					admissionRevision: "admitted",
					connectionEnabled: false,
				},
				modelConfiguration: {
					catalogRevision: "catalog",
					options: [
						{
							optionId: "model",
							endpointId: "endpoint",
							modelId: "model",
							reasoningLevels: ["low"],
							credential: { secretId: "fixture", version: 1, isSet: true },
						},
					],
					defaultOptionId: "model",
					defaultReasoningLevel: "low",
				},
				secrets: [],
				environment: [],
				channels: [{ kind: "wecom_bot", bindingReference: "bot-binding" }],
				channelRevision: "c1",
			};
			const version = {
				configuration,
				deployment,
				executionCapacity: {
					schemaVersion: 1,
					imageDigest: deployment.imageDigest,
					resourceProfileRef: deployment.resourceProfileRef,
					resourceConfigurationHash:
						workloadResourceConfigurationHashV1(workloadTestPolicy),
					maximumConcurrentExecutions: 8,
					conformanceEvidenceHash: "c".repeat(64),
				},
			};
			const state = {
				schemaVersion: 1,
				agentId,
				sourceConfigurationRevision: 1,
				sourceLifecycleRevision: 1,
				revision: 1,
				fence: 1,
				phase: "ready",
				candidate: version,
				verified: version,
				verifiedRevision: 1,
				identity: { uid: "pod", generation: 1 },
				rollback: false,
				failureCode: null,
				attempts: 0,
			};
			await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values (${agentId},1,'a1')`;
			await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,service_availability,workload_revision,fence) values ('application',${agentId},'owner','Fixture','Fixture','available','trace','request',now(),1,1,'running','ready',1,1)`;
			await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values (${agentId},'owner',now())`;
			await sql`insert into platform.agent_availability (agent_id,target_type,target_id) values (${agentId},'organization','company')`;
			await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values (${agentId},1,'fixture',${sql.json(configuration)},now())`;
			await sql`insert into platform.workload_reconciliations (agent_id,revision,state,next_attempt_at) values (${agentId},1,${sql.json(state)},now())`;
			let active = true;
			const user = () => ({
				schemaVersion: 1 as const,
				userId: "company-user",
				accountStatus: active ? ("active" as const) : ("disabled" as const),
				organizationIds: ["company"],
				authorizationRevision: "i1",
			});
			const identity = {
				resolveSender: async () => user(),
				activeUsers: async () => ["owner"],
			};
			const authorization = createWecomAuthorizationV1({
				identity,
				state: store,
			});
			const channel = createWecomChannelV1({ authorization, store });
			const config: WecomConfigurationV1 = {
				agentId,
				bindingReference: "bot-binding",
				kind: "wecom_bot",
				botId: "bot",
				token: "fixture",
				encodingAesKey: Buffer.alloc(32, 9).toString("base64").slice(0, 43),
				credentialVersion: "v1",
			};
			const callback = await createWecomAdapterV1({
				protectReply: async () => "encrypted-fixture",
			}).receive(
				config,
				wecomCallbackFixtureV1(
					config,
					{
						aibotid: "bot",
						msgid: "event",
						chattype: "group",
						chatid: "group",
						from: { userid: "provider-user" },
						msgtype: "text",
						text: { content: "controlled integration input" },
						response_url:
							"https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=fixture",
					},
					new Date(),
				),
			);
			if (callback.type !== "message") throw new Error("Expected message");
			const accepted = await channel.receive(callback.message);
			if (accepted.outcome !== "accepted") throw new Error("Expected accepted");
			expect((await channel.receive(callback.message)).outcome).toBe(
				"replayed",
			);
			const sent = vi.fn(async () => "sent" as const);
			const observed: string[] = [];
			let submissions = 0;
			const fetcher: typeof fetch = async (url, init) => {
				const body = JSON.parse(String(init?.body));
				const executionId = body.executionId;
				if (String(url).endsWith("/events/ack"))
					return Response.json({
						schemaVersion: 3,
						executionId,
						confirmedCursor: body.confirmedCursor,
					});
				if (String(url).endsWith("/events/stream")) {
					const base = {
						schemaVersion: 1,
						executionId,
						occurredAt: new Date().toISOString(),
					};
					const events = [
						...(!revoke
							? [
									{
										...base,
										adapterEventKey: "text",
										cursor: "text",
										type: "text",
										payload: { delta: "controlled reply" },
									},
								]
							: []),
						{
							...base,
							adapterEventKey: "done",
							cursor: "done",
							type: "completed",
							payload: { status: revoke ? "cancelled" : "completed" },
						},
					];
					return new Response(
						events
							.map(
								(e) =>
									`id: ${e.cursor}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
							)
							.join(""),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				if (String(url).endsWith("/status"))
					return Response.json({
						schemaVersion: 3,
						outcome: "found",
						executionId,
						hostSessionRef: "host",
						status: revoke ? "cancelled" : "running",
					});
				if (String(url).endsWith("/turns")) {
					submissions++;
					if (revoke) active = false;
				}
				return Response.json({
					schemaVersion: 3,
					hostSessionRef: "host",
					operationId: body.operation.id,
					result: { outcome: "accepted", status: "running" },
				});
			};
			const opts = {
				databaseUrl: db.databaseUrl,
				workerId: "instance",
				signing: {
					issuer: "platform",
					workerId: "transport",
					keyId: "key",
					privateKey: generateKeyPairSync("ed25519").privateKey,
				},
				directory: { resolveUser: async () => user() },
				resolveRuntimeHost: async () => ({
					baseUrl: "http://runtime.test",
					serviceToken: "fixture",
					workerId: "transport",
				}),
				fetch: fetcher,
				pollIntervalMs: 25,
				retryDelayMs: 25,
				wecom: {
					identity,
					sender: { send: sent },
					observe: (status: string) => observed.push(status),
				},
				log: () => {},
			};
			worker = createPlatformConversationWorkerV2(opts);
			worker.start();
			await vi.waitFor(
				async () =>
					expect(
						await store.read(accepted.receipt.receiptId, "company-user"),
					).toMatchObject({ deliveryStatus: revoke ? "cancelled" : "sent" }),
				{ timeout: 15000, interval: 50 },
			);
			expect(submissions).toBe(1);
			if (revoke) {
				expect(sent).not.toHaveBeenCalled();
				expect(
					await sql`select id from platform.task_control_records where execution_id=${accepted.receipt.executionId} and reason='authorization_revoked'`,
				).toHaveLength(1);
			} else {
				expect(sent).toHaveBeenCalledTimes(1);
				expect(sent).toHaveBeenCalledWith(
					expect.objectContaining({ text: "controlled reply" }),
				);
				expect(observed).toContain("sent");
			}
			await worker.stop();
			worker = createPlatformConversationWorkerV2(opts);
			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(submissions).toBe(1);
			expect(sent).toHaveBeenCalledTimes(revoke ? 0 : 1);
		} finally {
			await worker?.stop();
			await store.close();
			await sql.end();
			await db.stop();
		}
	},
	30000,
);
