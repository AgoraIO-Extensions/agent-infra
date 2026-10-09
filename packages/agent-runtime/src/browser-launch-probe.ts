import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import type { BrowserContext } from "playwright-core";
import { createChromiumBrowserContextManagerV1 } from "./browser-context.js";
import { verifyChromiumInstallationV1 } from "./browser-installation.js";

/** Controlled image test, never a Browser Capability conformance projection. */
export async function probeChromiumLaunchV1() {
	if (process.getuid?.() === 0)
		throw new Error("RUNTIME_BROWSER_PROBE_NON_ROOT_REQUIRED");
	const installation = await verifyChromiumInstallationV1();
	const root = await mkdtemp(join(tmpdir(), "agent-infra-browser-probe-"));
	const manager = createChromiumBrowserContextManagerV1({ sandboxRoot: root });
	const binding = {
		agentId: "controlled-probe-agent",
		conversationId: "controlled-probe-conversation",
		sessionGeneration: 1,
		resourceFence: 1,
	};
	// This fixture only drives the manager API inside the network-free image test.
	// Its synthetic receipt/digests are never returned, published or accepted as
	// production availability, Session security or four-template conformance.
	const capability: BrowserCapabilityProjectionV1 = {
		schemaVersion: 1,
		capabilityVersion: 1,
		status: "available",
		operations: ["observe"],
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
			receiptId: "controlled-image-manager-fixture",
			probeVersion: "fixture-1",
			verifiedAt: "2026-10-09T00:00:00Z",
			manifestDigest: `sha256:${"0".repeat(64)}`,
			evidenceHash: "0".repeat(64),
			operations: ["observe"],
		},
	};
	const url = "https://browser-probe.invalid/";
	const html =
		"<title>Browser supply probe</title><button onclick=\"this.textContent='Clicked';localStorage.setItem('probe-state','retained')\">Continue</button><output aria-label=\"Profile state\"></output><script>document.querySelector('output').textContent=localStorage.getItem('probe-state')||'empty'</script>";
	async function openPage(context: BrowserContext) {
		await context.route("**/*", (route) =>
			route.request().url() === url
				? route.fulfill({ contentType: "text/html", body: html })
				: route.abort(),
		);
		const page = context.pages()[0] ?? (await context.newPage());
		page.setDefaultTimeout(5_000);
		await page.goto(url, { timeout: 15_000 });
		return page;
	}
	try {
		const context = await manager.acquire(binding, capability);
		const version = await promisify(execFile)(
			installation.executable,
			["--version"],
			{ timeout: 15_000, maxBuffer: 1024 },
		);
		if (
			version.stdout.trim().split(" ").at(-1) !== installation.chromiumVersion
		)
			throw new Error();
		if ((await manager.resume(binding, capability)) !== context)
			throw new Error();
		const page = await openPage(context);
		if ((await page.title()) !== "Browser supply probe") throw new Error();
		await page.getByRole("button", { name: "Continue" }).click();
		if ((await page.getByRole("button").innerText()) !== "Clicked")
			throw new Error();
		await manager.close(binding);
		if (manager.snapshot().status !== "closed") throw new Error();
		const resumed = await manager.resume(binding, capability);
		const restored = await openPage(resumed);
		if (
			(await restored
				.getByRole("status", { name: "Profile state" })
				.innerText()) !== "retained"
		)
			throw new Error();
		await manager.close(binding);
		if (manager.snapshot().status !== "closed") throw new Error();
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
		throw new Error("RUNTIME_BROWSER_LAUNCH_PROBE_FAILED");
	} finally {
		try {
			await manager.close(binding);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}
