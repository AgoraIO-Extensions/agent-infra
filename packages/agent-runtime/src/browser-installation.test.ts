import { Readable } from "node:stream";
import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import { type BrowserContext, chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromiumBrowserContextManagerV1 } from "./browser-context.js";
import { verifyChromiumInstallationV1 } from "./browser-installation.js";

// Controlled input for the manager seam; never a production projection.
const capability: BrowserCapabilityProjectionV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["observe"],
	policy: {
		allowedOrigins: ["https://example.test/"],
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
		maxRetainedProfileBytes: 1_000_000,
		navigationTimeoutMs: 15_000,
		actionTimeoutMs: 5_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: false,
	},
	provenance: {
		browser: "chromium",
		chromiumVersion: "153.0.8010.12",
		playwrightVersion: "1.63.0",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "controlled-manager-fixture",
		probeVersion: "fixture-1",
		verifiedAt: "2026-10-09T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["observe"],
	},
};
const binding = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	sessionGeneration: 1,
	resourceFence: 3,
};

const filesystem = vi.hoisted(() => ({ fault: "valid" }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (path: string) => {
			if (path !== "/opt" && !path.startsWith("/opt/agent-infra"))
				return actual.lstat(path);
			if (filesystem.fault === "missing") throw new Error("ENOENT");
			const file =
				path.endsWith("/chrome") ||
				path.endsWith("/release.json") ||
				path.endsWith(".so");
			return {
				uid: 0,
				gid: 0,
				nlink: 1,
				mode:
					filesystem.fault === "library-writable" && path.endsWith(".so")
						? 0o666
						: filesystem.fault === "writable"
							? 0o777
							: filesystem.fault === "root-writable" && file
								? 0o755
								: 0o555,
				isFile: () => file,
				isDirectory: () => !file,
			};
		},
		readdir: async (path: string) => {
			const directory =
				process.arch === "x64" ? "chrome-linux64" : "chrome-linux-arm64";
			if (path === "/opt/agent-infra/browser")
				return ["release.json", directory];
			if (path === `/opt/agent-infra/browser/${directory}`)
				return ["chrome", "libEGL.so"];
			return [];
		},
		realpath: async (path: string) =>
			path.startsWith("/opt")
				? filesystem.fault === "symlink"
					? "/tmp/replaced"
					: path
				: actual.realpath(path),
		readFile: async (path: string, encoding: string) => {
			if (path === "/opt/agent-infra/browser/release.json")
				return actual.readFile(
					new URL("./browser-release.json", import.meta.url),
					"utf8",
				);
			if (
				filesystem.fault === "wrong-version" &&
				path.endsWith("playwright-core/package.json")
			)
				return JSON.stringify({ version: "1.62.0" });
			return actual.readFile(path, encoding as "utf8");
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createReadStream: (path: string) =>
			path.startsWith("/opt/agent-infra/browser/")
				? Readable.from([Buffer.from("virtual image browser")])
				: actual.createReadStream(path),
	};
});
// Filesystem/crypto are virtual image boundaries here. The Linux image probe
// independently verifies the real binary with the unmodified SHA-256 algorithm.
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		createHash: (algorithm: string) => {
			const hash = actual.createHash(algorithm);
			vi.spyOn(hash, "digest").mockImplementation(() =>
				filesystem.fault === "tampered"
					? "0".repeat(64)
					: process.arch === "x64"
						? "8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e"
						: ("839efe5fd8b6a773dd81b2e10afdc15f3c0a17316fb82b5908c0533306c4ed9e" as never),
			);
			return hash;
		},
	};
});

