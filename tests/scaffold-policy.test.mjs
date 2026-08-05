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
});
