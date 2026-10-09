import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { verifyChromiumInstallationV1 } from "./browser-installation.js";
import { createChromiumBrowserSessionControllerV1 } from "./browser-session.js";

/** Controlled image test, never a Browser Capability conformance projection. */
export async function probeChromiumLaunchV1() {
	if (process.getuid?.() === 0)
		throw new Error("RUNTIME_BROWSER_PROBE_NON_ROOT_REQUIRED");
	const installation = await verifyChromiumInstallationV1();
	const root = await mkdtemp(join(tmpdir(), "agent-infra-browser-probe-"));
	const binding = {
		agentId: "controlled-probe-agent",
		conversationId: "controlled-probe-conversation",
		sessionGeneration: 1,
		resourceFence: 1,
	};
	// This fixture only drives the Session facade inside the network-free image test.
	// Its synthetic receipt/digests are never returned, published or accepted as
	// production availability, Session security or four-template conformance.
	const capability: BrowserCapabilityAvailableV1 = {
		schemaVersion: 1,
		capabilityVersion: 1,
		status: "available",
		operations: ["observe", "interact"],
		policy: {
			allowedOrigins: ["https://browser-probe.invalid/"],
			maxContexts: 1,
			maxTabs: 1,
			maxPages: 1,
			maxViewportWidth: 1280,
			maxViewportHeight: 720,
			maxConcurrentActions: 1,
			maxDownloads: 1,
			maxDownloadBytes: 1024,
			maxUploadBytes: 1024,
			maxScreenshotBytes: 1024,
			maxBrowserDurationMs: 60_000,
			maxRetainedProfileBytes: 100_000_000,
			navigationTimeoutMs: 15_000,
			actionTimeoutMs: 5_000,
			requireSideEffectConfirmation: true,
			allowUserHandoff: false,
		},
		provenance: {
			browser: "chromium",
			chromiumVersion: installation.chromiumVersion,
			playwrightVersion: installation.playwrightVersion,
			imageDigest: `sha256:${"0".repeat(64)}`,
		},
		conformance: {
			schemaVersion: 1,
			receiptId: "controlled-image-session-fixture",
			probeVersion: "fixture-1",
			verifiedAt: "2026-10-09T00:00:00Z",
			manifestDigest: `sha256:${"0".repeat(64)}`,
			evidenceHash: "0".repeat(64),
			operations: ["observe", "interact"],
		},
	};
	const url = "https://browser-probe.invalid/";
	const html =
		"<title>Browser supply probe</title><button onclick=\"this.textContent='Clicked';localStorage.setItem('probe-state','retained')\">Continue</button><output aria-label=\"Profile state\"></output><script>document.querySelector('output').textContent=localStorage.getItem('probe-state')||'empty'</script>";
	const session = createChromiumBrowserSessionControllerV1({
		sandboxRoot: root,
		binding,
		capability,
		controlledFixture: { url, body: html },
	});
	let phase = "start";
	try {
		const started = await session.start();
		if (started.status !== "ready") throw new Error();
		phase = "version";
		const version = await promisify(execFile)(
			installation.executable,
			["--version"],
			{ timeout: 15_000, maxBuffer: 1024 },
		);
		if (
			version.stdout.trim().split(" ").at(-1) !== installation.chromiumVersion
		)
			throw new Error();
		phase = "navigate";
		const page = await session.navigate(url);
		phase = "observe";
		const initial = await session.observe(page);
		if (initial.title !== "Browser supply probe") throw new Error();
		const target = initial.elements.find(
			(element) => element.name === "Continue",
		);
		if (!target) throw new Error();
		phase = "act";
		const action = await session.act({
			kind: "click",
			page,
			target,
			operationRef: "probe-operation",
			attemptRef: "probe-attempt",
			idempotencyKey: "probe-click",
		});
		if (action.status !== "completed") throw new Error();
		const clicked = await session.observe(page);
		if (!clicked.text.includes("Clicked")) throw new Error();
		phase = "close";
		await session.close();
		if (session.snapshot().status !== "closed") throw new Error();
		phase = "resume-start";
		const resumed = await session.start();
		if (resumed.status !== "ready") throw new Error();
		phase = "resume-navigate";
		const restoredPage = await session.navigate(url);
		phase = "resume-observe";
		const restored = await session.observe(restoredPage);
		if (!restored.text.includes("retained")) throw new Error();
		phase = "resume-close";
		await session.close();
		if (session.snapshot().status !== "closed") throw new Error();
		return {
			schemaVersion: 1 as const,
			status: "passed" as const,
			scope: "controlled-image-supply-and-launch" as const,
			installation,
			checks: [
				"non-root",
				"pinned-binary",
				"browser-version",
				"page-observation",
				"page-interaction",
				"persistent-context",
				"context-reuse",
				"context-close",
				"profile-resume",
			],
		};
	} catch {
		console.error(`RUNTIME_BROWSER_LAUNCH_PROBE_PHASE=${phase}`);
		throw new Error("RUNTIME_BROWSER_LAUNCH_PROBE_FAILED");
	} finally {
		try {
			await session.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}
