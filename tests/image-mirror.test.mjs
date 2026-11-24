import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	assertSourceOnMain,
	mirrorImages,
	parseMirrorReferences,
	planFromPublication,
	summaryMarkdown,
	targetReference,
	validatePublicationRun,
} from "../deploy/release/image-mirror.ts";

const sha = "a".repeat(40);
const ghcr = "ghcr.io/agoraio-extensions/agent-infra";
const digestOf = (seed) =>
	`sha256:${createHash("sha256").update(seed).digest("hex")}`;
const indexLine = (name, tag = `release-${sha}`, commitSha = sha) => {
	const indexDigest = digestOf(`${name}-index`);
	const platformDigests = {
		"linux/amd64": digestOf(`${name}-amd64`),
		"linux/arm64": digestOf(`${name}-arm64`),
	};
	return JSON.stringify({
		commitSha,
		reference: `${ghcr}/${name}:${tag}`,
		digest: indexDigest,
		indexDigest,
		platforms: platformDigests,
		platformDigests,
	});
};
const templateNames = [
	"agent-runtime-host",
	"agent-runtime-codex",
	"agent-runtime-claude",
	"agent-runtime-opencode",
	"agent-runtime-pi",
	"custom-agent-base",
];
const platformNames = [
	"web",
	"platform-api",
	"platform-worker",
	"enterprise-directory-sync",
];
const lines = (names, ...args) =>
	names.map((name) => indexLine(name, ...args)).join("\n");
const run = {
	id: 42,
	run_attempt: 1,
	status: "completed",
	conclusion: "success",
	event: "workflow_dispatch",
	head_branch: "main",
	path: ".github/workflows/publish-images.yml",
	repository: { full_name: "AgoraIO-Extensions/agent-infra" },
	head_repository: { full_name: "AgoraIO-Extensions/agent-infra" },
	display_title: `workflow_dispatch | publish-images | main | ${sha}`,
};

test("accepts only a successful trusted publication run", () => {
	assert.equal(validatePublicationRun(run, "42", "1"), sha);
	for (const change of [
		{ conclusion: "failure" },
		{ run_attempt: 2 },
		{ head_repository: { full_name: "fork/agent-infra" } },
		{ path: ".github/workflows/ci.yml" },
		{ event: "pull_request" },
		{ display_title: "workflow_dispatch | publish-images | main | not-a-sha" },
	])
		assert.throws(
			() => validatePublicationRun({ ...run, ...change }, "42", "1"),
			/MIRROR_RUN_/u,
		);
});

test("plans the amd64 child manifest of every template and Platform image", () => {
	const plan = planFromPublication(
		lines(templateNames),
		lines(platformNames),
		sha,
	);
	assert.equal(plan.status, "planned");
	assert.equal(plan.sourceSha, sha);
	assert.deepEqual(
		plan.images.map((image) => image.name).sort(),
		[...templateNames, ...platformNames].sort(),
	);
	const api = plan.images.find((image) => image.name === "platform-api");
	assert.deepEqual(api, {
		name: "platform-api",
		digest: digestOf("platform-api-amd64"),
		source: `${ghcr}/platform-api@${digestOf("platform-api-amd64")}`,
	});
	assert.equal(
		planFromPublication(lines(templateNames), undefined, sha).images.length,
		6,
	);
});

test("skips smoke publications and rejects incomplete or mismatched receipts", () => {
	assert.deepEqual(
		planFromPublication(lines(templateNames, "smoke-1-1"), undefined, sha),
		{
			schemaVersion: 1,
			status: "skipped",
			reason: "MIRROR_SMOKE_PUBLICATION",
			sourceSha: sha,
			images: [],
		},
	);
	assert.throws(
		() => planFromPublication(lines(templateNames.slice(1)), undefined, sha),
		/MIRROR_RELEASE_INCOMPLETE/u,
	);
	assert.throws(
		() =>
			planFromPublication(
				lines(templateNames, `release-${sha}`, "b".repeat(40)),
				undefined,
				sha,
			),
		/MIRROR_RELEASE_SOURCE_MISMATCH/u,
	);
	assert.throws(
		() => planFromPublication(lines(templateNames, "main"), undefined, sha),
		/MIRROR_RELEASE_TAG_INVALID/u,
	);
	assert.throws(
		() =>
			planFromPublication(
				lines(templateNames),
				lines(platformNames.slice(1)),
				sha,
			),
		/MIRROR_RELEASE_INCOMPLETE/u,
	);
	assert.throws(
		() =>
			planFromPublication(
				`${lines(templateNames)}\n${indexLine("agent-runtime-pi")}`,
				undefined,
				sha,
			),
		/MIRROR_RELEASE_INCOMPLETE/u,
	);
});

