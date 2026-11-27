import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { BrowserCapabilityDeclarationV1 } from "../../packages/contracts/src/runtime/browser-capability.ts";
import { RuntimeManifestBrowserAdmissionV1Schema } from "../../packages/contracts/src/workload/runtime-manifest.ts";

export function piBrowserCandidateManifest(
	labels: Record<string, string>,
	sourceCommit: string,
	siteOrigin: string,
) {
	assert(
		/^[a-f0-9]{40}$/.test(sourceCommit) &&
			labels["org.opencontainers.image.revision"] === sourceCommit,
		"PI_CANDIDATE_SOURCE_MISMATCH",
	);
	assert.equal(labels["io.agora.agent.standard-template"], "pi");
	const manifest = RuntimeManifestBrowserAdmissionV1Schema.parse(
		JSON.parse(labels["io.agora.agent.runtime.manifest"] ?? "null"),
	);
	assert(
		manifest.interactionMode === "platform-adapter" &&
			manifest.capabilities?.resultFiles,
		"PI_CANDIDATE_RESULT_FILES_REQUIRED",
	);
	const url = new URL(siteOrigin);
	assert(
		url.protocol === "https:" &&
			(siteOrigin === url.origin || siteOrigin === url.origin + "/"),
		"PI_CANDIDATE_SITE_ORIGIN_INVALID",
	);
	const browser: BrowserCapabilityDeclarationV1 = {
		schemaVersion: 1,
		capabilityVersion: 1,
		operations: ["navigate", "observe", "interact"],
		policy: {
			allowedOrigins: [url.origin + "/"],
			maxContexts: 1,
			maxTabs: 1,
			maxPages: 1,
			maxViewportWidth: 1280,
			maxViewportHeight: 800,
			maxConcurrentActions: 1,
			maxDownloads: 0,
			maxDownloadBytes: 0,
			maxUploadBytes: 0,
			maxScreenshotBytes: 0,
			maxBrowserDurationMs: 180_000,
			maxRetainedProfileBytes: 32 * 1024 * 1024,
			navigationTimeoutMs: 15_000,
			actionTimeoutMs: 5_000,
			requireSideEffectConfirmation: true,
			allowUserHandoff: false,
		},
	};
	const candidate = {
		...manifest,
		capabilities: { ...manifest.capabilities, browser },
	};
	RuntimeManifestBrowserAdmissionV1Schema.parse(candidate);
	return candidate;
}

if (import.meta.main) {
	const [configFile, sourceCommit, siteOrigin] = process.argv.slice(2);
	assert(
		configFile && sourceCommit && siteOrigin,
		"Pass OCI config file, source commit and controlled HTTPS origin",
	);
	const { config } = JSON.parse(await readFile(configFile, "utf8"));
	process.stdout.write(
		JSON.stringify(
			piBrowserCandidateManifest(config.Labels, sourceCommit, siteOrigin),
		) + "\n",
	);
}
