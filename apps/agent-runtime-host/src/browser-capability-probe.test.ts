import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCapabilityDeclarationV1 } from "@agent-infra/contracts/runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { probeRuntimeBrowserCapabilityV1 } from "./browser-capability-probe.js";

const f = vi.hoisted(() => ({
	acquire: vi.fn(),
	close: vi.fn(),
	route: vi.fn(),
	navigate: vi.fn(),
	observe: vi.fn(),
	act: vi.fn(),
	start: vi.fn(),
}));
vi.mock("@agent-infra/agent-runtime", () => ({
	verifyChromiumInstallationV1: async () => ({
		chromiumVersion: "153.0.8010.12",
		playwrightVersion: "1.63.0",
	}),
	createChromiumBrowserContextManagerV1: () => ({
		acquire: f.acquire,
		close: f.close,
	}),
	createBrowserSessionControllerV1: () => ({
		start: f.start,
		navigate: f.navigate,
		observe: f.observe,
		act: f.act,
	}),
}));

const declaration: BrowserCapabilityDeclarationV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	operations: ["navigate", "observe", "interact"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 1,
		maxPages: 1,
		maxViewportWidth: 1280,
		maxViewportHeight: 720,
		maxConcurrentActions: 1,
		maxDownloads: 0,
		maxDownloadBytes: 0,
		maxUploadBytes: 0,
		maxScreenshotBytes: 1024,
		maxBrowserDurationMs: 60000,
		maxRetainedProfileBytes: 100000,
		navigationTimeoutMs: 15000,
		actionTimeoutMs: 5000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: false,
	},
};
const binding = {
	agentId: "agent-a",
	sessionId: "session-a",
	sessionGeneration: 1,
	resourceFence: 2,
	workloadRevision: 3,
	imageDigest: `sha256:${"a".repeat(64)}`,
};
const initialPage = { pageId: "page-a", pageRevision: 1 };
const clickedPage = { pageId: "page-a", pageRevision: 2 };
let root: string;
beforeEach(async () => {
	vi.resetAllMocks();
	root = await mkdtemp(join(tmpdir(), "readiness-probe-test-"));
	f.acquire.mockResolvedValue({ pages: () => [{ route: f.route }] });
	f.close.mockResolvedValue(undefined);
	f.start.mockResolvedValue({ status: "ready" });
	f.navigate.mockResolvedValue(initialPage);
	f.observe
		.mockResolvedValueOnce({
			text: "agent-infra-browser-readiness",
			elements: [{ name: "Continue" }],
		})
		.mockImplementation(async (page) => {
			if (page !== clickedPage) throw new Error("BROWSER_PAGE_REFERENCE_STALE");
			return { text: "Clicked", elements: [] };
		});
	f.act.mockResolvedValue({ status: "completed", page: clickedPage });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
const run = (signal = new AbortController().signal) =>
	probeRuntimeBrowserCapabilityV1({
		dataDirectory: root,
		declaration,
		binding,
		signal,
	});

it("returns bound evidence only after navigation, observation and the verified click", async () => {
	const evidence = await run();
	expect(evidence).toMatchObject({
		operations: declaration.operations,
		binding,
	});
	expect(f.navigate).toHaveBeenCalledOnce();
	expect(f.act).toHaveBeenCalledOnce();
	expect(f.observe).toHaveBeenLastCalledWith(clickedPage);
	expect(f.close).toHaveBeenCalled();
	expect(await readdir(root)).toEqual([]);
});

it("serves only the fixed probe GET in memory and aborts every other request", async () => {
	await run();
	const handler = f.route.mock.calls[0]?.[1];
	expect(handler).toBeTypeOf("function");
	const url = f.navigate.mock.calls[0]?.[0];
	expect(new URL(url).protocol).toBe("https:");
	for (const [target, method, admitted] of [
		[url, "GET", true],
		[url, "POST", false],
		["http://127.0.0.1/", "GET", false],
		["https://example.test/", "GET", false],
	] as const) {
		const fulfill = vi.fn();
		const abort = vi.fn();
		await handler({
			request: () => ({ url: () => target, method: () => method }),
			fulfill,
			abort,
		});
		expect(fulfill).toHaveBeenCalledTimes(admitted ? 1 : 0);
		expect(abort).toHaveBeenCalledTimes(admitted ? 0 : 1);
	}
});

it.each(["missing-button", "rejected-click", "unchanged-page"])(
	"withholds evidence on %s",
	async (failure) => {
		if (failure === "missing-button")
			f.observe.mockReset().mockResolvedValue({
				text: "agent-infra-browser-readiness",
				elements: [],
			});
		if (failure === "rejected-click")
			f.act.mockResolvedValue({ status: "rejected" });
		if (failure === "unchanged-page")
			f.observe.mockReset().mockResolvedValue({
				text: "agent-infra-browser-readiness",
				elements: [{ name: "Continue" }],
			});
		expect(await run()).toBeUndefined();
		expect(f.close).toHaveBeenCalled();
		expect(await readdir(root)).toEqual([]);
	},
);

it("cleans its profile when browser acquisition fails", async () => {
	f.acquire.mockRejectedValue(new Error("BROWSER_UNAVAILABLE"));
	await expect(run()).rejects.toThrow("BROWSER_UNAVAILABLE");
	expect(f.navigate).not.toHaveBeenCalled();
	expect(await readdir(root)).toEqual([]);
});

it("cancels during navigation without reporting evidence or clicking", async () => {
	const controller = new AbortController();
	f.navigate.mockImplementation(async () => {
		controller.abort();
		return initialPage;
	});
	await expect(run(controller.signal)).rejects.toThrow();
	expect(f.act).not.toHaveBeenCalled();
	expect(f.close).toHaveBeenCalled();
	expect(await readdir(root)).toEqual([]);
});

it("does not advertise undeclared or unverified operations", async () => {
	const evidence = await probeRuntimeBrowserCapabilityV1({
		dataDirectory: root,
		declaration: {
			...declaration,
			operations: ["observe", "files", "handoff"],
		},
		binding,
		signal: new AbortController().signal,
	});
	expect(evidence?.operations).toEqual(["observe"]);
	expect(evidence?.conformance.operations).toEqual(["observe"]);
	expect(f.act).not.toHaveBeenCalled();
});

it("withholds evidence without observation support", async () => {
	expect(
		await probeRuntimeBrowserCapabilityV1({
			dataDirectory: root,
			declaration: { ...declaration, operations: ["navigate"] },
			binding,
			signal: new AbortController().signal,
		}),
	).toBeUndefined();
	expect(f.acquire).not.toHaveBeenCalled();
});

it("closes the context when cancellation arrives during acquisition", async () => {
	const controller = new AbortController();
	f.acquire.mockImplementation(async () => {
		controller.abort();
		return { pages: () => [{ route: f.route }] };
	});
	await expect(run(controller.signal)).rejects.toThrow();
	expect(f.close).toHaveBeenCalled();
	expect(f.navigate).not.toHaveBeenCalled();
	expect(await readdir(root)).toEqual([]);
});

it("withholds evidence when cancelled during a click", async () => {
	const controller = new AbortController();
	f.act.mockImplementation(async () => {
		controller.abort();
		return { status: "completed", page: clickedPage };
	});
	await expect(run(controller.signal)).rejects.toThrow();
	expect(f.observe).toHaveBeenCalledOnce();
	expect(f.close).toHaveBeenCalled();
	expect(await readdir(root)).toEqual([]);
});

it("cleans the profile but refuses evidence if context cleanup fails", async () => {
	f.close.mockRejectedValue(new Error("CLOSE_FAILED"));
	await expect(run()).rejects.toThrow("CLOSE_FAILED");
	expect(await readdir(root)).toEqual([]);
});

it("waits for abort-triggered cleanup before removing the profile", async () => {
	const controller = new AbortController();
	let finishClose = () => {};
	f.close.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finishClose = resolve;
			}),
	);
	f.navigate.mockImplementation(async () => {
		controller.abort();
		return initialPage;
	});
	const result = expect(run(controller.signal)).rejects.toThrow();
	await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
	expect(await readdir(root)).toHaveLength(1);
	finishClose();
	await result;
	expect(f.close).toHaveBeenCalledOnce();
	expect(await readdir(root)).toEqual([]);
});
