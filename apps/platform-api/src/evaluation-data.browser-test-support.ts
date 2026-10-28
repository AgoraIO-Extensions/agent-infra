import {
	evaluationRetainedMetadataFieldsV1,
	parseEvaluationPolicyV1,
} from "@agent-infra/platform-core";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import { startMinioFileFixtureV1 } from "../../../packages/object-storage/src/minio.test-support.js";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi } from "./assembly.js";

/** Isolated synthetic browser fixture; never loaded by deployment. */
export async function startEvaluationBrowserFixture() {
	const database = await startPostgresTestDatabase("evaluation-browser");
	let storage: Awaited<ReturnType<typeof startMinioFileFixtureV1>> | undefined;
	let assembly: ReturnType<typeof assemblePlatformApi> | undefined;
	let server: ReturnType<typeof serve> | undefined;
	const close = async () => {
		if (server)
			await new Promise<void>((resolve, reject) =>
				server?.close((error) => (error ? reject(error) : resolve())),
			);
		await assembly?.close();
		await storage?.close();
		await database.stop();
	};
	try {
		await migratePlatformDatabase(database);
		storage = await startMinioFileFixtureV1("file", "eval");
		const lifecycle = {
			contentMs: 600000,
			metadataMs: 1200000,
			deleteWithinMs: 10000,
		};
		const policy = parseEvaluationPolicyV1({
			schemaVersion: 1,
			policyId: "browser-fixture",
			revision: 1,
			validUntil: new Date(Date.now() + 600000).toISOString(),
			retainedMetadataFields: evaluationRetainedMetadataFieldsV1,
			materialApprovals: [
				{
					approvalId: "browser-synthetic",
					scope: "test",
					kind: "synthetic",
					redactionRef: null,
				},
			],
			managers: [
				{
					principal: { kind: "user", id: "browser-admin" },
					scopes: ["test"],
					operations: ["create", "import", "read", "delete", "manage_grants"],
					maxGrantMs: 600000,
				},
			],
			retention: {
				samples: { ...lifecycle, startsAt: "version_reserved" },
				rubric: { ...lifecycle, startsAt: "version_reserved" },
				output: { ...lifecycle, startsAt: "content_created" },
				score: { ...lifecycle, startsAt: "content_created" },
				review: { ...lifecycle, startsAt: "content_created" },
			},
			pendingMs: 300000,
			maxContentBytes: 65536,
			transferTimeoutMs: 5000,
		});
		const unused = async (): Promise<never> => {
			throw new Error("unused browser fixture dependency");
		};
		const user = (id: string) => ({
			schemaVersion: 1 as const,
			userId: id,
			accountStatus: "active" as const,
			organizationIds: [],
			authorizationRevision: "v1",
		});
		assembly = assemblePlatformApi({
			databaseUrl: database.databaseUrl,
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 2,
				waitingTimeoutMs: 30000,
			},
			identity: {
				resolve: async (request) => {
					const match = /session=([^;]+)/.exec(
						request.headers.get("Cookie") ?? "",
					);
					if (!match?.[1]) return null;
					return {
						...user(match[1]),
						displayName: match[1],
						roles: ["employee"],
					};
				},
				resolveUser: async (id) => user(id),
				hydrateUsers: async () => [],
			},
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
		const app = createPlatformApp(assembly.dependencies);
		server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
		if (!server.listening)
			await new Promise<void>((resolve) => server?.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("fixture address");
		return { origin: `http://127.0.0.1:${address.port}`, close };
	} catch (error) {
		await close();
		throw error;
	}
}