test("accepts only GHCR agent-infra references pinned by digest for a backfill", () => {
	const api = `${ghcr}/platform-api@${digestOf("api")}`;
	const postgres = `${ghcr}/postgres@${digestOf("postgres")}`;
	const plan = parseMirrorReferences(`${api}\n${postgres}, ${api}`);
	assert.equal(plan.status, "planned");
	assert.deepEqual(
		plan.images.map((image) => image.source),
		[api, postgres],
	);
	for (const text of [
		"",
		`${ghcr}/platform-api:latest`,
		`docker.io/library/postgres@${digestOf("x")}`,
		`${ghcr}/Platform@${digestOf("x")}`,
		`${ghcr}/a/b@${digestOf("x")}`,
	])
		assert.throws(
			() => parseMirrorReferences(text),
			/MIRROR_REFERENCES_INVALID/u,
		);
	assert.throws(
		() =>
			parseMirrorReferences(
				Array.from(
					{ length: 201 },
					(_, index) => `${ghcr}/image-${index}@${digestOf(String(index))}`,
				).join("\n"),
			),
		/MIRROR_REFERENCES_INVALID/u,
	);
});

test("names each target by its digest under the internal prefix", () => {
	const digest = digestOf("api");
	assert.deepEqual(
		targetReference("registry.example/team/agent-infra", {
			name: "platform-api",
			digest,
		}),
		{
			tag: `registry.example/team/agent-infra/platform-api:sha256-${digest.slice(7)}`,
			pinned: `registry.example/team/agent-infra/platform-api@${digest}`,
		},
	);
	for (const prefix of [
		"",
		"https://registry.example/x",
		"registry.example/x/",
		"Registry.example/x",
	])
		assert.throws(
			() => targetReference(prefix, { name: "platform-api", digest }),
			/MIRROR_PREFIX_INVALID/u,
		);
});

function fakeRegistry(initial = {}, overrides = {}) {
	const manifests = new Map(Object.entries(initial));
	const calls = [];
	return {
		calls,
		manifest(reference) {
			calls.push(["manifest", reference]);
			return manifests.get(reference);
		},
		platform:
			overrides.platform ??
			(() => ({
				mediaType: "application/vnd.oci.image.manifest.v1+json",
				os: "linux",
				architecture: "amd64",
			})),
		copy(source, tag, pinned) {
			calls.push(["copy", source, tag]);
			const bytes =
				overrides.copied ??
				`manifest-of-${source.split("@")[0].split("/").at(-1)}`;
			manifests.set(pinned, bytes);
		},
	};
}

test("copies missing manifests, keeps present ones, and verifies the exact bytes", () => {
	const images = [
		{
			name: "platform-api",
			digest: digestOf("manifest-of-platform-api"),
			source: `${ghcr}/platform-api@${digestOf("manifest-of-platform-api")}`,
		},
		{
			name: "web",
			digest: digestOf("manifest-of-web"),
			source: `${ghcr}/web@${digestOf("manifest-of-web")}`,
		},
	];
	const prefix = "registry.example/team/agent-infra";
	const registry = fakeRegistry({
		[`${prefix}/web@${images[1].digest}`]: "manifest-of-web",
	});
	const receipt = mirrorImages(
		{ schemaVersion: 1, status: "planned", sourceSha: sha, images },
		prefix,
		registry,
		() => 0,
	);
	assert.equal(receipt.status, "passed");
	assert.deepEqual(
		receipt.images.map((image) => [image.name, image.status]),
		[
			["platform-api", "copied"],
			["web", "present"],
		],
	);
	assert.equal(registry.calls.filter((call) => call[0] === "copy").length, 1);
	assert.equal(JSON.stringify(receipt).includes(prefix), false);
	assert.deepEqual(
		mirrorImages(
			{ schemaVersion: 1, status: "planned", sourceSha: sha, images },
			prefix,
			registry,
			() => 0,
		).images.map((image) => image.status),
		["present", "present"],
	);
});

