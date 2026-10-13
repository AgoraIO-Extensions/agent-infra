import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import {
	createChromiumBrowserSessionControllerV1,
	verifyChromiumInstallationV1,
} from "@agent-infra/agent-runtime";
import type {
	BrowserCapabilityAvailableV1,
	BrowserCapabilityBindingV1,
	BrowserCapabilityDeclarationV1,
	RuntimeBrowserCapabilityProbeEvidenceV1,
} from "@agent-infra/contracts/runtime";

/**
 * Verify the deployment-owned Chromium and create the minimal local evidence
 * required before Browser tools can be admitted. The probe never uses a
 * caller URL or external content and its temporary profile is removed before
 * returning.
 */
export async function probeRuntimeBrowserCapabilityV1(input: {
	readonly dataDirectory: string;
	readonly declaration: BrowserCapabilityDeclarationV1;
	readonly binding: BrowserCapabilityBindingV1;
	readonly signal: AbortSignal;
}): Promise<RuntimeBrowserCapabilityProbeEvidenceV1 | undefined> {
	if (!input.declaration.operations.includes("observe")) return undefined;
	input.signal.throwIfAborted();
	const installation = await verifyChromiumInstallationV1();
	const root = await mkdtemp(join(input.dataDirectory, ".browser-probe-"));
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(
			"<html><body><main>agent-infra-browser-readiness</main></body></html>",
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("BROWSER_PROBE_SERVER_UNAVAILABLE");
	const probeOrigin = `http://127.0.0.1:${address.port}/`;
	const operations = ["observe"] as const;
	const verifiedAt = new Date().toISOString();
	const evidenceHash = createHash("sha256")
		.update(
			JSON.stringify({
				binding: input.binding,
				chromiumVersion: installation.chromiumVersion,
				playwrightVersion: installation.playwrightVersion,
				operations,
			}),
		)
		.digest("hex");
	const capability: BrowserCapabilityAvailableV1 = {
		schemaVersion: 1,
		capabilityVersion: input.declaration.capabilityVersion,
		status: "available",
		operations: [...operations],
		policy: input.declaration.policy,
		provenance: {
			browser: "chromium",
			chromiumVersion: installation.chromiumVersion,
			playwrightVersion: installation.playwrightVersion,
			imageDigest: input.binding.imageDigest,
		},
		conformance: {
			schemaVersion: 1,
			receiptId: randomUUID(),
			probeVersion: "runtime-browser-probe-v1",
			verifiedAt,
			manifestDigest: input.binding.imageDigest,
			evidenceHash,
			operations: [...operations],
		},
	};
	const probeCapability: BrowserCapabilityAvailableV1 = {
		...capability,
		policy: { ...capability.policy, allowedOrigins: [probeOrigin] },
	};
	const session = createChromiumBrowserSessionControllerV1({
		sandboxRoot: root,
		binding: {
			agentId: input.binding.agentId,
			conversationId: input.binding.sessionId,
			sessionGeneration: input.binding.sessionGeneration,
			resourceFence: input.binding.resourceFence,
			workloadRevision: input.binding.workloadRevision,
			imageDigest: input.binding.imageDigest,
		},
		capability: probeCapability,
	});
	try {
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => {
				void session.close().catch(() => undefined);
				reject(new Error("RUNTIME_BROWSER_PROBE_INTERRUPTED"));
			};
			input.signal.addEventListener("abort", onAbort, { once: true });
		});
		const snapshot = await Promise.race([session.start(), aborted]).finally(
			() => {
				if (onAbort) input.signal.removeEventListener("abort", onAbort);
			},
		);
		input.signal.throwIfAborted();
		if (snapshot.status !== "ready") return undefined;
		const page = await session.navigate(probeOrigin);
		const observation = await session.observe(page);
		if (!observation.text.includes("agent-infra-browser-readiness"))
			return undefined;
		return {
			capabilityVersion: capability.capabilityVersion,
			operations: [...operations],
			provenance: capability.provenance,
			conformance: capability.conformance,
			binding: input.binding,
		};
	} finally {
		await session.close().catch(() => undefined);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
}
