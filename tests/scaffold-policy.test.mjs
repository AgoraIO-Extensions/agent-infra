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

test("Platform Worker typecheck builds its dist-backed Secret Store dependency", async () => {
	const manifest = JSON.parse(
		await readFile("apps/platform-worker/package.json", "utf8"),
	);

	assert.match(
		manifest.scripts["check-types"],
		/pnpm --filter @agent-infra\/secret-store build && tsc --noEmit/,
	);
});

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
	const deployCommands = new Map([
		[
			"platform-api",
			"pnpm --config.inject-workspace-packages=true --filter @agent-infra/platform-api deploy --prod /prod/platform-api",
		],
		[
			"platform-worker",
			"pnpm --config.inject-workspace-packages=true --filter @agent-infra/platform-worker deploy --prod /prod/platform-worker",
		],
		[
			"connection-api",
			"pnpm --filter @agent-infra/connection-api deploy --prod --legacy /prod/connection-api",
		],
	]);
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
		assert.ok(
			dockerfile.includes(deployCommands.get(service)),
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

test("injected Platform runtime images discard compile-time metadata", async () => {
	for (const service of [
		"platform-api",
		"platform-worker",
		"agent-runtime-host",
	]) {
		const dockerfile = await readFile(`apps/${service}/Dockerfile`, "utf8");
		assert.match(
			dockerfile,
			new RegExp(`find /prod/${service} -type f .+ -delete`),
			`${service} must remove TypeScript declarations from its runtime deployment`,
		);
		for (const path of [
			`/prod/${service}/pnpm-lock.yaml`,
			`/prod/${service}/pnpm-workspace.yaml`,
			`/prod/${service}/node_modules/.package-map.json`,
		]) {
			assert.ok(
				dockerfile.includes(path),
				`${service} must remove ${path} from its runtime deployment`,
			);
		}
	}
});

test("Compose runs every deployment image with a read-only root filesystem", async () => {
	const compose = parse(await readFile("docker-compose.yml", "utf8"));

	for (const service of dockerfiles.keys()) {
		assert.equal(
			compose.services[service]?.read_only,
			true,
			`${service} must set read_only: true`,
		);
	}

	assert.ok(
		compose.services.web.tmpfs.some((mount) => mount.startsWith("/tmp:")),
		"web must declare an explicit writable tmpfs for nginx runtime files",
	);
	assert.deepEqual(compose.services.web.healthcheck.test, [
		"CMD",
		"wget",
		"-q",
		"--spider",
		"http://127.0.0.1:8080/",
	]);
});

test("Compose keeps the configured RuntimeHost out of the default application", async () => {
	const compose = parse(await readFile("docker-compose.yml", "utf8"));
	const rootManifest = JSON.parse(await readFile("package.json", "utf8"));

	assert.deepEqual(compose.services["agent-runtime-host"].profiles, [
		"runtime",
	]);
	assert.match(
		rootManifest.scripts["docker:build"],
		/docker compose --profile runtime build$/,
	);
});