test("fails when the registry holds different bytes for the digest", () => {
	const digest = digestOf("manifest-of-platform-api");
	const images = [
		{ name: "platform-api", digest, source: `${ghcr}/platform-api@${digest}` },
	];
	const receipt = mirrorImages(
		{ schemaVersion: 1, status: "planned", sourceSha: sha, images },
		"registry.example/x",
		fakeRegistry({}, { copied: "rewritten" }),
		() => 0,
	);
	assert.equal(receipt.status, "failed");
	assert.deepEqual(
		receipt.images.map((image) => [image.status, image.reason]),
		[["failed", "MIRROR_DIGEST_MISMATCH"]],
	);
});

test("reports a failed copy without stopping the remaining images", () => {
	const images = ["web", "platform-api"].map((name) => ({
		name,
		digest: digestOf(`manifest-of-${name}`),
		source: `${ghcr}/${name}@${digestOf(`manifest-of-${name}`)}`,
	}));
	const registry = fakeRegistry();
	const copy = registry.copy;
	registry.copy = (source, ...rest) => {
		if (source.includes("/web@"))
			throw new Error("registry said: secret-token");
		copy(source, ...rest);
	};
	const receipt = mirrorImages(
		{ schemaVersion: 1, status: "planned", sourceSha: sha, images },
		"registry.example/x",
		registry,
		() => 0,
	);
	assert.equal(receipt.status, "failed");
	assert.deepEqual(
		receipt.images.map((image) => [image.name, image.status, image.reason]),
		[
			["web", "failed", "MIRROR_COPY_FAILED"],
			["platform-api", "copied", undefined],
		],
	);
	assert.equal(JSON.stringify(receipt).includes("secret-token"), false);
});

test("renders a summary without the internal prefix", () => {
	const digest = digestOf("api");
	const text = summaryMarkdown({
		schemaVersion: 1,
		status: "passed",
		sourceSha: sha,
		durationSeconds: 12.5,
		images: [
			{ name: "platform-api", digest, status: "copied", durationSeconds: 12.5 },
		],
	});
	assert.match(text, /platform-api/u);
	assert.match(text, /12\.5/u);
	assert.match(text, new RegExp(digest, "u"));
	assert.match(
		summaryMarkdown({
			schemaVersion: 1,
			status: "skipped",
			reason: "MIRROR_SMOKE_PUBLICATION",
			sourceSha: sha,
			images: [],
		}),
		/MIRROR_SMOKE_PUBLICATION/u,
	);
});

test("rejects arm64 manifests and multi-architecture indexes before copying", () => {
	const digest = digestOf("manifest-of-platform-api");
	const plan = {
		schemaVersion: 1,
		status: "planned",
		sourceSha: sha,
		images: [
			{
				name: "platform-api",
				digest,
				source: `${ghcr}/platform-api@${digest}`,
			},
		],
	};
	for (const platform of [
		{
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			os: "linux",
			architecture: "arm64",
		},
		{ mediaType: "application/vnd.oci.image.index.v1+json" },
		{ mediaType: "application/vnd.docker.distribution.manifest.list.v2+json" },
	]) {
		const registry = fakeRegistry({}, { platform: () => platform });
		const receipt = mirrorImages(plan, "registry.example/x", registry, () => 0);
		assert.deepEqual(
			receipt.images.map((image) => image.reason),
			["MIRROR_PLATFORM_INVALID"],
		);
		assert.equal(
			registry.calls.some((call) => call[0] === "copy"),
			false,
		);
	}
	const unreadable = fakeRegistry(
		{},
		{
			platform: () => {
				throw new Error("denied");
			},
		},
	);
	assert.deepEqual(
		mirrorImages(plan, "registry.example/x", unreadable, () => 0).images.map(
			(image) => image.reason,
		),
		["MIRROR_SOURCE_UNREADABLE"],
	);
});

test("mirrors a tag release only when its source is on main", () => {
	assert.doesNotThrow(() => assertSourceOnMain({ status: "ahead" }));
	assert.doesNotThrow(() => assertSourceOnMain({ status: "identical" }));
	for (const status of ["behind", "diverged", undefined])
		assert.throws(
			() => assertSourceOnMain({ status }),
			/MIRROR_RUN_SOURCE_NOT_ON_MAIN/u,
		);
});
