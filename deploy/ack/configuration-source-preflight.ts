import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { privateBytes, privateJson } from "./private-input.ts";

const failureCodes = [
	"CONFIG_SOURCE_INPUT_INVALID",
	"CONFIG_RUNTIME_DIGEST_MISMATCH",
	"CONFIG_TEMPLATE_DIGEST_MISMATCH",
	"CONFIG_CUSTOM_DIGEST_MISMATCH",
] as const;
type FailureCode = (typeof failureCodes)[number];

function failure(failureCode: FailureCode, detail: string) {
	return { schemaVersion: 1, kind: "ack-configuration-source-preflight", status: "failed", failureCode, detail, businessVerified: false };
}

function fileReference(input: any, name: string, key: string) {
	const object = input.objects?.find((entry: any) => entry.kind === "Secret" && entry.name === name);
	const file = object?.files?.[key];
	assert(typeof file === "string", "CONFIG_SOURCE_INPUT_INVALID");
	return file;
}

function customDigests(source: string) {
	const declared = source.match(/customDigests\s*=\s*\[((?:.|\n)*?)\]/u)?.[1];
	const inline = source.match(
		/usage\s*===\s*["']custom-agent["'][\s\S]{0,6000}?\[((?:.|\n)*?)\]\.includes\(input\.immutableDigest\)/u,
	)?.[1];
	return new Set((declared ?? inline ?? "").match(/sha256:[0-9a-f]{64}/gu) ?? []);
}

export async function validateConfigurationSourceBindings(
	bootstrapFile: string,
	runtimeManifestFile: string,
	templateManifestFile: string,
	sourceSha: string,
) {
	try {
		assert(/^[a-f0-9]{40}$/u.test(sourceSha));
		const [bootstrap, runtime, templates] = await Promise.all([
			privateJson(bootstrapFile),
			privateJson(runtimeManifestFile),
			privateJson(templateManifestFile),
		]);
		assert(bootstrap.schemaVersion === 1 && runtime.commitSha === sourceSha && templates.commitSha === sourceSha);
		const runtimeDigest = runtime.images?.runtimeHost?.digest ?? runtime.digest;
		assert(typeof runtimeDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(runtimeDigest));
		const expectedTemplates: Record<string, string> = Object.fromEntries(
			Object.entries(templates.images ?? {}).map(([templateId, image]: [string, any]) => [templateId, image.digest]),
		);
		for (const templateId of ["codex", "claude", "opencode", "pi"])
			assert(/^sha256:[a-f0-9]{64}$/u.test(expectedTemplates[templateId] ?? ""));
		const worker = new TextDecoder("utf-8", { fatal: true }).decode(await privateBytes(fileReference(bootstrap, "agent-infra-worker-configuration", "configuration.mjs")));
		const api = new TextDecoder("utf-8", { fatal: true }).decode(await privateBytes(fileReference(bootstrap, "agent-infra-api-configuration", "configuration.mjs")));
		const workerCustomDigests = customDigests(worker);
		const apiEntrypointFile = bootstrap.objects?.find((entry: any) => entry.kind === "Secret" && entry.name === "agent-infra-api-configuration")?.files?.["api-configuration.mjs"];
		if (typeof apiEntrypointFile === "string") {
			const apiEntrypoint = new TextDecoder("utf-8", { fatal: true }).decode(await privateBytes(apiEntrypointFile));
			const apiCustomDigests = customDigests(apiEntrypoint);
			if (
				workerCustomDigests.size !== apiCustomDigests.size ||
				[...workerCustomDigests].some((digest) => !apiCustomDigests.has(digest))
			)
				return failure("CONFIG_CUSTOM_DIGEST_MISMATCH", "API and Worker custom admission digests differ");
		} else if (workerCustomDigests.size > 0) {
			return failure("CONFIG_CUSTOM_DIGEST_MISMATCH", "API custom admission entrypoint is missing");
		}
		if (!worker.includes(`runtimeDigest!==\"${runtimeDigest}\"`)) return failure("CONFIG_RUNTIME_DIGEST_MISMATCH", "worker runtime binding differs from the published RuntimeHost digest");
		const apiRuntimeBinding = /(?:runtimeDigest|AGENT_INFRA_RUNTIME_IMAGE_DIGEST|agent-runtime-host@sha256:|runtimeHost[^\n]*sha256:)/u.test(api);
		if (apiRuntimeBinding && !api.includes(runtimeDigest)) return failure("CONFIG_RUNTIME_DIGEST_MISMATCH", "API runtime binding differs from the published RuntimeHost digest");
		for (const [templateId, digest] of Object.entries(expectedTemplates)) {
			const escapedTemplate = templateId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
			const escapedDigest = digest.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
			const binding = new RegExp(`["']?templateId["']?\\s*[:=]\\s*["']${escapedTemplate}["'][\\s\\S]{0,300}?["']?imageDigest["']?\\s*[:=]\\s*["']${escapedDigest}["']`, "u");
			if (!binding.test(worker) || !binding.test(api)) return failure("CONFIG_TEMPLATE_DIGEST_MISMATCH", `active ${templateId} binding differs from the published template digest`);
		}
		return { schemaVersion: 1, kind: "ack-configuration-source-preflight", status: "passed", sourceSha, runtimeDigest, templateCount: 4, businessVerified: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const failureCode = failureCodes.find((code) => message.startsWith(code)) ?? "CONFIG_SOURCE_INPUT_INVALID";
		return failure(failureCode, "source-bound configuration inputs are incomplete or invalid");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [bootstrap, runtime, templates, sourceSha, output] = process.argv.slice(2);
		assert(bootstrap && runtime && templates && sourceSha && output);
		const receipt = await validateConfigurationSourceBindings(bootstrap, runtime, templates, sourceSha);
		await readFile(bootstrap); // Keep the CLI's required input contract explicit for private callers.
		await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
		if (receipt.status !== "passed") process.exitCode = 1;
	} catch {
		process.stderr.write("ACK_CONFIGURATION_SOURCE_PREFLIGHT_FAILED\n");
		process.exitCode = 1;
	}
}
