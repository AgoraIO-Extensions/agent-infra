import assert from "node:assert/strict";
import test from "node:test";

import {
	checkManifestDependencies,
	checkRepositoryArchitecture,
	checkSourceImports,
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

test("contracts manifest cannot depend on repository runtime modules", () => {
	assert.deepEqual(
		checkManifestDependencies({ dependencies: { zod: "catalog:" } }),
		[],
	);
	assert.match(
		checkManifestDependencies({
			dependencies: { "@agent-infra/platform-core": "workspace:*" },
		})[0],
		/contracts package must not depend on @agent-infra\/platform-core/,
	);
});
