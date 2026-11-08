import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";
import { privateBytes, privateJson } from "./private-input.ts";

const failureCodes = [
	"CONFIG_SOURCE_INPUT_INVALID",
	"CONFIG_RUNTIME_DIGEST_MISMATCH",
	"CONFIG_TEMPLATE_DIGEST_MISMATCH",
] as const;
type FailureCode = (typeof failureCodes)[number];

function failure(failureCode: FailureCode, detail: string) {
	return { schemaVersion: 1, kind: "ack-configuration-source-preflight", status: "failed", failureCode, detail, businessVerified: false };
}

function configurationFile(input: any, documents: any[], component: "api" | "worker") {
	const deployments = documents.filter((entry) => entry?.kind === "Deployment" && entry.metadata?.name === `agent-infra-${component}`);
	assert(deployments.length === 1);
	const spec = deployments[0].spec?.template?.spec;
	const containers = spec?.containers?.filter((entry: any) => entry.name === `platform-${component}`);
	assert(containers?.length === 1);
	const container = containers[0];
	const variable = component === "api" ? "PLATFORM_API_CONFIGURATION_MODULE" : "PLATFORM_WORKER_DEPLOYMENT_MODULE";
	const environment = container.env?.filter((entry: any) => entry.name === variable);
	assert(environment?.length === 1 && typeof environment[0].value === "string");
	const url = new URL(environment[0].value);
	assert(url.protocol === "file:" && !url.host && !url.search && !url.hash);
	const entryPath = fileURLToPath(url);
	assert(posix.basename(entryPath) === (component === "api" ? "configuration.mjs" : "deployment.mjs"));
	const path = fileURLToPath(new URL("./configuration.mjs", url));
	const mounts = container.volumeMounts?.filter((mount: any) => typeof mount.mountPath === "string" &&
		(path === mount.mountPath || path.startsWith(`${mount.mountPath.replace(/\/$/u, "")}/`)));
	assert(mounts?.length === 1 && mounts[0].readOnly === true && !mounts[0].subPathExpr);
	const mount = mounts[0];
	assert(mount.subPath ? mount.mountPath === path && mount.subPath === "configuration.mjs" : mount.mountPath === posix.dirname(path));
	const volumes = spec.volumes?.filter((volume: any) => volume.name === mounts[0].name);
	assert(volumes?.length === 1 && typeof volumes[0].secret?.secretName === "string" && !volumes[0].secret.items);
	const objects = input.objects?.filter((entry: any) => entry.kind === "Secret" && entry.name === volumes[0].secret.secretName);
	assert(objects?.length === 1);
	const file = objects[0].files?.["configuration.mjs"];
	assert(typeof file === "string", "CONFIG_SOURCE_INPUT_INVALID");
	return file;
}

export async function validateConfigurationSourceBindings(
	bootstrapFile: string,
	runtimeManifestFile: string,
	templateManifestFile: string,
	sourceSha: string,
	rendered: string,
) {
	try {
		assert(/^[a-f0-9]{40}$/u.test(sourceSha));
		const [bootstrap, runtime, templates] = await Promise.all([
			privateJson(bootstrapFile),
			privateJson(runtimeManifestFile),
			privateJson(templateManifestFile),
		]);
		const documents = parseAllDocuments(rendered).map((document) => {
			assert(document.errors.length === 0);
			return document.toJSON();
		});
		assert(bootstrap.schemaVersion === 1 && runtime.commitSha === sourceSha && templates.commitSha === sourceSha);
		const runtimeDigest = runtime.images?.runtimeHost?.digest ?? runtime.digest;
		assert(typeof runtimeDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(runtimeDigest));
		const expectedTemplates: Record<string, string> = Object.fromEntries(
			Object.entries(templates.images ?? {}).map(([templateId, image]: [string, any]) => [templateId, image.digest]),
		);
		for (const templateId of ["codex", "claude", "opencode", "pi"])
			assert(/^sha256:[a-f0-9]{64}$/u.test(expectedTemplates[templateId] ?? ""));
		const worker = new TextDecoder("utf-8", { fatal: true }).decode(await privateBytes(configurationFile(bootstrap, documents, "worker")));
		const api = new TextDecoder("utf-8", { fatal: true }).decode(await privateBytes(configurationFile(bootstrap, documents, "api")));
		if (!worker.includes(`runtimeDigest!=="${runtimeDigest}"`)) return failure("CONFIG_RUNTIME_DIGEST_MISMATCH", "worker runtime binding differs from the published RuntimeHost digest");
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
		const [bootstrap, runtime, templates, sourceSha, output, rendered] = process.argv.slice(2);
		assert(bootstrap && runtime && templates && sourceSha && output && rendered);
		const receipt = await validateConfigurationSourceBindings(bootstrap, runtime, templates, sourceSha, await readFile(rendered, "utf8"));
		await readFile(bootstrap); // Keep the CLI's required input contract explicit for private callers.
		await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
		if (receipt.status !== "passed") process.exitCode = 1;
	} catch {
		process.stderr.write("ACK_CONFIGURATION_SOURCE_PREFLIGHT_FAILED\n");
		process.exitCode = 1;
	}
}
