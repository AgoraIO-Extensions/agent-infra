import type {
	PlatformIdempotencyBoundScopeV1,
	PlatformIdempotencyPortV1,
} from "@agent-infra/platform-core";
import { platformIdempotencyV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { platformIdempotencyPortV1Conformance } from "../../platform-core/src/idempotency.conformance.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

const scope: PlatformIdempotencyBoundScopeV1 = {
	schemaVersion: 1,
	operation: "platform.agent-application.submit.v1",
	resourceType: "agent_application",
	resourceId: "application_postgres",
	actorId: "user_postgres",
};
const builtStore: typeof import("./index.ts") = await import(
	new URL("../dist/index.mjs", import.meta.url).href
);

let adminClient: ReturnType<typeof postgres>;
let databaseUrl = "";
let testDatabase: PostgresTestDatabase | undefined;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("platform-store-idempotency");
	databaseUrl = testDatabase.databaseUrl;
	await builtStore.migratePlatformDatabase({ databaseUrl });
	adminClient = postgres(databaseUrl, { max: 1 });
}, 120_000);

afterAll(async () => {
	await adminClient?.end();
	await testDatabase?.stop();
});

describe("PostgreSQL Platform idempotency Port", () => {
	platformIdempotencyPortV1Conformance(async () => {
		await adminClient`truncate platform.idempotency_records`;
		const adapters: { close(): Promise<void> }[] = [];
		return {
			open(boundScope) {
				const adapter = builtStore.openPostgresPlatformIdempotencyStore({
					databaseUrl,
					scope: boundScope,
				});
				adapters.push(adapter);
				return adapter satisfies PlatformIdempotencyPortV1;
			},
			async close() {
				await Promise.all(adapters.map((adapter) => adapter.close()));
			},
		};
	});

	it("sanitizes PostgreSQL failures at the Port interface", async () => {
		const adapter = builtStore.openPostgresPlatformIdempotencyStore({
			databaseUrl:
				"postgres://platform_user:database-secret@127.0.0.1:1/platform",
			scope,
		});
		let failure: unknown;
		try {
			await adapter.reserve({
				key: "Failure_A",
				requestDigest: platformIdempotencyV1.canonicalRequestDigest({
					revision: 8,
				}),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			name: "PlatformIdempotencyError",
			code: "unavailable",
			message: "Idempotency persistence unavailable",
		});
		expect(String(failure)).not.toMatch(
			/database-secret|127\.0\.0\.1|insert|sql/i,
		);
		await adapter.close().catch(() => {});
	});
});
