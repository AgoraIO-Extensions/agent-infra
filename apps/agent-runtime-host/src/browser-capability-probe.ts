import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	createBrowserSessionControllerV1,
	createChromiumBrowserContextManagerV1,
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
	const probeOrigin = "https://runtime-readiness.invalid/";
	const operations = input.declaration.operations.filter(
		(operation) =>
			operation === "navigate" ||
			operation === "observe" ||
			operation === "interact",
	);
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
	const sessionBinding = {
		agentId: input.binding.agentId,
		conversationId: input.binding.sessionId,
		sessionGeneration: input.binding.sessionGeneration,
		resourceFence: input.binding.resourceFence,
		workloadRevision: input.binding.workloadRevision,
		imageDigest: input.binding.imageDigest,
	};
	const root = await mkdtemp(join(input.dataDirectory, ".browser-probe-"));
	const manager = createChromiumBrowserContextManagerV1({ sandboxRoot: root });
	const session = createBrowserSessionControllerV1({
		manager,
		binding: sessionBinding,
		capability: probeCapability,
	});
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= manager.close(sessionBinding);
		return closing;
	};
	const onAbort = () => {
		void close().catch(() => undefined);
	};
	input.signal.addEventListener("abort", onAbort, { once: true });
	try {
		input.signal.throwIfAborted();
		const context = await manager.acquire(sessionBinding, probeCapability);
		input.signal.throwIfAborted();
		const probePage = context.pages()[0] ?? (await context.newPage());
		// 固定页面只在此临时 Context 中由 Playwright 提供；正式私网拒绝策略不变。
		await probePage.route("**/*", async (route) => {
			const request = route.request();
			if (request.url() === probeOrigin && request.method() === "GET")
				await route.fulfill({
					contentType: "text/html; charset=utf-8",
					body: '<html><body><main>agent-infra-browser-readiness</main><button type="button" onclick="this.textContent=\'Clicked\'">Continue</button></body></html>',
				});
			else await route.abort("blockedbyclient");
		});
		input.signal.throwIfAborted();
		const started = await session.start();
		if (started.status !== "ready") return undefined;
		input.signal.throwIfAborted();
		const page = await session.navigate(probeOrigin);
		input.signal.throwIfAborted();
		const observation = await session.observe(page);
		input.signal.throwIfAborted();
		if (!observation.text.includes("agent-infra-browser-readiness"))
			return undefined;
		if (operations.includes("interact")) {
			const target = observation.elements.find(
				(element) => element.name === "Continue",
			);
			if (!target) return undefined;
			const action = await session.act(
				{
					kind: "click",
					page,
					target,
					operationRef: "probe-operation",
					attemptRef: "probe-attempt",
					idempotencyKey: "probe-click",
				},
				input.signal,
			);
			input.signal.throwIfAborted();
			if (action.status !== "completed") return undefined;
			const clicked = await session.observe(action.page);
			input.signal.throwIfAborted();
			if (!clicked.text.includes("Clicked")) return undefined;
		}
		return {
			capabilityVersion: capability.capabilityVersion,
			operations: [...operations],
			provenance: capability.provenance,
			conformance: capability.conformance,
			binding: input.binding,
		};
	} finally {
		input.signal.removeEventListener("abort", onAbort);
		try {
			await close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}
