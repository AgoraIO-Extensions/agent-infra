import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	checkWorkloadCapacity,
	validateCapacityBindings,
} from "../deploy/ack/workload-capacity.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const imageDigest = `sha256:${"a".repeat(64)}`;
const policy = {
	resourceProfileRef: "small",
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "1", memory: "2Gi" },
	},
};
const evidenceBytes = Buffer.from('{"kind":"synthetic-test-evidence"}');
const evidence = new Map([[imageDigest, evidenceBytes]]);
const profile = {
	schemaVersion: 1,
	imageDigest,
	resourceProfileRef: policy.resourceProfileRef,
	resourceConfigurationHash: hash(
		JSON.stringify({
			resourceProfileRef: policy.resourceProfileRef,
			...policy.resources,
		}),
	),
	maximumConcurrentExecutions: 1,
	conformanceEvidenceHash: hash(evidenceBytes),
};
const templates = [{ templateId: "codex", imageDigest }];
const standard = { source: { kind: "standard", templateId: "codex" } };
const custom = {
	source: {
		kind: "custom",
		interactionMode: "platform-adapter",
		imageReference: `registry.example.test/custom@${imageDigest}`,
	},
};
const check = (profiles, other = {}) =>
	validateCapacityBindings(
		other.requests ?? [standard, custom],
		other.templates ?? templates,
		other.policy ?? policy,
		profiles,
		other.evidence ?? evidence,
	);

test("one current measured binding covers a selected standard and custom digest", () => {
	assert.equal(check([profile]).imageCount, 1);
});

test("current templates without matching capacity fail instead of passing Agent readiness", () => {
	assert.throws(() => check([]), /CAPACITY_BINDING/);
	assert.throws(
		() => check([{ ...profile, imageDigest: `sha256:${"b".repeat(64)}` }]),
		/CAPACITY_BINDING/,
	);
});

test("ambiguous capacity and changed requests or limits fail closed", () => {
	assert.throws(() => check([profile, profile]), /CAPACITY_BINDING/);
	for (const field of ["requests", "limits"]) {
		const changed = structuredClone(policy);
		changed.resources[field].memory = "3Gi";
		assert.throws(
			() => check([profile], { policy: changed }),
			/CAPACITY_BINDING/,
		);
	}
});

test("placeholder hashes, missing evidence, changed evidence and invalid capacity fail", () => {
	assert.throws(() =>
		check([{ ...profile, conformanceEvidenceHash: "0".repeat(64) }]),
	);
	assert.throws(
		() => check([profile], { evidence: new Map() }),
		/CAPACITY_EVIDENCE/,
	);
	assert.throws(
		() =>
			check([profile], {
				evidence: new Map([[imageDigest, Buffer.from("changed")]]),
			}),
		/CAPACITY_EVIDENCE/,
	);
	assert.throws(() => check([{ ...profile, maximumConcurrentExecutions: 0 }]));
});

test("custom tags and ambiguous template identities cannot select a capacity profile", () => {
	assert.throws(() =>
		check([profile], {
			requests: [
				{
					source: {
						...custom.source,
						imageReference: "registry.example.test/custom:latest",
					},
				},
			],
		}),
	);
	assert.throws(() =>
		check([profile], { templates: [...templates, ...templates] }),
	);
});

test("self-managed entrypoints do not require a Platform Session capacity profile", () => {
	assert.equal(
		check([], {
			requests: [
				{ source: { kind: "custom", interactionMode: "self-managed" } },
			],
		}).imageCount,
		0,
	);
});

test("private input checks fail before cluster read when invalid and reject stale mounted profiles", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ack-capacity-"));
	const sourceSha = "a".repeat(40);
	const paths = Object.fromEntries(
		["config", "requests", "templates", "body", "profiles", "evidence"].map(
			(name) => [name, join(dir, `${name}.json`)],
		),
	);
	const write = (name, value) =>
		writeFile(paths[name], JSON.stringify(value), { mode: 0o600 });
	try {
		await write("config", {
			schemaVersion: 1,
			sourceSha,
			...policy,
			profilesFile: paths.profiles,
			evidence: [{ imageDigest, file: paths.evidence }],
			workerSecretRef: { name: "worker-config", key: "capacity.json" },
		});
		await write("requests", {
			schemaVersion: 1,
			requests: [{ bodyFile: paths.body }],
		});
		await write("templates", { schemaVersion: 1, sourceSha, templates });
		await write("body", standard);
		await writeFile(paths.evidence, evidenceBytes, { mode: 0o600 });
		await write("profiles", { schemaVersion: 1, profiles: [] });
		let reads = 0;
		const read = () => {
			reads++;
			return Buffer.from(
				JSON.stringify({ schemaVersion: 1, profiles: [profile] }),
			);
		};
		await assert.rejects(
			checkWorkloadCapacity(
				paths.config,
				paths.requests,
				paths.templates,
				sourceSha,
				read,
			),
			/CAPACITY_BINDING/,
		);
		assert.equal(reads, 0);
		await write("profiles", { schemaVersion: 1, profiles: [profile] });
		assert.equal(
			(
				await checkWorkloadCapacity(
					paths.config,
					paths.requests,
					paths.templates,
					sourceSha,
					read,
				)
			).mountedInputVerified,
			true,
		);
		await assert.rejects(
			checkWorkloadCapacity(
				paths.config,
				paths.requests,
				paths.templates,
				sourceSha,
				() => Buffer.from("stale"),
			),
			/CAPACITY_SECRET_DRIFT/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
