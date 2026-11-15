import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const origin = Object.freeze({
	repository: "ghcr.io/agoraio-extensions/agent-infra/custom-agent-web-signed",
	targetRepository:
		"ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex",
	digest:
		"sha256:45cf40eb5595b0fd48af1f73ae1324aa06793f72e07858413fea7f7362686051",
	source: "4a3c2840e0d918dfc6fef77ce1cb1b7fffc46c60",
	workflow: "334a244152ddef9baba24bcd7eb4fbfc7735317b",
	run: 43741080676,
	receiptHash:
		"0c34fc16cd65299cfdbc2c40bf4c0d9c2f33bf4c4cd9e393e629312fdc383227",
});
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
type Command = (args: string[]) => {
	status: number | null;
	stdout: string;
	stderr: string;
};
function docker(args: string[]) {
	const result = spawnSync("docker", args, {
		encoding: "utf8",
		timeout: 10 * 60_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}
function output(run: Command, args: string[]) {
	const result = run(args);
	assert.equal(
		result.status,
		0,
		"Registry operation failed; no automatic retry",
	);
	return result.stdout;
}
function manifest(run: Command, reference: string) {
	const raw = output(run, [
		"buildx",
		"imagetools",
		"inspect",
		"--raw",
		reference,
	]);
	// Docker versions may append one display newline to the Registry bytes.
	assert.ok(
		[raw, raw.replace(/\n$/, "")].some(
			(bytes) => `sha256:${hash(bytes)}` === origin.digest,
		),
		"Immutable manifest digest mismatch",
	);
	const value = JSON.parse(raw);
	assert.ok(
		!value.manifests &&
			value.schemaVersion === 2 &&
			value.config &&
			Array.isArray(value.layers) &&
			value.layers.length,
		"Expected one architecture manifest",
	);
	assert.match(value.config.digest, /^sha256:[a-f0-9]{64}$/);
	for (const layer of value.layers)
		assert.match(layer.digest, /^sha256:[a-f0-9]{64}$/);
	return value;
}
export async function promote(
	input: {
		receipt: string;
		runMetadata: unknown;
		runId: string;
		attempt: string;
		source: string;
		ref: string;
		workflowSha: string;
		record: (value: unknown, exclusive: boolean) => Promise<void>;
	},
	run: Command = docker,
) {
	assert.equal(
		input.ref,
		"refs/heads/main",
		"Promotion workflow must run from main",
	);
	assert.equal(input.source, origin.source, "Promotion source is fixed");
	assert.match(
		input.workflowSha,
		/^[a-f0-9]{40}$/,
		"Promotion workflow SHA is required",
	);
	assert.match(input.runId, /^[1-9][0-9]{0,19}$/);
	assert.equal(
		input.attempt,
		"1",
		"Promotion reruns require a new normal scope; do not replay",
	);
	assert.equal(
		hash(input.receipt),
		origin.receiptHash,
		"Official receipt bytes changed",
	);
	const receipt = JSON.parse(input.receipt);
	assert.deepEqual(receipt, {
		schemaVersion: 1,
		commitSha: origin.source,
		platform: "linux/amd64",
		images: {
			signedOwnEntry: { repository: origin.repository, digest: origin.digest },
		},
	});
	const prior = input.runMetadata as {
		databaseId: number;
		headSha: string;
		conclusion: string;
		status: string;
		attempt: number;
	};
	assert.ok(
		prior.databaseId === origin.run &&
			prior.headSha === origin.workflow &&
			prior.status === "completed" &&
			prior.conclusion === "success" &&
			prior.attempt === 1,
		"Official origin run is not verified",
	);
	const sourceReference = `${origin.repository}@${origin.digest}`;
	const targetTag = `ownentry-45cf40eb5595-${input.runId}-${input.attempt}`;
	const targetReference = `${origin.targetRepository}:${targetTag}`;
	const before = manifest(run, sourceReference);
	const image = JSON.parse(
		output(run, [
			"buildx",
			"imagetools",
			"inspect",
			sourceReference,
			"--format",
			"{{json .Image}}",
		]),
	);
	assert.equal(image.os, "linux");
	assert.equal(image.architecture, "amd64");
	assert.equal(
		image.config?.Labels?.["org.opencontainers.image.revision"],
		origin.source,
	);
	assert.deepEqual(
		JSON.parse(image.config?.Labels?.["io.agora.agent.runtime.manifest"]),
		{
			schemaVersion: 1,
			interactionMode: "self-managed",
			service: { port: 3003 },
			health: { path: "/healthz" },
		},
	);
	assert.deepEqual(image.config?.Entrypoint, ["node", "/app/signed-server.ts"]);
	assert.ok(image.config?.Cmd == null || image.config.Cmd.length === 0);
	const exists = run(["manifest", "inspect", targetReference]);
	assert.ok(
		exists.status !== 0 &&
			/manifest unknown|manifest_unknown|no such manifest/i.test(
				exists.stderr,
			) &&
			!/unauthori[sz]ed|denied|forbidden|timeout/i.test(exists.stderr),
		"Target must be definitively absent; never overwrite or infer missing from auth/transport failure",
	);
	const evidence = {
		schemaVersion: 1,
		kind: "signed-own-entry-promotion",
		generatedAt: new Date().toISOString(),
		origin,
		promotionWorkflowSha: input.workflowSha,
		promotionRun: input.runId,
		promotionAttempt: input.attempt,
		sourceReference,
		targetReference,
		platform: "linux/amd64",
		sourceManifestDigest: origin.digest,
		configDigest: before.config.digest,
		layerDigests: before.layers.map(
			(layer: { digest: string }) => layer.digest,
		),
		status: "COPY_STARTED",
		verified: false,
		runtimeRole: "self-managed",
		deploymentAccepted: false,
	};
	// Exclusive intent survives unknown copy outcomes; callers must never replay it.
	await input.record(evidence, true);
	output(run, [
		"buildx",
		"imagetools",
		"create",
		"--prefer-index=false",
		"--tag",
		targetReference,
		sourceReference,
	]);
	const after = manifest(run, targetReference);
	assert.deepEqual(
		after,
		before,
		"Promotion changed manifest/config/layer descriptors",
	);
	// Read immutable target as well as the unique tag before accepting the result.
	assert.deepEqual(
		manifest(run, `${origin.targetRepository}@${origin.digest}`),
		before,
	);
	const targetImage = JSON.parse(
		output(run, [
			"buildx",
			"imagetools",
			"inspect",
			`${origin.targetRepository}@${origin.digest}`,
			"--format",
			"{{json .Image}}",
		]),
	);
	assert.deepEqual(
		targetImage,
		image,
		"Promoted config differs or is unavailable",
	);
	const result = {
		...evidence,
		status: "VERIFIED",
		verified: true,
		targetManifestDigest: origin.digest,
		targetConfigDigest: after.config.digest,
		targetLayerDigests: after.layers.map(
			(layer: { digest: string }) => layer.digest,
		),
	};
	await input.record(result, false);
	return result;
}
async function main() {
	const [receiptPath, runPath, outputPath, ...extra] = process.argv.slice(2);
	assert.ok(
		receiptPath && runPath && outputPath && !extra.length,
		"Expected official receipt, origin run metadata and new output file",
	);
	// Refuse an existing output before touching Registry state.
	try {
		await readFile(outputPath);
		throw new Error("Promotion output already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await promote({
		receipt: await readFile(receiptPath, "utf8"),
		runMetadata: JSON.parse(await readFile(runPath, "utf8")),
		runId: process.env.GITHUB_RUN_ID ?? "",
		attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
		source: process.env.RELEASE_SOURCE_SHA ?? "",
		ref: process.env.GITHUB_REF ?? "",
		workflowSha: process.env.GITHUB_SHA ?? "",
		record: async (value, exclusive) => {
			await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, {
				flag: exclusive ? "wx" : "w",
				mode: 0o600,
			});
		},
	});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch(() => {
		console.error(
			"SIGNED_OWN_ENTRY_PROMOTION_FAILED; preserve intent and do not retry unknown writes",
		);
		process.exitCode = 1;
	});