describe("Pinned Chromium installation", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "linux" });
		filesystem.fault = "valid";
	});
	afterEach(() => {
		if (platform) Object.defineProperty(process, "platform", platform);
		filesystem.fault = "missing";
		vi.restoreAllMocks();
	});
	it("refuses a persistent Context before executing absent Chromium supply", async () => {
		filesystem.fault = "missing";
		const launch = vi
			.spyOn(chromium, "launchPersistentContext")
			.mockResolvedValue({
				on: vi.fn(),
				close: vi.fn(),
			} as unknown as BrowserContext);
		const manager = createChromiumBrowserContextManagerV1({
			sandboxRoot: "/tmp/controlled-browser-session",
		});
		await expect(manager.acquire(binding, capability)).rejects.toThrow(
			"RUNTIME_BROWSER_PROVENANCE_MISMATCH",
		);
		expect(launch).not.toHaveBeenCalled();
	});
	it("uses the verified image path, reuses one profile and revalidates after close", async () => {
		const context = {
			on: vi.fn(),
			close: vi.fn(async () => undefined),
		} as unknown as BrowserContext;
		const launch = vi
			.spyOn(chromium, "launchPersistentContext")
			.mockResolvedValue(context);
		const input = {
			sandboxRoot: "/tmp/controlled-browser-session",
			executablePath: "/tmp/foreign-browser",
		};
		const manager = createChromiumBrowserContextManagerV1(input);
		expect(
			await Promise.all([
				manager.acquire(binding, capability),
				manager.resume(binding, capability),
			]),
		).toEqual([context, context]);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(launch).toHaveBeenCalledWith(
			"/tmp/controlled-browser-session/browser-profile",
			expect.objectContaining({
				executablePath:
					process.arch === "x64"
						? "/opt/agent-infra/browser/chrome-linux64/chrome"
						: "/opt/agent-infra/browser/chrome-linux-arm64/chrome",
			}),
		);
		await expect(
			manager.acquire({ ...binding, conversationId: "foreign" }, capability),
		).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
		await expect(
			manager.close({ ...binding, conversationId: "foreign" }),
		).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
		await manager.close(binding);
		expect(manager.snapshot().status).toBe("closed");
		filesystem.fault = "tampered";
		await expect(manager.resume(binding, capability)).rejects.toThrow(
			"RUNTIME_BROWSER_PROVENANCE_MISMATCH",
		);
		expect(launch).toHaveBeenCalledTimes(1);
		filesystem.fault = "valid";
		expect(await manager.resume(binding, capability)).toBe(context);
		expect(launch).toHaveBeenCalledTimes(2);
		await manager.close(binding);
	});
	it("revalidates the installed libraries before resuming a crashed Context", async () => {
		let crash = () => {};
		const context = {
			on: (_event: string, callback: () => void) => {
				crash = callback;
			},
			close: vi.fn(async () => undefined),
		} as unknown as BrowserContext;
		const launch = vi
			.spyOn(chromium, "launchPersistentContext")
			.mockResolvedValue(context);
		const manager = createChromiumBrowserContextManagerV1({
			sandboxRoot: "/tmp/controlled-browser-session",
		});
		await manager.acquire(binding, capability);
		crash();
		expect(manager.snapshot().status).toBe("crashed");
		filesystem.fault = "library-writable";
		await expect(manager.resume(binding, capability)).rejects.toThrow(
			"RUNTIME_BROWSER_PROVENANCE_MISMATCH",
		);
		expect(launch).toHaveBeenCalledTimes(1);
	});
	it("rejects absent or unsupported supply without a host browser fallback", async () => {
		filesystem.fault = "missing";
		await expect(verifyChromiumInstallationV1()).rejects.toThrow(
			"RUNTIME_BROWSER_PROVENANCE_MISMATCH",
		);
	});
	it("returns only the pinned version and fixed image path for valid supply", async () => {
		await expect(verifyChromiumInstallationV1()).resolves.toMatchObject({
			chromiumVersion: "153.0.8010.12",
			playwrightVersion: "1.63.0",
			platform: "linux",
		});
	});

	it.each([
		"writable",
		"root-writable",
		"symlink",
		"tampered",
		"wrong-version",
		"library-writable",
	])("rejects %s supply before browser execution", async (fault) => {
		filesystem.fault = fault;
		await expect(verifyChromiumInstallationV1()).rejects.toThrow(
			"RUNTIME_BROWSER_PROVENANCE_MISMATCH",
		);
	});
});
