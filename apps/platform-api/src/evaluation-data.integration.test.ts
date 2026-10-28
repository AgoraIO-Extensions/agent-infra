import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	EvaluationDatasetPageV1Schema,
	EvaluationDatasetV1Schema,
	EvaluationGrantV1Schema,
	EvaluationVersionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createEvaluationDataV1,
	evaluationRetainedMetadataFieldsV1,
	parseEvaluationPolicyV1,
} from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresEvaluationDataStoreV1,
	PostgresScopedPlatformAuditQueryV1,
} from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMinioFileFixtureV1 } from "../../../packages/object-storage/src/minio.test-support.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createEvaluationDataWorkerV1 } from "../../platform-worker/src/evaluation-data-worker.js";
import { createClient } from "../../web/src/pilot/generated-v2/client/index.js";
import {
	createEvaluationDatasetV1,
	grantEvaluationPurposeV1,
	readEvaluationContentV1,
	reserveEvaluationVersionV1,
	uploadEvaluationContentV1,
} from "../../web/src/pilot/generated-v2/sdk.gen.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi } from "./assembly.js";
import { registerEvaluationDataRoutesV1 } from "./http/evaluation-data-routes.js";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "./index.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresEvaluationDataStoreV1;
let storage: Awaited<ReturnType<typeof startMinioFileFixtureV1>>;
let worker: ReturnType<typeof createEvaluationDataWorkerV1>;
let app: Hono;
let policy: ReturnType<typeof parseEvaluationPolicyV1>;
let disabled = false;
let afterUpload: (() => Promise<void>) | undefined;
let afterDownload: (() => Promise<void>) | undefined;
let afterPolicyRead: (() => Promise<void>) | undefined;
let firstPolicyOverride: typeof policy | undefined;
const admin = { kind: "user" as const, id: "admin" };
const content = {
	schemaVersion: 1 as const,
	provenance: { approvalId: "synthetic-fixture" },
	samples: [
		{
			id: "a",
			input: "line one\nline two",
			context: null,
			taskType: "answer",
			expectedResult: "yes",
		},
	],
	rubric: [{ id: "relevance", description: "Answer question\nRespect format" }],
};
async function call(
	path: string,
	method = "GET",
	body?: unknown,
	user = "admin",
	key: string = randomUUID(),
) {
	return app.request(`http://localhost/api/v2/evaluation/datasets${path}`, {
		method,
		headers: {
			Cookie: `session=${user}`,
			"Content-Type": "application/json",
			"Idempotency-Key": key,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
async function json(
	path: string,
	method = "GET",
	body?: unknown,
	user = "admin",
	key?: string,
) {
	const response = await call(path, method, body, user, key);
	const value = await response.json();
	expect(response.status, JSON.stringify(value)).toBeLessThan(300);
	return value;
}
async function dataset() {
	const d = EvaluationDatasetV1Schema.parse(
		await json("", "POST", {
			scope: "team",
			name: "Synthetic evaluation",
		}),
	);
	const v = EvaluationVersionV1Schema.parse(
		await json(`/${d.datasetId}/versions`, "POST", {
			expectedRevision: 1,
			sourceVersionId: null,
		}),
	);
	return { d, v };
}
async function grant(
	datasetId: string,
	versionId: string,
	user = "alice",
	kind: "user" | "application" = "user",
) {
	const page = EvaluationDatasetPageV1Schema.parse(await json(""));
	const d = page.items.find(
		(x: { datasetId: string }) => x.datasetId === datasetId,
	);
	if (!d) throw new Error("fixture dataset missing");
	return EvaluationGrantV1Schema.parse(
		await json(`/${datasetId}/grants`, "POST", {
			expectedRevision: d.revision,
			principal: { kind, id: user },
			versionIds: [versionId],
			operations: ["import", "read", "delete"],
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		}),
	);
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("eval-3638");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl);
	storage = await startMinioFileFixtureV1("file", "eval");
	const retention = {
		contentMs: 120000,
		metadataMs: 240000,
		deleteWithinMs: 10000,
	};
	policy = parseEvaluationPolicyV1({
		schemaVersion: 1,
		policyId: "test-eval",
		revision: 1,
		validUntil: new Date(Date.now() + 600000).toISOString(),
		retainedMetadataFields: evaluationRetainedMetadataFieldsV1,
		materialApprovals: [
			{
				approvalId: "synthetic-fixture",
				scope: "team",
				kind: "synthetic",
				redactionRef: null,
			},
			{
				approvalId: "approved-fixture",
				scope: "team",
				kind: "approved",
				redactionRef: "redaction-fixture",
			},
		],
		managers: [
			{
				principal: admin,
				scopes: ["team"],
				operations: ["create", "import", "manage_grants", "read", "delete"],
				maxGrantMs: 120000,
			},
		],
		retention: {
			samples: { ...retention, startsAt: "version_reserved" },
			rubric: { ...retention, startsAt: "version_reserved" },
			output: { ...retention, startsAt: "content_created" },
			score: { ...retention, startsAt: "content_created" },
			review: { ...retention, startsAt: "content_created" },
		},
		maxContentBytes: 65536,
		transferTimeoutMs: 5000,
		pendingMs: 60000,
	});
	store = new PostgresEvaluationDataStoreV1({
		...database,
		directory: {
			resolveUser: async (userId) => ({
				schemaVersion: 1,
				userId,
				accountStatus: disabled ? "disabled" : "active",
				organizationIds: [],
				authorizationRevision: "v1",
			}),
		},
	});
	const service = createEvaluationDataV1({
		store,
		storage: {
			...storage.storage,
			inspect: (objectRef, version) =>
				storage.storage.inspect(objectRef, version),
			async upload(request) {
				const result = await storage.storage.upload(request);
				await afterUpload?.();
				return result;
			},
			async download(request) {
				const result = await storage.storage.download(request);
				await afterDownload?.();
				return result;
			},
		},
		loadPolicy: async () => {
			const current = firstPolicyOverride ?? policy;
			firstPolicyOverride = undefined;
			await afterPolicyRead?.();
			return current;
		},
	});
	app = new Hono();
	registerEvaluationDataRoutesV1(app, {
		service,
		identity: {
			resolve: async (request) => ({
				schemaVersion: 1,
				userId: request.headers.get("Cookie")?.split("=")[1],
				displayName: "Synthetic",
				accountStatus: "active",
				organizationIds: [],
				roles: ["employee"],
				authorizationRevision: "v1",
			}),
			hydrateUsers: async () => [],
		},
	});
	worker = createEvaluationDataWorkerV1({
		...database,
		storage: storage.storage,
		batchSize: 10,
		timeoutMs: 5000,
	});
}, 120000);
afterAll(async () => {
	await worker?.close();
	await store?.close();
	await storage?.close();
	await sql?.end();
	await database?.stop();
});

describe("Eval data authority with real PG and versioned S3", {
	timeout: 30_000,
}, () => {
	it("requires an explicit version grant before creator or another user can upload/read", async () => {
		const { d, v } = await dataset();
		expect(
			(
				await call(
					`/${d.datasetId}/versions/${v.versionId}/content`,
					"PUT",
					content,
				)
			).status,
		).toBe(404);
		const g = await grant(d.datasetId, v.versionId);
		const uploaded = EvaluationVersionV1Schema.parse(
			await json(
				`/${d.datasetId}/versions/${v.versionId}/content`,
				"PUT",
				content,
				"alice",
			),
		);
		expect(uploaded.status).toBe("available");
		expect(
			await json(
				`/${d.datasetId}/versions/${v.versionId}/content`,
				"GET",
				undefined,
				"alice",
			),
		).toEqual(content);
		expect(
			(
				await call(
					`/${d.datasetId}/versions/${v.versionId}/content`,
					"GET",
					undefined,
					"bob",
				)
			).status,
		).toBe(404);
		expect(
			(await call(`/${d.datasetId}/versions/${v.versionId}/content`)).status,
		).toBe(404);
		const rows =
			await sql`select details from platform.audit_events where action like 'evaluation.%'`;
		expect(JSON.stringify(rows)).not.toContain("line one");
		expect(JSON.stringify(await json(""))).not.toContain("objectRef");
		await json(`/${d.datasetId}/grants/${g.grantId}`, "DELETE", {
			expectedRevision: 1,
		});
		expect(
			(
				await call(
					`/${d.datasetId}/versions/${v.versionId}/content`,
					"GET",
					undefined,
					"alice",
				)
			).status,
		).toBe(404);
	}, 30_000);
	it("preserves immutable versions, rejects stale CAS and replays only original intent", async () => {
		const key = randomUUID();
		const d = EvaluationDatasetV1Schema.parse(
			await json("", "POST", { scope: "team", name: "Replay" }, "admin", key),
		);
		expect(
			await json("", "POST", { scope: "team", name: "Replay" }, "admin", key),
		).toEqual(d);
		expect(
			(
				await call(
					"",
					"POST",
					{ scope: "team", name: "Conflict" },
					"admin",
					key,
				)
			).status,
		).toBe(409);
		const v = EvaluationVersionV1Schema.parse(
			await json(`/${d.datasetId}/versions`, "POST", {
				expectedRevision: 1,
				sourceVersionId: null,
			}),
		);
		await grant(d.datasetId, v.versionId);
		await json(
			`/${d.datasetId}/versions/${v.versionId}/content`,
			"PUT",
			content,
			"alice",
		);
		expect(
			(
				await call(
					`/${d.datasetId}/versions/${v.versionId}/content`,
					"PUT",
					{ ...content, rubric: [] },
					"alice",
				)
			).status,
		).toBe(400);
		expect(
			(
				await call(`/${d.datasetId}/versions`, "POST", {
					expectedRevision: 1,
					sourceVersionId: v.versionId,
				})
			).status,
		).toBe(409);
		const page = EvaluationDatasetPageV1Schema.parse(await json(""));
		const revision = page.items.find(
			(x: { datasetId: string }) => x.datasetId === d.datasetId,
		)?.revision;
		if (revision === undefined) throw new Error("fixture dataset missing");
		const next = EvaluationVersionV1Schema.parse(
			await json(`/${d.datasetId}/versions`, "POST", {
				expectedRevision: revision,
				sourceVersionId: v.versionId,
			}),
		);
		expect(
			(
				await call(
					`/${d.datasetId}/versions/${next.versionId}/content`,
					"GET",
					undefined,
					"alice",
				)
			).status,
		).toBe(404);
	});
	it("denies content immediately and fulfills exact deletion without a current data policy", async () => {
		const { d, v } = await dataset();
		await grant(d.datasetId, v.versionId);
		const uploaded = EvaluationVersionV1Schema.parse(
			await json(
				`/${d.datasetId}/versions/${v.versionId}/content`,
				"PUT",
				content,
				"alice",
			),
		);
		const [row] =
			await sql`select data from platform.evaluation_versions where id=${v.versionId}`;
		const preserved = row?.data;
		const deleteKey = randomUUID();
		const deletion = EvaluationVersionV1Schema.parse(
			await json(
				`/${d.datasetId}/versions/${v.versionId}/content`,
				"DELETE",
				{ expectedRevision: uploaded.revision },
				"alice",
				deleteKey,
			),
		);
		expect(
			(
				await call(
					`/${d.datasetId}/versions/${v.versionId}/content`,
					"GET",
					undefined,
					"alice",
				)
			).status,
		).toBe(404);
		const old = policy;
		policy = undefined as unknown as typeof policy;
		try {
			await worker.runOnce();
		} finally {
			policy = old;
		}
		expect(await storage.storage.inspect(preserved.objectRef)).toBeNull();
		const [deleted] =
			await sql`select data from platform.evaluation_versions where id=${v.versionId}`;
		expect(deleted?.data.status).toBe("deleted");
		expect(deleted?.data.stored).toBeNull();
		expect(
			await json(
				`/${d.datasetId}/versions/${v.versionId}/content`,
				"DELETE",
				{ expectedRevision: uploaded.revision },
				"alice",
				deleteKey,
			),
		).toEqual(deletion);
		expect(
			(
				await call(
					`/${d.datasetId}/versions/${v.versionId}/content`,
					"DELETE",
					{ expectedRevision: uploaded.revision },
					"bob",
					deleteKey,
				)
			).status,
		).toBe(404);
	});
	it("rejects API credentials without purpose grants and refuses mixed/caller-selected identities", async () => {
		const material = `papi_${"A".repeat(43)}`;
		await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('eval-app','Evaluation','admin','v1')`;
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values('eval-credential','application','eval-app',${createHash("sha256").update(material).digest("hex")},${sql.json(["eval:data"])})`;
		const { d, v } = await dataset();
		await grant(d.datasetId, v.versionId, "eval-app", "application");
		const path = `/api/v2/evaluation/datasets/${d.datasetId}/versions/${v.versionId}/content`;
		const response = await app.request(`http://localhost${path}`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${material}`,
				"Content-Type": "application/json",
				"Idempotency-Key": randomUUID(),
			},
			body: JSON.stringify(content),
		});
		expect(response.status, await response.text()).toBe(200);
		expect(
			(
				await app.request(`http://localhost${path}`, {
					headers: {
						Authorization: `Bearer ${material}`,
						Cookie: "session=admin",
					},
				})
			).status,
		).toBe(401);
		expect(
			(
				await app.request(`http://localhost${path}`, {
					headers: { Cookie: "session=alice", "x-principal-id": "eval-app" },
				})
			).status,
		).toBe(400);
	});
	it("requires eval:data explicitly and rechecks scope, application state, expiry and revocation", async () => {
		const material = `papi_${"B".repeat(43)}`;
		await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('scope-app','Evaluation','admin','v1')`;
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values('scope-credential','application','scope-app',${createHash("sha256").update(material).digest("hex")},${sql.json(["agent:use", "agent:read"])})`;
		const { d, v } = await dataset();
		await grant(d.datasetId, v.versionId, "alice");
		await json(
			`/${d.datasetId}/versions/${v.versionId}/content`,
			"PUT",
			content,
			"alice",
		);
		await grant(d.datasetId, v.versionId, "scope-app", "application");
		const read = () =>
			app.request(
				`http://localhost/api/v2/evaluation/datasets/${d.datasetId}/versions/${v.versionId}/content`,
				{ headers: { Authorization: `Bearer ${material}` } },
			);
		expect((await read()).status).toBe(404);
		await sql`update platform.platform_api_credentials set scopes=${sql.json(["eval:data"])} where id='scope-credential'`;
		expect((await read()).status).toBe(200);
		await sql`update platform.platform_applications set status='disabled', authorization_revision='v2' where id='scope-app'`;
		expect((await read()).status).toBe(404);
		await sql`update platform.platform_applications set status='active', authorization_revision='v3' where id='scope-app'`;
		await sql`update platform.platform_api_credentials set expires_at=clock_timestamp()-interval '1 second' where id='scope-credential'`;
		expect((await read()).status).toBe(404);
		await sql`update platform.platform_api_credentials set expires_at=null, revoked_at=clock_timestamp() where id='scope-credential'`;
		expect((await read()).status).toBe(404);
	});
	it("does not expose bytes when a grant is revoked during transfer, and cleanup survives policy outage", async () => {
		const { d, v } = await dataset();
		const g = await grant(d.datasetId, v.versionId);
		const path = `/${d.datasetId}/versions/${v.versionId}/content`;
		afterUpload = async () => {
			afterUpload = undefined;
			await json(`/${d.datasetId}/grants/${g.grantId}`, "DELETE", {
				expectedRevision: g.revision,
			});
		};
		try {
			expect((await call(path, "PUT", content, "alice")).status).toBe(404);
		} finally {
			afterUpload = undefined;
		}
		expect((await call(path, "GET", undefined, "alice")).status).toBe(404);
		const [row] =
			await sql`select data from platform.evaluation_versions where id=${v.versionId}`;
		expect(row?.data.status).toBe("uploading");
		await sql`update platform.evaluation_versions set expires_at=clock_timestamp()-interval '1 second', data=jsonb_set(jsonb_set(data,'{expiresAt}',to_jsonb(to_char(clock_timestamp()-interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),'{transferUntil}','null'::jsonb) where id=${v.versionId}`;
		// Keep indexed and JSON timestamps exactly aligned for the strict decoder.
		await sql`update platform.evaluation_versions set expires_at=(data->>'expiresAt')::timestamptz where id=${v.versionId}`;
		const originalPolicy = policy;
		try {
			policy = undefined as unknown as typeof policy;
			await worker.runOnce();
		} finally {
			policy = originalPolicy;
		}
		expect(await storage.storage.inspect(row?.data.objectRef)).toBeNull();
	});
	it("rejects a late content read after revocation and does not leak the response body", async () => {
		const { d, v } = await dataset();
		const g = await grant(d.datasetId, v.versionId);
		const path = `/${d.datasetId}/versions/${v.versionId}/content`;
		await json(path, "PUT", content, "alice");
		afterDownload = async () => {
			afterDownload = undefined;
			await json(`/${d.datasetId}/grants/${g.grantId}`, "DELETE", {
				expectedRevision: g.revision,
			});
		};
		try {
			const response = await call(path, "GET", undefined, "alice");
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("line one");
		} finally {
			afterDownload = undefined;
		}
	});
	it("fails closed on corrupted persisted identities and audit failure, and rejects malformed API identifiers", async () => {
		const { d, v } = await dataset();
		await grant(d.datasetId, v.versionId);
		const path = `/${d.datasetId}/versions/${v.versionId}/content`;
		await json(path, "PUT", content, "alice");
		const [original] =
			await sql`select data from platform.evaluation_versions where id=${v.versionId}`;
		try {
			await sql`update platform.evaluation_versions set data=jsonb_set(data,'{versionId}',to_jsonb(${randomUUID()}::text)) where id=${v.versionId}`;
			expect((await call(path, "GET", undefined, "alice")).status).toBe(503);
		} finally {
			await sql`update platform.evaluation_versions set data=${sql.json(original?.data)} where id=${v.versionId}`;
		}
		await sql.unsafe(
			`create function platform.eval_test_audit_reject() returns trigger language plpgsql as $$ begin if new.action='evaluation.content.read' then raise exception 'synthetic audit rejection'; end if; return new; end $$`,
		);
		await sql.unsafe(
			"create trigger eval_test_audit_reject before insert on platform.audit_events for each row execute function platform.eval_test_audit_reject()",
		);
		try {
			const response = await call(path, "GET", undefined, "alice");
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain("line one");
		} finally {
			await sql.unsafe(
				"drop trigger eval_test_audit_reject on platform.audit_events",
			);
			await sql.unsafe("drop function platform.eval_test_audit_reject()");
		}
		expect((await call("/bad/versions/bad/content")).status).toBe(400);
		disabled = true;
		try {
			expect((await call(path, "GET", undefined, "alice")).status).toBe(404);
		} finally {
			disabled = false;
		}
	});
	it("runs the production assembly over HTTP through the generated client without implicit creator access", async () => {
		const unused = async (): Promise<never> => {
			throw new Error("unused evaluation fixture dependency");
		};
		const identity = {
			resolveUser: async (userId: string) => ({
				schemaVersion: 1,
				userId,
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "v1",
			}),
			resolve: async (request: Request) => ({
				schemaVersion: 1,
				userId: request.headers.get("Cookie")?.split("=")[1] ?? "anonymous",
				displayName: "Synthetic",
				accountStatus: "active",
				organizationIds: [],
				roles: ["employee"],
				authorizationRevision: "v1",
			}),
			hydrateUsers: async () => [],
		};
		const assembly = assemblePlatformApi({
			databaseUrl: database.databaseUrl,
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 2,
				waitingTimeoutMs: 30000,
			},
			identity,
			evaluation: { loadPolicy: async () => policy, storage: storage.storage },
			admissions: {
				authorizationAdmission: { authorize: unused },
				imageAdmission: { admitImage: unused },
				modelAdmission: { admitModels: unused },
				secretAdmission: { admitSecrets: unused },
				channelAdmission: { admitChannels: unused },
			},
			allocateApplicationIds: unused,
			prepareApplicationSecrets: unused,
			prepareConfigurationSecrets: unused,
			presentAgent: unused,
		});
		const httpApp = createPlatformApp(assembly.dependencies);
		const server = serve({
			fetch: httpApp.fetch,
			hostname: "127.0.0.1",
			port: 0,
		});
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("fixture address");
		const adminClient = createClient({
			baseUrl: `http://127.0.0.1:${address.port}`,
			headers: { Cookie: "session=admin" },
		});
		const aliceClient = createClient({
			baseUrl: `http://127.0.0.1:${address.port}`,
			headers: { Cookie: "session=alice" },
		});
		const options = {
			responseStyle: "fields" as const,
			throwOnError: true as const,
		};
		const headers = () => ({ "Idempotency-Key": randomUUID() });
		try {
			const { data: d } = await createEvaluationDatasetV1({
				...options,
				client: adminClient,
				body: { scope: "team", name: "Generated client fixture" },
				headers: headers(),
			});
			const { data: v } = await reserveEvaluationVersionV1({
				...options,
				client: adminClient,
				path: { datasetId: d.datasetId },
				body: { expectedRevision: d.revision, sourceVersionId: null },
				headers: headers(),
			});
			const path = { datasetId: d.datasetId, versionId: v.versionId };
			const denied = await uploadEvaluationContentV1({
				client: adminClient,
				responseStyle: "fields",
				throwOnError: false,
				path,
				body: content,
				headers: headers(),
			});
			expect(denied.response?.status).toBe(404);
			await grantEvaluationPurposeV1({
				...options,
				client: adminClient,
				path: { datasetId: d.datasetId },
				body: {
					expectedRevision: 2,
					principal: { kind: "user", id: "alice" },
					versionIds: [v.versionId],
					operations: ["import", "read"],
					expiresAt: new Date(Date.now() + 60000).toISOString(),
				},
				headers: headers(),
			});
			const { data: uploaded } = await uploadEvaluationContentV1({
				...options,
				client: aliceClient,
				path,
				body: content,
				headers: headers(),
			});
			expect(uploaded.status).toBe("available");
			expect(
				(
					await readEvaluationContentV1({
						...options,
						client: aliceClient,
						path,
					})
				).data,
			).toEqual(content);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await assembly.close();
		}
	}, 30000);

	it.each(["download", "commit"])(
		"rejects grants expiring across the %s boundary using current DB time",
		async (boundary) => {
			const { d, v } = await dataset();
			const g = await grant(d.datasetId, v.versionId);
			const path = `/${d.datasetId}/versions/${v.versionId}/content`;
			await json(path, "PUT", content, "alice");
			await sql`update platform.evaluation_grants set data=jsonb_set(data,'{expiresAt}',to_jsonb(${new Date(Date.now() + 1000).toISOString()}::text)) where id=${g.grantId}`;
			let crossed = false;
			let reads = 0;
			const delay = async () => {
				crossed = true;
				await new Promise((resolve) => setTimeout(resolve, 1100));
			};
			if (boundary === "download") afterDownload = delay;
			else
				afterPolicyRead = async () => {
					if (++reads === 2) await delay();
				};
			try {
				const response = await call(path, "GET", undefined, "alice");
				expect(crossed).toBe(true);
				expect(response.status).toBe(404);
				expect(await response.text()).not.toContain("line one");
			} finally {
				afterDownload = undefined;
				afterPolicyRead = undefined;
			}
		},
		30000,
	);
	it("requires deployment-approved material provenance and exact scope without a synthetic bypass", async () => {
		const { d, v } = await dataset();
		await grant(d.datasetId, v.versionId);
		const path = `/${d.datasetId}/versions/${v.versionId}/content`;
		expect(
			(
				await call(
					path,
					"PUT",
					{ ...content, provenance: { approvalId: "invented" } },
					"alice",
				)
			).status,
		).toBe(404);
		expect(
			(
				await call(
					path,
					"PUT",
					{
						...content,
						provenance: { approvalId: "synthetic-fixture", synthetic: true },
					},
					"alice",
				)
			).status,
		).toBe(400);
		const approved = {
			...content,
			provenance: { approvalId: "approved-fixture" },
		};
		expect((await call(path, "PUT", approved, "alice")).status).toBe(200);
		expect(await json(path, "GET", undefined, "alice")).toEqual(approved);
	});
	it("denies foreign versions, ordinary file proofs, expired grants and delegated grant management", async () => {
		const a = await dataset();
		const b = await dataset();
		await grant(a.d.datasetId, a.v.versionId);
		const body = {
			expectedRevision: 3,
			principal: { kind: "user", id: "bob" },
			versionIds: [a.v.versionId],
			operations: ["read"],
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		};
		expect(
			(await call(`/${a.d.datasetId}/grants`, "POST", body, "alice")).status,
		).toBe(404);
		expect(
			(
				await call(`/${a.d.datasetId}/grants`, "POST", {
					...body,
					operations: ["manage_grants"],
				})
			).status,
		).toBe(404);
		expect(
			(
				await call(`/${a.d.datasetId}/grants`, "POST", {
					...body,
					versionIds: [b.v.versionId],
				})
			).status,
		).toBe(404);
		expect(
			(
				await call(`/${a.d.datasetId}/grants`, "POST", {
					...body,
					versionIds: [a.v.versionId, a.v.versionId],
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(`/${a.d.datasetId}/grants`, "POST", {
					...body,
					expiresAt: new Date(Date.now() - 1000).toISOString(),
				})
			).status,
		).toBe(404);
		expect(
			(
				await call(
					`/${b.d.datasetId}/versions/${a.v.versionId}/content`,
					"GET",
					undefined,
					"alice",
				)
			).status,
		).toBe(404);
		const fileProof = await app.request(
			`http://localhost/api/v2/evaluation/datasets/${a.d.datasetId}/versions/${a.v.versionId}/content`,
			{ headers: { Authorization: "Bearer synthetic-file-access-proof" } },
		);
		expect(fileProof.status).toBe(401);
	});
	it("enforces stricter current retention and cannot roll back the deployment policy checkpoint", async () => {
		const old = policy;
		const { d, v } = await dataset();
		await grant(d.datasetId, v.versionId);
		const path = `/${d.datasetId}/versions/${v.versionId}/content`;
		await json(path, "PUT", content, "alice");
		try {
			policy = {
				...old,
				revision: old.revision + 1,
				retention: {
					...old.retention,
					samples: { ...old.retention.samples, contentMs: 1 },
				},
			};
			await json("");
			await grant(d.datasetId, v.versionId);
			expect((await call(path, "GET", undefined, "alice")).status).toBe(404);
			policy = old;
			expect((await call("")).status).toBe(503);
		} finally {
			policy = { ...old, revision: old.revision + 2 };
		}
	});
	it("recovers deletion after storage failure and worker restart without reading bodies or deleting other objects", async () => {
		const a = await dataset();
		const b = await dataset();
		await grant(a.d.datasetId, a.v.versionId);
		await grant(b.d.datasetId, b.v.versionId);
		const pathA = `/${a.d.datasetId}/versions/${a.v.versionId}/content`;
		const pathB = `/${b.d.datasetId}/versions/${b.v.versionId}/content`;
		const original = EvaluationVersionV1Schema.parse(
			await json(pathA, "PUT", content, "alice"),
		);
		await json(pathB, "PUT", content, "alice");
		await json(
			pathA,
			"DELETE",
			{ expectedRevision: original.revision },
			"alice",
		);
		const scan = storage.storage.scan;
		storage.storage.scan = async (cursor, limit, objectRef) => {
			if (!objectRef) throw new Error("unbounded prefix traversal");
			return scan(cursor, limit, objectRef);
		};
		const remove = storage.storage.remove;
		const inspect = storage.storage.inspect;
		const download = storage.storage.download;
		let bodyReads = 0;
		storage.storage.remove = async () => {
			throw new Error("synthetic delete outage");
		};
		storage.storage.inspect = async () => {
			bodyReads++;
			throw new Error("cleanup must not inspect bodies");
		};
		storage.storage.download = async () => {
			bodyReads++;
			throw new Error("cleanup must not download bodies");
		};
		try {
			await worker.runOnce();
			const [pending] =
				await sql`select status from platform.evaluation_versions where id=${a.v.versionId}`;
			expect(pending?.status).toBe("deleting");
			await worker.close();
			storage.storage.remove = remove;
			worker = createEvaluationDataWorkerV1({
				...database,
				storage: storage.storage,
				batchSize: 10,
				timeoutMs: 5000,
			});
			await sql`update platform.outbox_items set available_at=clock_timestamp() where id=${`evaluation-delete:${a.v.versionId}`}`;
			await worker.runOnce();
			const [deleted] =
				await sql`select status from platform.evaluation_versions where id=${a.v.versionId}`;
			expect(deleted?.status).toBe("deleted");
			expect(bodyReads).toBe(0);
		} finally {
			storage.storage.scan = scan;
			storage.storage.remove = remove;
			storage.storage.inspect = inspect;
			storage.storage.download = download;
		}
		expect((await call(pathA, "GET", undefined, "alice")).status).toBe(404);
		expect(await json(pathB, "GET", undefined, "alice")).toEqual(content);
	});

	it("projects bounded Eval governance audit metadata and refuses corrupted extra content", async () => {
		const { d } = await dataset();
		const [row] =
			await sql`select id from platform.audit_events where action='evaluation.dataset.create' and target_id='team' order by occurred_at desc limit 1`;
		const query = new PostgresScopedPlatformAuditQueryV1(database);
		try {
			const scope = {
				kind: "administrator" as const,
				administratorId: "admin",
			};
			const request = { requestId: randomUUID(), traceId: randomUUID() };
			const projection = await query.getAudit(
				scope,
				row?.id,
				{ limit: 1, filters: {} },
				request,
			);
			expect(projection.action).toBe("evaluation.dataset.create");
			expect(projection.subject.kind).toBe("evaluation_dataset");
			expect(JSON.stringify(projection)).not.toContain(d.name);
			await sql`update platform.audit_events set details=details || ${sql.json({ sample: "SENSITIVE" })} where id=${row?.id}`;
			await expect(
				query.getAudit(scope, row?.id, { limit: 1, filters: {} }, request),
			).rejects.toMatchObject({ code: "unavailable" });
		} finally {
			await query.close();
			await sql`update platform.audit_events set details=details-'sample' where id=${row?.id}`;
		}
	});
	it("starts from a private deployment module with a current policy file and dedicated S3 factory", async () => {
		const temporary = await mkdtemp(join(tmpdir(), "eval-deployment-"));
		let running:
			| Awaited<ReturnType<typeof startPlatformApiFromDeployment>>
			| undefined;
		const policyFile = join(temporary, "policy.json");
		const moduleFile = join(temporary, "configuration.mjs");
		const source = `
import {readFile} from 'node:fs/promises';
import {createPlatformApiAssemblyInput as base} from ${JSON.stringify(new URL("../../../tests/fixtures/platform-api-deployment.mjs", import.meta.url).href)};
import {createEvaluationObjectStorageV1} from ${JSON.stringify(new URL("../../../packages/object-storage/dist/index.mjs", import.meta.url).href)};
import {parseEvaluationPolicyV1} from ${JSON.stringify(new URL("../../../packages/platform-core/dist/index.mjs", import.meta.url).href)};
const storage=createEvaluationObjectStorageV1(${JSON.stringify(storage.configuration)});
const loadPolicy=async()=>parseEvaluationPolicyV1(JSON.parse(await readFile(${JSON.stringify(policyFile)},'utf8')));
await loadPolicy();
export function createPlatformApiAssemblyInput(){ const input=base(); return {...input,databaseUrl:${JSON.stringify(database.databaseUrl)},identity:{...input.identity,resolveUser:async(userId)=>({schemaVersion:1,userId,accountStatus:'active',organizationIds:[],authorizationRevision:'v1'}),resolve:async()=>({schemaVersion:1,userId:'admin',displayName:'Fixture',accountStatus:'active',organizationIds:[],roles:['employee'],authorizationRevision:'v1'})},evaluation:{storage,loadPolicy,close:async()=>storage.close()}};}
`;
		try {
			await writeFile(policyFile, JSON.stringify(policy));
			await writeFile(moduleFile, source);
			running = await startPlatformApiFromDeployment({
				moduleSpecifier: pathToFileURL(moduleFile).href,
				port: 0,
				log: () => {},
			});
			const address = running.server.address();
			if (!address || typeof address === "string")
				throw new Error("fixture address");
			const origin = `http://127.0.0.1:${address.port}`;
			expect((await fetch(`${origin}/api/v2/evaluation/datasets`)).status).toBe(
				200,
			);
			await writeFile(policyFile, "{}");
			const denied = await fetch(`${origin}/api/v2/evaluation/datasets`);
			expect(denied.status).toBe(503);
			expect(await denied.text()).not.toContain("Synthetic evaluation");
		} finally {
			if (running) await createPlatformApiShutdown(running)();
			await rm(temporary, { recursive: true, force: true });
		}
	}, 30000);
	it("does not retain late deletion receipts beyond the original version metadata deadline", async () => {
		const { d, v } = await dataset();
		await grant(d.datasetId, v.versionId);
		const path = `/${d.datasetId}/versions/${v.versionId}/content`;
		const uploaded = EvaluationVersionV1Schema.parse(
			await json(path, "PUT", content, "alice"),
		);
		const deadline = new Date(Date.now() + 60000).toISOString();
		await sql`update platform.evaluation_versions set metadata_expires_at=${deadline}::timestamptz,data=jsonb_set(data,'{metadataExpiresAt}',to_jsonb(${deadline}::text)) where id=${v.versionId}`;
		await json(
			path,
			"DELETE",
			{ expectedRevision: uploaded.revision },
			"alice",
		);
		const [receipt] =
			await sql`select result from platform.idempotency_records where scope_type='evaluation' and result->'result'->>'versionId'=${v.versionId} and result->'result'->>'status'='deleting'`;
		expect(receipt?.result.expiresAt).toBe(deadline);
	});
	it("recovers an unobserved upload response from persisted intent after service restart without a second S3 version", async () => {
		const { d, v } = await dataset();
		await grant(d.datasetId, v.versionId);
		const path = `/${d.datasetId}/versions/${v.versionId}/content`;
		const key = randomUUID();
		const first = EvaluationVersionV1Schema.parse(
			await json(path, "PUT", content, "alice", key),
		);
		const [original] =
			await sql`select data from platform.evaluation_versions where id=${v.versionId}`;
		const restarted = new PostgresEvaluationDataStoreV1({
			...database,
			directory: {
				resolveUser: async (userId) => ({
					schemaVersion: 1,
					userId,
					accountStatus: "active",
					organizationIds: [],
					authorizationRevision: "v1",
				}),
			},
		});
		try {
			const service = createEvaluationDataV1({
				store: restarted,
				storage: storage.storage,
				loadPolicy: async () => policy,
			});
			const request = {
				authentication: { kind: "browser" as const, userId: "alice" },
				requestId: randomUUID(),
				traceId: randomUUID(),
			};
			expect(
				await service.upload(
					request,
					key,
					d.datasetId,
					v.versionId,
					new TextEncoder().encode(JSON.stringify(content)),
				),
			).toEqual(first);
			await expect(
				service.upload(
					request,
					key,
					d.datasetId,
					v.versionId,
					new TextEncoder().encode(
						JSON.stringify({
							...content,
							samples: [{ ...content.samples[0], input: "different fixture" }],
						}),
					),
				),
			).rejects.toMatchObject({ code: "conflict" });
			const objects = (await storage.storage.scan(null, 100)).objects.filter(
				(object) => object.objectRef === original?.data.objectRef,
			);
			expect(objects.map((object) => object.version)).toEqual([
				original?.data.stored.version,
			]);
		} finally {
			await restarted.close();
		}
	});
	it("checks upload size against the policy bound inside the transaction before any S3 operation", async () => {
		const old = policy;
		policy = { ...old, revision: old.revision + 1, maxContentBytes: 32 };
		const inspect = storage.storage.inspect;
		let inspections = 0;
		try {
			const { d, v } = await dataset();
			await grant(d.datasetId, v.versionId);
			storage.storage.inspect = async (...args) => {
				inspections++;
				return inspect(...args);
			};
			firstPolicyOverride = {
				...policy,
				maxContentBytes: 65536,
				transferTimeoutMs: 60000,
			};
			const result = await call(
				`/${d.datasetId}/versions/${v.versionId}/content`,
				"PUT",
				content,
				"alice",
			);
			expect(result.status).toBe(400);
			expect(inspections).toBe(0);
			const [row] =
				await sql`select status from platform.evaluation_versions where id=${v.versionId}`;
			expect(row?.status).toBe("pending");
		} finally {
			firstPolicyOverride = undefined;
			storage.storage.inspect = inspect;
			policy = { ...old, revision: old.revision + 2 };
		}
	});
	it("physically purges expired receipts and refuses a late upload retry to a retired version", async () => {
		const { d, v } = await dataset();
		await grant(d.datasetId, v.versionId);
		const path = `/${d.datasetId}/versions/${v.versionId}/content`;
		const key = randomUUID();
		await json(path, "PUT", content, "alice", key);
		const expired = new Date(Date.now() - 1000).toISOString();
		await sql`update platform.evaluation_versions set expires_at=${expired}::timestamptz,metadata_expires_at=${expired}::timestamptz,data=jsonb_set(jsonb_set(data,'{expiresAt}',to_jsonb(${expired}::text)),'{metadataExpiresAt}',to_jsonb(${expired}::text)) where id=${v.versionId}`;
		const rows =
			await sql`update platform.idempotency_records set result=jsonb_set(result,'{expiresAt}',to_jsonb(${expired}::text)) where scope_type='evaluation' and scope_id=${JSON.stringify({ kind: "user", id: "alice" })} returning id`;
		expect(rows.length).toBeGreaterThan(0);
		await worker.runOnce();
		await worker.runOnce();
		for (const row of rows)
			expect(
				await sql`select * from platform.idempotency_records where id=${row.id}`,
			).toHaveLength(0);
		expect((await call(path, "PUT", content, "alice", key)).status).toBe(404);
	});
});
