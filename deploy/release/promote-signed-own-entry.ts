import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sourceRepository =
	"ghcr.io/agoraio-extensions/agent-infra/custom-agent-web-signed";
export const targetRepository =
	"ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const sourcePattern = /^[a-f0-9]{40}$/;

type Command = (args: string[]) => {
	status: number | null;
	stdout: string;
	stderr: string;
};

type PublicationReceipt = {
	readonly schemaVersion: 1;
	readonly commitSha: string;
	readonly platform: "linux/amd64";
	readonly images: {
		readonly signedOwnEntry: {
			readonly repository: string;
			readonly digest: string;
		};
	};
};

type OriginRunMetadata = {
	readonly databaseId: number;
	readonly headSha: string;
	readonly status: string;
	readonly conclusion: string;
	readonly attempt: number;
	readonly event: string;
	readonly headBranch: string;
	readonly workflowName: string;
};

function hash(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function docker(args: string[]) {
	const result = spawnSync("docker", args, {
		encoding: "utf8",
		timeout: 10 * 60_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function output(run: Command, args: string[]) {
	const result = run(args);
	assert.equal(result.status, 0, "Registry operation failed; no automatic retry");
	return result.stdout;
}

function readManifest(run: Command, reference: string, expectedDigest: string) {
	const raw = output(run, ["buildx", "imagetools", "inspect", "--raw", reference]);
	assert.ok(
		[raw, raw.replace(/\n$/, "")].some(
			(bytes) => `sha256:${hash(bytes)}` === expectedDigest,
		),
		"Immutable manifest digest mismatch",
	);
	const value = JSON.parse(raw);
	assert.ok(!value.manifests && value.schemaVersion === 2 && value.config && Array.isArray(value.layers) && value.layers.length);
	assert.match(value.config.digest, digestPattern);
	for (const layer of value.layers) assert.match(layer.digest, digestPattern);
	return value;
}

function parseReceipt(raw: string, source: string) {
	const receipt = JSON.parse(raw) as PublicationReceipt;
	assert.equal(raw, `${JSON.stringify(receipt, null, 2)}\n`, "Publication receipt bytes changed");
	assert.deepEqual(Object.keys(receipt).sort(), ["commitSha", "images", "platform", "schemaVersion"]);
	assert.equal(receipt.schemaVersion, 1);
	assert.equal(receipt.commitSha, source);
	assert.equal(receipt.platform, "linux/amd64");
	assert.deepEqual(Object.keys(receipt.images).sort(), ["signedOwnEntry"]);
	assert.equal(receipt.images.signedOwnEntry.repository, sourceRepository);
	assert.match(receipt.images.signedOwnEntry.digest, digestPattern);
	return receipt.images.signedOwnEntry;
}

export function validateOriginRun(
	metadata: OriginRunMetadata,
	originRunId: string,
	originAttempt: string,
) {
	assert.equal(String(metadata.databaseId), originRunId);
	assert.match(originAttempt, /^[1-9][0-9]{0,3}$/);
	assert.equal(String(metadata.attempt), originAttempt);
	assert.equal(metadata.status, "completed");
	assert.equal(metadata.conclusion, "success");
	assert.equal(metadata.event, "workflow_dispatch");
	assert.equal(metadata.headBranch, "main");
	assert.equal(metadata.workflowName, "Publish signed own entry");
}

export async function promote(
	input: {
		readonly receipt: string;
		readonly runMetadata: OriginRunMetadata;
		readonly originRunId: string;
		readonly originAttempt: string;
		readonly runId: string;
		readonly attempt: string;
		readonly source: string;
		readonly ref: string;
		readonly workflowSha: string;
		readonly record: (value: unknown, exclusive: boolean) => Promise<void>;
	},
	run: Command = docker,
) {
	assert.match(input.source, sourcePattern, "Promotion source is required");
	assert.equal(input.ref, "refs/heads/main", "Promotion workflow must run from main");
	assert.match(input.workflowSha, sourcePattern, "Promotion workflow SHA is required");
	assert.match(input.originRunId, /^[1-9][0-9]{0,19}$/);
	assert.match(input.runId, /^[1-9][0-9]{0,19}$/);
	assert.match(input.attempt, /^[1-9][0-9]{0,3}$/);
	assert.equal(input.attempt, "1", "Promotion reruns require a new normal scope; do not replay");
	validateOriginRun(input.runMetadata, input.originRunId, input.originAttempt);
	const origin = parseReceipt(input.receipt, input.source);
	const sourceReference = `${origin.repository}@${origin.digest}`;
	const targetTag = `ownentry-${input.source.slice(0, 12)}-${input.originRunId}-${input.originAttempt}`;
	const targetReference = `${targetRepository}:${targetTag}`;
	const before = readManifest(run, sourceReference, origin.digest);
	const image = JSON.parse(output(run, ["buildx", "imagetools", "inspect", sourceReference, "--format", "{{json .Image}}"]));
	assert.equal(image.os, "linux");
	assert.equal(image.architecture, "amd64");
	assert.equal(image.config?.Labels?.["org.opencontainers.image.revision"], input.source);
	assert.deepEqual(JSON.parse(image.config?.Labels?.["io.agora.agent.runtime.manifest"]), {
		schemaVersion: 1,
		interactionMode: "self-managed",
		service: { port: 3003 },
		health: { path: "/healthz" },
	});
	assert.deepEqual(image.config?.Entrypoint, ["node", "/app/signed-server.ts"]);
	assert.ok(image.config?.Cmd == null || image.config.Cmd.length === 0);
	const exists = run(["manifest", "inspect", targetReference]);
	assert.ok(
		exists.status !== 0 && /manifest unknown|manifest_unknown|no such manifest/i.test(exists.stderr) &&
			!/unauthori[sz]ed|denied|forbidden|timeout/i.test(exists.stderr),
		"Target must be definitively absent; never overwrite or infer missing from auth/transport failure",
	);
	const evidence = {
		schemaVersion: 1,
		kind: "signed-own-entry-promotion",
		generatedAt: new Date().toISOString(),
		origin: { repository: origin.repository, targetRepository, digest: origin.digest, source: input.source, workflow: input.runMetadata.headSha, run: Number(input.originRunId), receiptHash: hash(input.receipt) },
		promotionWorkflowSha: input.workflowSha,
		promotionRun: input.runId,
		promotionAttempt: input.attempt,
		originRun: input.originRunId,
		originAttempt: input.originAttempt,
		sourceReference,
		targetReference,
		platform: "linux/amd64",
		sourceManifestDigest: origin.digest,
		configDigest: before.config.digest,
		layerDigests: before.layers.map((layer: { digest: string }) => layer.digest),
		status: "COPY_STARTED",
		verified: false,
		runtimeRole: "self-managed",
		deploymentAccepted: false,
	};
	await input.record(evidence, true);
	output(run, ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", targetReference, sourceReference]);
	const after = readManifest(run, targetReference, origin.digest);
	assert.deepEqual(after, before, "Promotion changed manifest/config/layer descriptors");
	const targetImmutable = `${targetRepository}@${origin.digest}`;
	assert.deepEqual(readManifest(run, targetImmutable, origin.digest), before);
	const targetImage = JSON.parse(output(run, ["buildx", "imagetools", "inspect", targetImmutable, "--format", "{{json .Image}}"]));
	assert.deepEqual(targetImage, image, "Promoted config differs or is unavailable");
	const result = { ...evidence, status: "VERIFIED", verified: true, targetManifestDigest: origin.digest, targetConfigDigest: after.config.digest, targetLayerDigests: after.layers.map((layer: { digest: string }) => layer.digest) };
	await input.record(result, false);
	return result;
}

async function main() {
	const [receiptPath, runPath, outputPath, ...extra] = process.argv.slice(2);
	assert.ok(receiptPath && runPath && outputPath && !extra.length);
	try {
		await readFile(outputPath);
		throw new Error("Promotion output already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await promote({
		receipt: await readFile(receiptPath, "utf8"),
		runMetadata: JSON.parse(await readFile(runPath, "utf8")),
		originRunId: process.env.PROMOTION_ORIGIN_RUN_ID ?? "",
		originAttempt: process.env.PROMOTION_ORIGIN_ATTEMPT ?? "",
		runId: process.env.GITHUB_RUN_ID ?? "",
		attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
		source: process.env.RELEASE_SOURCE_SHA ?? "",
		ref: process.env.GITHUB_REF ?? "",
		workflowSha: process.env.GITHUB_SHA ?? "",
		record: async (value, exclusive) => {
			await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? "wx" : "w", mode: 0o600 });
		},
	});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch(() => {
		console.error("SIGNED_OWN_ENTRY_PROMOTION_FAILED; preserve intent and do not retry unknown writes");
		process.exitCode = 1;
	});
