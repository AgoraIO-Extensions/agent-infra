import assert from "node:assert/strict";
import test from "node:test";

import {
	checkManifestDependencies,
	checkProductionManifestDependencies,
	checkRepositoryArchitecture,
	checkSourceImports,
	isProductionPackagePath,
} from "./support/contracts-architecture-policy.mjs";

test("current repository obeys contract package dependency directions", async () => {
	assert.deepEqual(await checkRepositoryArchitecture(process.cwd()), []);
});

test("contracts source accepts tooling dependencies but rejects forbidden modules", () => {
	assert.deepEqual(
		checkSourceImports('import { z } from "zod";', {
			path: "packages/contracts/src/schema.ts",
		}),
		[],
	);
	for (const dependency of [
		"react-dom",
		"@hono/node-server",
		"drizzle-zod",
		"@kubernetes/client-node",
		"@agent-infra/platform-core",
	]) {
		assert.match(
			checkSourceImports(`import "${dependency}";`, {
				path: "packages/contracts/src/schema.ts",
			})[0],
			new RegExp(`contracts source must not import ${dependency}`),
		);
	}
});

test("production source rejects test-support while test-support consumes contracts", () => {
	assert.match(
		checkSourceImports('import { fixture } from "@agent-infra/test-support";', {
			path: "apps/platform-api/src/app.ts",
		})[0],
		/production source must not import @agent-infra\/test-support/,
	);
	assert.deepEqual(
		checkSourceImports(
			'import { ProtocolErrorV1Schema } from "@agent-infra/contracts";',
			{ path: "packages/test-support/src/index.ts" },
		),
		[],
	);
});

test("only platform-store imports PostgreSQL implementation dependencies", () => {
	for (const path of [
		"apps/platform-api/src/app.ts",
		"apps/platform-worker/src/index.ts",
		"packages/platform-core/src/index.ts",
	]) {
		for (const dependency of ["drizzle-orm", "postgres"]) {
			assert.match(
				checkSourceImports(`import "${dependency}";`, { path })[0],
				/only platform-store/,
			);
		}
	}
	assert.deepEqual(
		checkSourceImports('import { drizzle } from "drizzle-orm/postgres-js";', {
			path: "packages/platform-store/src/migrate.ts",
		}),
		[],
	);
});

test("only platform-store declares PostgreSQL runtime dependencies", () => {
	for (const path of ["apps/platform-api", "packages/platform-core"]) {
		for (const dependency of ["drizzle-orm", "postgres"]) {
			assert.match(
				checkProductionManifestDependencies(
					{ dependencies: { [dependency]: "1.0.0" } },
					{ path },
				)[0],
				/only platform-store/,
			);
		}
	}
	assert.deepEqual(
		checkProductionManifestDependencies(
			{ dependencies: { "drizzle-orm": "1.0.0", postgres: "1.0.0" } },
			{ path: "packages/platform-store" },
		),
		[],
	);
});

test("production manifests reject test-support runtime dependencies", () => {
	for (const section of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		assert.match(
			checkProductionManifestDependencies(
				{ [section]: { "@agent-infra/test-support": "workspace:*" } },
				{ path: "apps/platform-api" },
			)[0],
			new RegExp(`via ${section}`),
		);
	}
	assert.deepEqual(
		checkProductionManifestDependencies(
			{ devDependencies: { "@agent-infra/test-support": "workspace:*" } },
			{ path: "apps/platform-api" },
		),
		[],
	);
});

test("production package classification is path-separator independent", () => {
	for (const path of [
		"packages/contracts",
		"packages/test-support",
		"packages\\contracts",
		"packages\\test-support",
	]) {
		assert.equal(isProductionPackagePath(path), false);
	}
	assert.equal(isProductionPackagePath("apps\\platform-api"), true);
});

test("contracts manifest cannot depend on repository runtime modules", () => {
	assert.deepEqual(
		checkManifestDependencies({ dependencies: { zod: "catalog:" } }),
		[],
	);
	for (const section of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		assert.match(
			checkManifestDependencies({
				[section]: { "@agent-infra/platform-core": "workspace:*" },
			})[0],
			/contracts package must not depend on @agent-infra\/platform-core/,
		);
	}
	for (const dependency of [
		"react",
		"@hono/node-server",
		"drizzle-orm",
		"@kubernetes/client-node",
	]) {
		assert.match(
			checkManifestDependencies({ dependencies: { [dependency]: "1.0.0" } })[0],
			new RegExp(`contracts package must not depend on ${dependency}`),
		);
	}
});
