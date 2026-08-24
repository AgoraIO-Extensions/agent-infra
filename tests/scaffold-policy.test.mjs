import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const dockerfiles = new Map([
	["web", "apps/web/Dockerfile"],
	["platform-api", "apps/platform-api/Dockerfile"],
	["platform-worker", "apps/platform-worker/Dockerfile"],
	["connection-api", "apps/connection-api/Dockerfile"],
]);

const digestPattern = /@sha256:[a-f0-9]{64}$/;

test("deployment images pin every base image by digest", async () => {
	for (const [service, path] of dockerfiles) {
		const dockerfile = await readFile(path, "utf8");
		const images = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(
			(match) => match[1],
		);

		assert.ok(images.length > 0, `${service} must declare a base image`);
		for (const image of images) {
			assert.match(
				image,
				digestPattern,
				`${service} must pin ${image} by digest`,
			);
		}
	}
});

test("deployment images select an explicit non-root runtime user", async () => {
	const expectedUsers = new Map([
		["web", "nginx"],
		["platform-api", "node"],
		["platform-worker", "node"],
		["connection-api", "node"],
	]);

	for (const [service, path] of dockerfiles) {
		const dockerfile = await readFile(path, "utf8");
		const runtimeStage = dockerfile.slice(
			dockerfile.lastIndexOf("\nFROM ") + 1,
		);
		assert.match(
			runtimeStage,
			new RegExp(`^USER ${expectedUsers.get(service)}$`, "m"),
			`${service} must select its non-root runtime user in the final stage`,
		);
	}
});

test("Node runtime images contain only production deployment artifacts", async () => {
	for (const service of ["platform-api", "platform-worker", "connection-api"]) {
		const path = dockerfiles.get(service);
		const dockerfile = await readFile(path, "utf8");
		const manifest = JSON.parse(
			await readFile(`apps/${service}/package.json`, "utf8"),
		);
		const runtimeStage = dockerfile.slice(
			dockerfile.lastIndexOf("\nFROM ") + 1,
		);

		assert.equal(manifest.main, "dist/index.mjs");
		assert.deepEqual(manifest.files, ["dist"]);
		assert.match(
			dockerfile,
			new RegExp(
				`pnpm --filter @agent-infra/${service} deploy --prod --legacy /prod/${service}`,
			),
			`${service} must prepare a production-only deployment`,
		);
		assert.match(
			runtimeStage,
			new RegExp(
				`^COPY --from=builder --chown=node:node /prod/${service}/ \\./$`,
				"m",
			),
			`${service} must copy only its deployment into the runtime stage`,
		);
		assert.doesNotMatch(runtimeStage, /^COPY \. \.$/m);
	}
});

test("the production Connection builder excludes development fixture source", async () => {
	const dockerfile = await readFile("apps/connection-api/Dockerfile", "utf8");

	assert.doesNotMatch(dockerfile, /^COPY . .$/m);
	assert.doesNotMatch(dockerfile, /fixture|stub/i);
	assert.doesNotMatch(dockerfile, /src\/conformance(?:-app)?\.ts/);
	assert.doesNotMatch(dockerfile, /Dockerfile.development/);
	assert.ok(
		dockerfile.includes("COPY migrations/connection migrations/connection"),
		"production migrations must remain part of the controlled build input",
	);
});

test("the production Connection image excludes development provider fixtures", async () => {
	const dockerfile = await readFile("apps/connection-api/Dockerfile", "utf8");
	const productionCompose = parse(
		await readFile("docker-compose.production.yml", "utf8"),
	);

	assert.match(
		dockerfile,
		/^COPY apps\/connection-api\/src\/bootstrap-production\.ts /m,
	);
	assert.doesNotMatch(
		dockerfile,
		/^COPY apps\/connection-api\/src\/development\.ts /m,
	);
	assert.doesNotMatch(
		JSON.stringify(productionCompose.services),
		/CONNECTION_BUILD_MODE.*development/,
	);
});

test("local Compose exposes only the real PostgreSQL dependency", async () => {
	const compose = parse(await readFile("docker-compose.yml", "utf8"));
	assert.deepEqual(Object.keys(compose.services), ["postgres"]);
	assert.ok(compose.services.postgres.healthcheck);
});
