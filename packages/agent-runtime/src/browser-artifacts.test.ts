import { Readable } from "node:stream";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createBrowserObserveControllerV1 } from "./browser-observe.ts";

const capability: BrowserCapabilityAvailableV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe", "interact", "files", "side_effects"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 2,
		maxPages: 2,
		maxViewportWidth: 1920,
		maxViewportHeight: 1080,
		maxConcurrentActions: 1,
		maxDownloads: 1,
		maxDownloadBytes: 1024,
		maxUploadBytes: 1024,
		maxScreenshotBytes: 1024,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 10_000_000,
		navigationTimeoutMs: 5_000,
		actionTimeoutMs: 5_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: true,
	},
	provenance: {
		browser: "chromium",
		chromiumVersion: "128",
		playwrightVersion: "1.63.0",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "receipt",
		probeVersion: "probe",
		verifiedAt: "2026-10-06T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe", "interact", "files"],
	},
};

class FakeLocator {
	constructor(
		private readonly name: string,
		private readonly calls: Record<string, unknown[]>,
	) {}

	async innerText() {
		return this.name;
	}

	async isVisible() {
		return true;
	}

	async getAttribute(name: string) {
		if (name === "role") return this.name === "Download" ? "button" : null;
		if (name === "type") return this.name === "Upload" ? "file" : null;
		return null;
	}

	async evaluate() {
		return "button";
	}

	async click() {
		const calls = this.calls.click ?? [];
		calls.push(this.name);
		this.calls.click = calls;
	}

	async setInputFiles(value: unknown) {
		const calls = this.calls.upload ?? [];
		calls.push(value);
		this.calls.upload = calls;
	}
}

class FakePage {
	urlValue = "about:blank";
	handlers = new Map<string, (value: unknown) => void>();
	calls: Record<string, unknown[]> = {};
	download = {
		suggestedFilename: () => "invoice.pdf",
		createReadStream: async () => Readable.from(Buffer.from("pdf")),
		failure: async () => null,
	};

	on(event: string, handler: (value: unknown) => void) {
		this.handlers.set(event, handler);
		return this;
	}

	mainFrame() {
		return this;
	}

	async goto(url: string) {
		this.urlValue = url;
		this.handlers.get("framenavigated")?.(this);
	}

	url() {
		return this.urlValue;
	}

	async title() {
		return "Example";
	}

	async screenshot() {
		return Buffer.from("png");
	}

	async waitForEvent() {
		return this.download;
	}

	locator(selector: string) {
		if (selector === "iframe") return { count: async () => 0 };
		if (selector === "body") return { innerText: async () => "page" };
		const locators = [
			new FakeLocator("Upload", this.calls),
			new FakeLocator("Download", this.calls),
		];
		return {
			count: async () => locators.length,
			nth: (index: number) => locators[index],
		};
	}
}

function fakeContext(page: FakePage) {
	return {
		route: vi.fn(async () => undefined),
		pages: vi.fn(() => [page]),
		newPage: vi.fn(async () => page),
	};
}

describe("Browser artifact producer", () => {
	it("bounds screenshots, downloads and uploads through page references", async () => {
		const page = new FakePage();
		const controller = createBrowserObserveControllerV1({
			context: fakeContext(page) as never,
			capability,
		});
		const reference = await controller.navigate("https://example.test/");
		const observation = await controller.observe(reference);
		const uploadTarget = observation.elements[0];
		const downloadTarget = observation.elements[1];
		if (!uploadTarget || !downloadTarget) throw new Error("missing controls");

		const screenshot = await controller.screenshot(reference);
		expect(screenshot.kind).toBe("screenshot");
		expect(screenshot.descriptor.mediaType).toBe("image/png");
		expect(screenshot.descriptor.sizeBytes).toBe(3);

		const download = await controller.download(reference, downloadTarget);
		expect(download.kind).toBe("download");
		expect(download.descriptor.name).toBe("invoice.pdf");
		expect(download.bytes).toEqual(Buffer.from("pdf"));

		const uploadBytes = new TextEncoder().encode("input");
		const uploadRequest = {
			kind: "upload" as const,
			page: reference,
			target: uploadTarget,
			file: {
				descriptor: {
					name: "input.txt",
					mediaType: "text/plain",
					sizeBytes: uploadBytes.byteLength,
					sha256:
						"c96c6d5be8d08a12e7b5cdc1b207fa6b2430974c86803d8891675e76fd992c20",
				},
				bytes: uploadBytes,
			},
			idempotencyKey: "upload-1",
			authorization: {
				subjectId: "subject-1",
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "execution-1",
			},
		};
		const preview = await controller.executeAction(uploadRequest);
		expect(preview.reasonCode).toBe(
			"BROWSER_SIDE_EFFECT_CONFIRMATION_REQUIRED",
		);
		if (!preview.confirmation) throw new Error("missing upload confirmation");
		await expect(
			controller.executeAction({
				...uploadRequest,
				actionId: preview.actionId,
				confirmation: preview.confirmation,
			}),
		).resolves.toMatchObject({ status: "completed" });
		expect(page.calls.upload).toHaveLength(1);
	});
});
