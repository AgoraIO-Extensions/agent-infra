#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sha256 } from "./image-manifest.mjs";
import { runCommand } from "./run-command.mjs";

async function main() {
	const [tag, namesArgument, ...paths] = process.argv.slice(2);
	const prefix = process.env.IMAGE_REPOSITORY_PREFIX;
	const commitSha = process.env.GITHUB_SHA;
	assert.match(tag ?? "", /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,114}$/, "image tag is invalid");
	assert.match(prefix ?? "", /^[a-z0-9][a-z0-9./:_-]*$/, "image repository prefix is invalid");
	assert.match(commitSha ?? "", /^[a-f0-9]{40}$/, "source SHA is invalid");
	const names = (namesArgument ?? "").split(",");
	assert.ok(names.every((name) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) &&
		new Set(names).size === names.length && paths.length >= 2, "image index arguments are invalid");
	const images = new Map(names.map((name) => [`${prefix}/${name}`, new Map()]));
	for (const path of paths) {
		const receipt = JSON.parse(await readFile(path, "utf8"));
		assert.ok(receipt.schemaVersion === 1 && receipt.commitSha === commitSha &&
			["linux/amd64", "linux/arm64"].includes(receipt.platform) && receipt.images &&
			!Array.isArray(receipt.images), "image receipt source or platform is invalid");
		for (const image of Object.values(receipt.images)) {
			const platforms = images.get(image.repository);
			assert.ok(platforms && !platforms.has(receipt.platform) &&
				/^sha256:[a-f0-9]{64}$/.test(image.digest), "image receipt is unexpected, duplicate or invalid");
			platforms.set(receipt.platform, image.digest);
		}
	}
	for (const platforms of images.values()) assert.equal(platforms.size, 2, "image receipt is missing an architecture");

	const docker = process.env.DOCKER_BIN ?? "docker";
	const command = (args) => runCommand(docker, ["buildx", "imagetools", ...args], {
		name: "Image index publication", timeoutMs: 10 * 60_000, trimOutput: false,
	});
	for (const [repository, platforms] of images) {
		const reference = `${repository}:${tag}`;
		command(["create", "--tag", reference,
			...Array.from(platforms.values(), (digest) => `${repository}@${digest}`)]);
		const bytes = command(["inspect", "--raw", reference]);
		const index = JSON.parse(bytes);
		assert.equal(index.manifests?.length, 2, "published index must contain two architectures");
		const actual = new Map(index.manifests.map((manifest) => [
			`${manifest.platform?.os}/${manifest.platform?.architecture}`, manifest.digest,
		]));
		assert.deepEqual([...actual].sort(), [...platforms].sort(), "published index differs from verified receipts");
		console.info(JSON.stringify({commitSha, reference, digest: `sha256:${sha256(bytes)}`, platforms: Object.fromEntries(actual)}));
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : "image index publication failed");
	process.exitCode = 1;
});
