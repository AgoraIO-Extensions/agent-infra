import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectionProviderCatalogs } from "@agent-infra/openconnector-adapter/provider-catalogs";
import { migrateConnectionDatabase } from "../src/migrations";
import { assertIsolatedTestDatabaseUrl } from "../src/test-database";

// Local, isolated PostgreSQL only; never benchmark against a runtime database.
const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("CONNECTION_TEST_DATABASE_URL is required");
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
const target = new URL(databaseUrl);
if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_test")) {
	throw new Error("Benchmark requires a loopback database ending in _test");
}
const root =
	process.env.STARTUP_BENCHMARK_ROOT ??
	resolve(import.meta.dirname, "../../..");
const { PostgresConnectionRepository } = await import(
	pathToFileURL(resolve(root, "packages/connection-store/src/repository.ts"))
		.href
);
await migrateConnectionDatabase(
	databaseUrl,
	resolve(root, "migrations/connection"),
);
const repository = new PostgresConnectionRepository(
	databaseUrl,
	Buffer.alloc(32, 23),
);
const suffix = randomUUID();
const catalogs = connectionProviderCatalogs.map((catalog) => ({
	...catalog,
	providerReleaseId: `${catalog.providerReleaseId}-benchmark-${suffix}`,
	actions: catalog.actions.map((action) => ({
		...action,
		id: `${action.id}-${suffix}`,
	})),
}));
const consumers = Array.from({ length: 3 }, (_, index) => ({
	id: `benchmark-${suffix}-${index}`,
	name: "Startup benchmark",
}));
try {
	for (const phase of ["cold", "repeat"] as const) {
		const startedAt = performance.now();
		for (const catalog of catalogs) {
			await repository.publishProviderCatalog(catalog, {
				mode: "USER_ACTION_REQUIRED",
				reason: "Benchmark catalog publication",
			});
		}
		const catalogsMs = Math.round(performance.now() - startedAt);
		const publishConsumer = async (consumer: (typeof consumers)[number]) => {
			for (const catalog of catalogs) {
				await repository.publishConsumerDeclaration({
					consumer,
					providerReleaseId: catalog.providerReleaseId,
					actionVersionIds: catalog.actions.map((action) => action.id),
				});
			}
		};
		if (process.env.STARTUP_BENCHMARK_SERIAL === "true") {
			for (const consumer of consumers) await publishConsumer(consumer);
		} else {
			const results = await Promise.allSettled(consumers.map(publishConsumer));
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		}
		console.info(
			JSON.stringify({
				phase,
				providers: catalogs.length,
				actions: catalogs.reduce(
					(sum, catalog) => sum + catalog.actions.length,
					0,
				),
				declarations: catalogs.length * consumers.length,
				catalogsMs,
				totalMs: Math.round(performance.now() - startedAt),
			}),
		);
	}
} finally {
	await repository.close();
}
