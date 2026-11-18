import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	promote,
	targetRepository,
} from "../deploy/release/promote-signed-own-entry.ts";

const raw = await readFile(
	new URL(
		"./fixtures/custom-agent-web/promotion-origin.manifest",
		import.meta.url,
	),
	"utf8",
);
const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const source = "a".repeat(40);
const workflow = "b".repeat(40);
const repository =
	"ghcr.io/agoraio-extensions/agent-infra/custom-agent-web-signed";
const receipt = `${JSON.stringify({ schemaVersion: 1, commitSha: source, platform: "linux/amd64", images: { signedOwnEntry: { repository, digest } } }, null, 2)}\n`;
const image = {
	os: "linux",
	architecture: "amd64",
	config: {
		Entrypoint: ["node", "/app/signed-server.ts"],
		Cmd: null,
		Labels: {
			"org.opencontainers.image.revision": source,
			"io.agora.agent.runtime.manifest": JSON.stringify({
				schemaVersion: 1,
				interactionMode: "self-managed",
				service: { port: 3003 },
				health: { path: "/healthz" },
			}),
		},
	},
};

function fixture(change = {}) {
	const calls = [];
	const records = [];
	const input = {
		receipt,
		runMetadata: {
			databaseId: 123456,
			headSha: workflow,
			status: "completed",
			conclusion: "success",
			attempt: 1,
			event: "workflow_dispatch",
			headBranch: "main",
			workflowName: "Publish signed own entry",
		},
		originRunId: "123456",
		originAttempt: "1",
		runId: "654321",
		attempt: "1",
		source,
		ref: "refs/heads/main",
		workflowSha: "c".repeat(40),
		record: async (value, exclusive) => records.push({ value, exclusive }),
		...change,
	};
	const command = (args) => {
		calls.push(args);
		if (args[0] === "manifest")
			return { status: 1, stdout: "", stderr: "manifest unknown" };
		if (args.includes("create")) return { status: 0, stdout: "", stderr: "" };
		return {
			status: 0,
			stdout: args.includes("--raw") ? raw : JSON.stringify(image),
			stderr: "",
		};
	};
	return { input, calls, records, command };
}

test("copies only the verified current-source fixture to the admitted repository", async () => {
	const f = fixture();
	const result = await promote(f.input, f.command);
	assert.equal(result.verified, true);
	assert.equal(result.sourceManifestDigest, result.targetManifestDigest);
	assert.deepEqual(result.layerDigests, result.targetLayerDigests);
	assert.equal(result.configDigest, result.targetConfigDigest);
	const writes = f.calls.filter((args) => args.includes("create"));
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0], [
		"buildx",
		"imagetools",
		"create",
		"--prefer-index=false",
		"--tag",
		`${targetRepository}:ownentry-${source.slice(0, 12)}-123456-1`,
		`${repository}@${digest}`,
	]);
	assert.equal(f.records[0].exclusive, true);
	assert.equal(f.records[0].value.verified, false);
});

test("rejects altered source, origin run, receipt, ref and rerun before Registry access", async () => {
	for (const change of [
		{ ref: "refs/heads/feature" },
		{ source: "d".repeat(40) },
		{ originRunId: "123457" },
		{ originAttempt: "2" },
		{ attempt: "2" },
		{ receipt: `${receipt} ` },
		{ runMetadata: { ...fixture().input.runMetadata, conclusion: "failure" } },
	]) {
		const f = fixture(change);
		await assert.rejects(promote(f.input, f.command));
		assert.equal(f.calls.length, 0);
	}
});

test("never overwrites or treats auth/transport failure as target absence", async () => {
	for (const response of [
		{ status: 0, stdout: raw, stderr: "" },
		{ status: 1, stdout: "", stderr: "unauthorized: manifest unknown" },
		{ status: 1, stdout: "", stderr: "timeout" },
	]) {
		const f = fixture();
		await assert.rejects(
			promote(f.input, (args) =>
				args[0] === "manifest" ? response : f.command(args),
			),
		);
		assert.equal(
			f.calls.some((args) => args.includes("create")),
			false,
		);
		assert.equal(f.records.length, 0);
	}
});

test("rejects bad manifest, architecture, source label or runtime identity before copy", async () => {
	for (const bad of [
		null,
		{ ...image, architecture: "arm64" },
		{ ...image, config: { ...image.config, Entrypoint: ["other"] } },
		{ ...image, config: { ...image.config, Labels: {} } },
	]) {
		const f = fixture();
		await assert.rejects(
			promote(f.input, (args) =>
				args.includes("--raw") && bad === null
					? { status: 0, stdout: "{}", stderr: "" }
					: args.includes("--format")
						? { status: 0, stdout: JSON.stringify(bad), stderr: "" }
						: f.command(args),
			),
		);
		assert.equal(
			f.calls.some((args) => args.includes("create")),
			false,
		);
	}
});

test("unknown copy or changed target retains non-verified intent and never retries", async () => {
	for (const mode of ["copy-fails", "target-changed"]) {
		const f = fixture();
		let copies = 0;
		await assert.rejects(
			promote(f.input, (args) => {
				if (args.includes("create")) {
					copies++;
					if (mode === "copy-fails")
						return { status: 1, stdout: "", stderr: "failure" };
				}
				if (copies && args.includes("--raw"))
					return { status: 0, stdout: "{}", stderr: "" };
				return f.command(args);
			}),
		);
		assert.equal(copies, 1);
		assert.equal(f.records.length, 1);
		assert.equal(f.records[0].value.status, "COPY_STARTED");
	}
});
