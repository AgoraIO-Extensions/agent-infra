import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import type {
	BrowserContext,
	Frame,
	Locator,
	Page,
	Route,
} from "playwright-core";

export type BrowserPageReferenceV1 = Readonly<{
	pageId: string;
	pageRevision: number;
}>;

export type BrowserElementReferenceV1 = Readonly<{
	elementId: string;
	pageId: string;
	pageRevision: number;
	role: string;
	name: string;
}>;

export type BrowserObservationV1 = Readonly<{
	page: BrowserPageReferenceV1;
	origin: string;
	title: string;
	text: string;
	tabCount: number;
	frameCount: number;
	elements: readonly BrowserElementReferenceV1[];
}>;

type PageState = {
	readonly pageId: string;
	readonly page: Page;
	revision: number;
	readonly elements: Map<string, { revision: number; index: number }>;
};

function normalizeOrigin(value: string): string {
	const url = new URL(value);
	if (
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("BROWSER_POLICY_ORIGIN_INVALID");
	return url.origin;
}

function isPrivateHostname(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "");
	if (
		host === "localhost" ||
		host === "metadata.google.internal" ||
		host === "metadata.google" ||
		host === "instance-data.ec2.internal"
	)
		return true;
	const kind = isIP(host);
	if (kind === 4) {
		const [a, b] = host.split(".").map(Number);
		return (
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b !== undefined && b >= 16 && b <= 31) ||
			(a === 192 && b === 168)
		);
	}
	if (kind === 6) {
		return (
			host === "::1" ||
			host.startsWith("fc") ||
			host.startsWith("fd") ||
			host.startsWith("fe8")
		);
	}
	return false;
}

function assertAllowedUrl(
	value: string,
	allowedOrigins: ReadonlySet<string>,
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("BROWSER_NAVIGATION_URL_INVALID");
	}
	if (!new Set(["http:", "https:"]).has(url.protocol))
		throw new Error("BROWSER_NAVIGATION_SCHEME_DENIED");
	if (url.username || url.password || isPrivateHostname(url.hostname))
		throw new Error("BROWSER_NAVIGATION_PRIVATE_TARGET_DENIED");
	if (!allowedOrigins.has(url.origin))
		throw new Error("BROWSER_NAVIGATION_ORIGIN_DENIED");
	return url;
}

function pageStateFor(page: Page, pages: Map<string, PageState>): PageState {
	const existing = [...pages.values()].find((entry) => entry.page === page);
	if (existing) return existing;
	const state: PageState = {
		pageId: `page-${randomUUID()}`,
		page,
		revision: 1,
		elements: new Map(),
	};
	page.on("framenavigated", (frame: Frame) => {
		if (frame === page.mainFrame()) {
			state.revision += 1;
			state.elements.clear();
		}
	});
	page.on("close", () => pages.delete(state.pageId));
	pages.set(state.pageId, state);
	return state;
}

export function createBrowserObserveControllerV1(input: {
	readonly context: BrowserContext;
	readonly capability: BrowserCapabilityAvailableV1;
	readonly maxTextBytes?: number;
}) {
	const allowedOrigins: ReadonlySet<string> = new Set<string>(
		input.capability.policy.allowedOrigins.map(normalizeOrigin),
	);
	const pages = new Map<string, PageState>();
	const maxTextBytes = input.maxTextBytes ?? 32_768;
	let policyInstalled = false;

	async function installPolicy() {
		if (policyInstalled) return;
		await input.context.route("**/*", async (route: Route) => {
			try {
				assertAllowedUrl(route.request().url(), allowedOrigins);
				await route.continue();
			} catch {
				await route.abort("blockedbyclient");
			}
		});
		policyInstalled = true;
	}

	function requirePage(reference: BrowserPageReferenceV1): PageState {
		const state = pages.get(reference.pageId);
		if (!state || state.revision !== reference.pageRevision)
			throw new Error("BROWSER_PAGE_REFERENCE_STALE");
		return state;
	}

	async function navigate(url: string): Promise<BrowserPageReferenceV1> {
		await installPolicy();
		assertAllowedUrl(url, allowedOrigins);
		if (input.context.pages().length >= input.capability.policy.maxPages)
			throw new Error("BROWSER_PAGE_LIMIT_EXCEEDED");
		const page = input.context.pages()[0] ?? (await input.context.newPage());
		const state = pageStateFor(page, pages);
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: input.capability.policy.navigationTimeoutMs,
		});
		assertAllowedUrl(page.url(), allowedOrigins);
		return { pageId: state.pageId, pageRevision: state.revision };
	}

	async function observe(
		reference: BrowserPageReferenceV1,
	): Promise<BrowserObservationV1> {
		const state = requirePage(reference);
		const origin = new URL(state.page.url()).origin;
		const body = state.page.locator("body");
		const text = (
			await body.innerText({
				timeout: input.capability.policy.actionTimeoutMs,
			})
		).slice(0, maxTextBytes);
		const candidates = state.page.locator("a,button,input,textarea,select");
		const elements: BrowserElementReferenceV1[] = [];
		for (
			let index = 0;
			index < Math.min(await candidates.count(), 100);
			index += 1
		) {
			const candidate = candidates.nth(index);
			if (!(await candidate.isVisible())) continue;
			const role =
				(await candidate.getAttribute("role")) ??
				(await candidate.evaluate((node) => node.tagName.toLowerCase()));
			const name = (
				(await candidate.getAttribute("aria-label")) ??
				(await candidate.innerText().catch(() => ""))
			)
				.trim()
				.slice(0, 256);
			const elementId = `element-${randomUUID()}`;
			state.elements.set(elementId, { revision: state.revision, index });
			elements.push({
				elementId,
				pageId: state.pageId,
				pageRevision: state.revision,
				role,
				name,
			});
		}
		return {
			page: { pageId: state.pageId, pageRevision: state.revision },
			origin,
			title: await state.page.title(),
			text,
			tabCount: input.context.pages().length,
			frameCount: (await state.page.locator("iframe").count()) + 1,
			elements,
		};
	}

	function resolveElement(reference: BrowserElementReferenceV1): Locator {
		const state = pages.get(reference.pageId);
		if (!state || state.revision !== reference.pageRevision)
			throw new Error("BROWSER_ELEMENT_REFERENCE_STALE");
		const stored = state.elements.get(reference.elementId);
		if (!stored || stored.revision !== reference.pageRevision)
			throw new Error("BROWSER_ELEMENT_REFERENCE_STALE");
		return state.page
			.locator("a,button,input,textarea,select")
			.nth(stored.index);
	}

	return { navigate, observe, resolveElement };
}
