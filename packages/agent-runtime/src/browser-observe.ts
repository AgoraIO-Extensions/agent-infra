import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { FileDescriptorV1 } from "@agent-infra/contracts/files";
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

export type BrowserPageRecoveryInputV1 = Readonly<{
	pageId: string;
	pageRevision: number;
	tabIndex: number;
	url: string;
	origin: string;
	capabilityVersion: number;
	sessionGeneration: number;
	resourceFence: number;
}>;

export type BrowserContextRecoveryBindingV1 = Readonly<{
	sessionGeneration: number;
	resourceFence: number;
}>;

export type BrowserElementReferenceV1 = Readonly<{
	elementId: string;
	pageId: string;
	pageRevision: number;
	role: string;
	name: string;
}>;

export type BrowserActionKindV1 =
	| "click"
	| "fill"
	| "select"
	| "check"
	| "uncheck"
	| "press"
	| "hover"
	| "scroll"
	| "wait"
	| "switch_tab"
	| "switch_frame"
	| "screenshot"
	| "download"
	| "upload";

export type BrowserActionAuthorizationV1 = Readonly<{
	subjectId: string;
	agentId: string;
	conversationId: string;
	executionId: string;
}>;

export type BrowserSideEffectConfirmationV1 = Readonly<{
	confirmationId: string;
	actionId: string;
	subjectId: string;
	agentId: string;
	conversationId: string;
	executionId: string;
	origin: string;
	pageRevision: number;
	elementId?: string;
	parameterDigest: string;
	capabilityVersion: number;
	preview: Readonly<{ kind: BrowserActionKindV1; name: string }>;
}>;

export type BrowserActionRequestV1 = Readonly<{
	actionId?: string;
	/** Allocated by the Platform operation boundary; never generated per retry. */
	operationRef?: string;
	/** Allocated for this concrete attempt by the Platform operation boundary. */
	attemptRef?: string;
	idempotencyKey?: string;
	kind: BrowserActionKindV1;
	page: BrowserPageReferenceV1;
	target?: BrowserElementReferenceV1;
	targetPage?: BrowserPageReferenceV1;
	value?: string;
	key?: string;
	durationMs?: number;
	file?: Readonly<{ descriptor: FileDescriptorV1; bytes: Uint8Array }>;
	sideEffect?: boolean;
	authorization?: BrowserActionAuthorizationV1;
	confirmation?: BrowserSideEffectConfirmationV1;
}>;

export type BrowserActionRecordV1 = Readonly<{
	actionId: string;
	operationRef?: string;
	attemptRef?: string;
	kind: BrowserActionKindV1;
	status:
		| "accepted"
		| "processing"
		| "completed"
		| "failed"
		| "rejected"
		| "unknown";
	page: BrowserPageReferenceV1;
	sideEffect: boolean;
	createdAt: string;
	completedAt?: string;
	reasonCode?: string;
	confirmation?: BrowserSideEffectConfirmationV1;
	artifact?: BrowserArtifactV1;
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

export type BrowserArtifactV1 = Readonly<{
	page: BrowserPageReferenceV1;
	descriptor: FileDescriptorV1;
	bytes: Uint8Array;
	kind: "screenshot" | "download";
}>;

export type BrowserUploadRequestV1 = Readonly<{
	page: BrowserPageReferenceV1;
	target: BrowserElementReferenceV1;
	file: Readonly<{ descriptor: FileDescriptorV1; bytes: Uint8Array }>;
	operationRef?: string;
	attemptRef?: string;
	idempotencyKey?: string;
	authorization?: BrowserActionAuthorizationV1;
	confirmation?: BrowserSideEffectConfirmationV1;
}>;

type PageState = {
	readonly pageId: string;
	readonly page: Page;
	revision: number;
	readonly elements: Map<
		string,
		{ revision: number; index: number; frame?: Frame }
	>;
	activeFrame?: Frame;
};

class BrowserActionRejectedError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalize(entry)]),
	);
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function sideEffectName(name: string): boolean {
	return /(submit|send|publish|delete|remove|buy|purchase|pay|grant|revoke|confirm|提交|发送|发布|删除|购买|支付|授权|撤销)/iu.test(
		name,
	);
}

function isPrintableKey(value: string): boolean {
	return (
		/^[\x20-\x7e]$/u.test(value) ||
		/^(Enter|Tab|Escape|Backspace|Delete|Space|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/u.test(
			value,
		)
	);
}

function assertArtifactName(name: string): void {
	if (
		name.length < 1 ||
		name.length > 255 ||
		![...name].every((character) => {
			const code = character.codePointAt(0) ?? 0;
			return (
				code >= 0x20 && code !== 0x7f && character !== "/" && character !== "\\"
			);
		})
	)
		throw new Error("BROWSER_ARTIFACT_NAME_INVALID");
}

function assertArtifactDescriptor(descriptor: FileDescriptorV1): void {
	assertArtifactName(descriptor.name);
	if (
		!Number.isSafeInteger(descriptor.sizeBytes) ||
		descriptor.sizeBytes < 0 ||
		!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(descriptor.mediaType) ||
		!/^[a-f0-9]{64}$/u.test(descriptor.sha256)
	)
		throw new Error("BROWSER_ARTIFACT_DESCRIPTOR_INVALID");
}

function descriptorForBytes(
	name: string,
	mediaType: string,
	bytes: Uint8Array,
): FileDescriptorV1 {
	assertArtifactName(name);
	if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType))
		throw new Error("BROWSER_ARTIFACT_MEDIA_TYPE_INVALID");
	return {
		name,
		mediaType,
		sizeBytes: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

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

function pageStateFor(
	page: Page,
	pages: Map<string, PageState>,
	recovery?: Pick<BrowserPageRecoveryInputV1, "pageId" | "pageRevision">,
): PageState {
	const existing = [...pages.values()].find((entry) => entry.page === page);
	if (existing) return existing;
	const state: PageState = {
		pageId: recovery?.pageId ?? `page-${randomUUID()}`,
		page,
		revision: recovery?.pageRevision ?? 1,
		elements: new Map(),
	};
	page.on("framenavigated", (frame: Frame) => {
		state.revision += 1;
		state.elements.clear();
		if (frame === page.mainFrame()) state.activeFrame = undefined;
	});
	page.on("close", () => pages.delete(state.pageId));
	pages.set(state.pageId, state);
	return state;
}

export function createBrowserObserveControllerV1(input: {
	readonly context: BrowserContext;
	readonly capability:
		| BrowserCapabilityAvailableV1
		| (() => BrowserCapabilityAvailableV1);
	readonly recoveryBinding?: BrowserContextRecoveryBindingV1;
	readonly maxTextBytes?: number;
}) {
	const readCapability = (): BrowserCapabilityAvailableV1 =>
		typeof input.capability === "function"
			? input.capability()
			: input.capability;
	const pages = new Map<string, PageState>();
	const maxTextBytes = input.maxTextBytes ?? 32_768;
	let policyInstalled = false;
	let inFlightActions = 0;
	const actions = new Map<string, BrowserActionRecordV1>();
	const actionDigests = new Map<string, string>();
	let downloadCount = 0;
	const confirmations = new Map<
		string,
		{ confirmation: BrowserSideEffectConfirmationV1; digest: string }
	>();

	function allowedOrigins(): ReadonlySet<string> {
		return new Set(readCapability().policy.allowedOrigins.map(normalizeOrigin));
	}

	async function installPolicy() {
		if (policyInstalled) return;
		await input.context.route("**/*", async (route: Route) => {
			try {
				assertAllowedUrl(route.request().url(), allowedOrigins());
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
		const capability = readCapability();
		assertAllowedUrl(url, allowedOrigins());
		if (input.context.pages().length >= capability.policy.maxPages)
			throw new Error("BROWSER_PAGE_LIMIT_EXCEEDED");
		const page = input.context.pages()[0] ?? (await input.context.newPage());
		const state = pageStateFor(page, pages);
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: capability.policy.navigationTimeoutMs,
		});
		assertAllowedUrl(page.url(), allowedOrigins());
		return { pageId: state.pageId, pageRevision: state.revision };
	}

	async function observe(
		reference: BrowserPageReferenceV1,
	): Promise<BrowserObservationV1> {
		const state = requirePage(reference);
		const root = state.activeFrame ?? state.page;
		const origin = new URL(state.page.url()).origin;
		const body = root.locator("body");
		const text = (
			await body.innerText({
				timeout: readCapability().policy.actionTimeoutMs,
			})
		).slice(0, maxTextBytes);
		const candidates = root.locator("a,button,input,textarea,select");
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
			state.elements.set(elementId, {
				revision: state.revision,
				index,
				frame: state.activeFrame,
			});
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

	function listPages(): readonly BrowserPageReferenceV1[] {
		const maxTabs = readCapability().policy.maxTabs;
		return input.context
			.pages()
			.slice(0, maxTabs)
			.map((page) => pageReference(pageStateFor(page, pages)));
	}

	async function recoverPage(
		recovery: BrowserPageRecoveryInputV1,
	): Promise<BrowserPageReferenceV1> {
		await installPolicy();
		const capability = readCapability();
		if (
			nonEmpty(recovery.pageId) === false ||
			nonEmpty(recovery.url) === false ||
			nonEmpty(recovery.origin) === false ||
			!Number.isSafeInteger(recovery.tabIndex) ||
			recovery.tabIndex < 0 ||
			recovery.tabIndex >= capability.policy.maxTabs ||
			!Number.isSafeInteger(recovery.pageRevision) ||
			recovery.pageRevision < 1 ||
			!Number.isSafeInteger(recovery.capabilityVersion) ||
			recovery.capabilityVersion < 1 ||
			!Number.isSafeInteger(recovery.sessionGeneration) ||
			recovery.sessionGeneration < 1 ||
			!Number.isSafeInteger(recovery.resourceFence) ||
			recovery.resourceFence < 1
		)
			throw new Error("BROWSER_PAGE_RECOVERY_INVALID");
		const binding = input.recoveryBinding;
		if (
			!binding ||
			binding.sessionGeneration !== recovery.sessionGeneration ||
			binding.resourceFence !== recovery.resourceFence
		)
			throw new Error("BROWSER_PAGE_RECOVERY_BINDING_MISMATCH");
		if (capability.capabilityVersion !== recovery.capabilityVersion)
			throw new Error("BROWSER_PAGE_RECOVERY_CAPABILITY_MISMATCH");
		const page = input.context.pages()[recovery.tabIndex];
		if (!page) throw new Error("BROWSER_PAGE_RECOVERY_PAGE_MISSING");
		if (page.url() !== recovery.url)
			throw new Error("BROWSER_PAGE_RECOVERY_URL_MISMATCH");
		const origin = new URL(page.url()).origin;
		if (origin !== normalizeOrigin(recovery.origin))
			throw new Error("BROWSER_PAGE_RECOVERY_ORIGIN_MISMATCH");
		assertAllowedUrl(page.url(), allowedOrigins());
		for (const state of pages.values()) state.elements.clear();
		const existingByPage = [...pages.values()].find(
			(state) => state.page === page,
		);
		if (
			existingByPage &&
			(existingByPage.pageId !== recovery.pageId ||
				existingByPage.revision !== recovery.pageRevision)
		)
			throw new Error("BROWSER_PAGE_RECOVERY_REVISION_MISMATCH");
		const existing = [...pages.values()].find(
			(state) => state.pageId === recovery.pageId,
		);
		if (existing && existing.page !== page)
			throw new Error("BROWSER_PAGE_RECOVERY_PAGE_CONFLICT");
		const state = pageStateFor(page, pages, recovery);
		state.elements.clear();
		state.activeFrame = undefined;
		return { pageId: state.pageId, pageRevision: state.revision };
	}

	function resolveElement(reference: BrowserElementReferenceV1): Locator {
		const state = pages.get(reference.pageId);
		if (!state || state.revision !== reference.pageRevision)
			throw new Error("BROWSER_ELEMENT_REFERENCE_STALE");
		const stored = state.elements.get(reference.elementId);
		if (
			!stored ||
			stored.revision !== reference.pageRevision ||
			stored.frame !== state.activeFrame
		)
			throw new Error("BROWSER_ELEMENT_REFERENCE_STALE");
		return (state.activeFrame ?? state.page)
			.locator("a,button,input,textarea,select")
			.nth(stored.index);
	}

	function pageReference(state: PageState): BrowserPageReferenceV1 {
		return { pageId: state.pageId, pageRevision: state.revision };
	}

	function actionDigest(request: BrowserActionRequestV1): string {
		return digest({
			kind: request.kind,
			page: request.page,
			target: request.target,
			targetPage: request.targetPage,
			value: request.value,
			key: request.key,
			durationMs: request.durationMs,
			file: request.file
				? {
						descriptor: request.file.descriptor,
						sha256: createHash("sha256")
							.update(request.file.bytes)
							.digest("hex"),
					}
				: undefined,
			sideEffect: request.sideEffect,
			authorization: request.authorization,
		});
	}

	function requireAuthorization(
		request: BrowserActionRequestV1,
	): BrowserActionAuthorizationV1 {
		const authorization = request.authorization;
		if (
			!authorization ||
			!nonEmpty(authorization.subjectId) ||
			!nonEmpty(authorization.agentId) ||
			!nonEmpty(authorization.conversationId) ||
			!nonEmpty(authorization.executionId)
		)
			throw new BrowserActionRejectedError(
				"BROWSER_ACTION_AUTHORIZATION_REQUIRED",
			);
		return authorization;
	}

	function actionRecord(
		request: BrowserActionRequestV1,
		status: BrowserActionRecordV1["status"],
		page: BrowserPageReferenceV1,
		createdAt: string,
		fields: Partial<BrowserActionRecordV1> = {},
	): BrowserActionRecordV1 {
		const actionId = request.actionId ?? `action-${randomUUID()}`;
		return {
			actionId,
			...(request.operationRef ? { operationRef: request.operationRef } : {}),
			...(request.attemptRef ? { attemptRef: request.attemptRef } : {}),
			kind: request.kind,
			status,
			page,
			sideEffect: request.sideEffect === true,
			createdAt,
			...fields,
		};
	}

	async function executeAction(
		request: BrowserActionRequestV1,
	): Promise<BrowserActionRecordV1> {
		const createdAt = new Date().toISOString();
		const actionId = request.actionId ?? `action-${randomUUID()}`;
		if (!request.operationRef || !request.attemptRef)
			return actionRecord(request, "rejected", request.page, createdAt, {
				actionId,
				reasonCode: "BROWSER_ACTION_OPERATION_REQUIRED",
			});
		const requestDigest = actionDigest(request);
		const previous = request.idempotencyKey
			? actions.get(request.idempotencyKey)
			: undefined;
		if (previous) {
			if (actionDigests.get(request.idempotencyKey as string) !== requestDigest)
				return actionRecord(request, "rejected", previous.page, createdAt, {
					actionId,
					reasonCode: "BROWSER_ACTION_IDEMPOTENCY_CONFLICT",
				});
			if (
				previous.status !== "rejected" ||
				previous.reasonCode !== "BROWSER_SIDE_EFFECT_CONFIRMATION_REQUIRED"
			)
				return previous;
		}

		let state: PageState;
		try {
			state = requirePage(request.page);
		} catch (error) {
			return actionRecord(request, "rejected", request.page, createdAt, {
				actionId,
				reasonCode:
					error instanceof Error
						? error.message
						: "BROWSER_PAGE_REFERENCE_STALE",
			});
		}
		const capability = readCapability();
		try {
			assertAllowedUrl(state.page.url(), allowedOrigins());
		} catch (error) {
			return actionRecord(
				request,
				"rejected",
				pageReference(state),
				createdAt,
				{
					actionId,
					reasonCode:
						error instanceof Error
							? error.message
							: "BROWSER_NAVIGATION_ORIGIN_DENIED",
				},
			);
		}
		const isArtifactAction = ["screenshot", "download", "upload"].includes(
			request.kind,
		);
		if (
			(!isArtifactAction && !capability.operations.includes("interact")) ||
			(isArtifactAction && !capability.operations.includes("files"))
		)
			return actionRecord(
				request,
				"rejected",
				pageReference(state),
				createdAt,
				{
					actionId,
					reasonCode: isArtifactAction
						? "BROWSER_CAPABILITY_FILES_UNAVAILABLE"
						: "BROWSER_CAPABILITY_INTERACT_UNAVAILABLE",
				},
			);
		if (inFlightActions >= capability.policy.maxConcurrentActions)
			return actionRecord(
				request,
				"rejected",
				pageReference(state),
				createdAt,
				{
					actionId,
					reasonCode: "BROWSER_ACTION_CONCURRENCY_LIMIT",
				},
			);

		let locator: Locator | undefined;
		if (request.target) {
			if (
				request.target.pageId !== request.page.pageId ||
				request.target.pageRevision !== request.page.pageRevision
			)
				return actionRecord(
					request,
					"rejected",
					pageReference(state),
					createdAt,
					{
						actionId,
						reasonCode: "BROWSER_ELEMENT_PAGE_MISMATCH",
					},
				);
			try {
				locator = resolveElement(request.target);
			} catch (error) {
				return actionRecord(
					request,
					"rejected",
					pageReference(state),
					createdAt,
					{
						actionId,
						reasonCode:
							error instanceof Error
								? error.message
								: "BROWSER_ELEMENT_REFERENCE_STALE",
					},
				);
			}
		}
		const inferredSideEffect =
			request.sideEffect === true ||
			request.kind === "upload" ||
			(request.kind === "click" && sideEffectName(request.target?.name ?? ""));
		let authorization: BrowserActionAuthorizationV1 | undefined;
		if (inferredSideEffect) {
			try {
				authorization = requireAuthorization(request);
			} catch (error) {
				return actionRecord(
					request,
					"rejected",
					pageReference(state),
					createdAt,
					{
						actionId,
						sideEffect: true,
						reasonCode:
							error instanceof BrowserActionRejectedError
								? error.code
								: "BROWSER_ACTION_AUTHORIZATION_REQUIRED",
					},
				);
			}
		}
		if (inferredSideEffect && !capability.operations.includes("side_effects"))
			return actionRecord(
				request,
				"rejected",
				pageReference(state),
				createdAt,
				{
					actionId,
					sideEffect: true,
					reasonCode: "BROWSER_SIDE_EFFECTS_UNAVAILABLE",
				},
			);
		if (inferredSideEffect && capability.policy.requireSideEffectConfirmation) {
			if (!authorization)
				return actionRecord(
					request,
					"rejected",
					pageReference(state),
					createdAt,
					{
						actionId,
						sideEffect: true,
						reasonCode: "BROWSER_ACTION_AUTHORIZATION_REQUIRED",
					},
				);
			const currentOrigin = new URL(state.page.url()).origin;
			const confirmation = request.confirmation;
			if (!confirmation) {
				const preview: BrowserSideEffectConfirmationV1 = Object.freeze({
					confirmationId: `confirmation-${randomUUID()}`,
					actionId,
					subjectId: authorization.subjectId,
					agentId: authorization.agentId,
					conversationId: authorization.conversationId,
					executionId: authorization.executionId,
					origin: currentOrigin,
					pageRevision: state.revision,
					...(request.target ? { elementId: request.target.elementId } : {}),
					parameterDigest: requestDigest,
					capabilityVersion: capability.capabilityVersion,
					preview: { kind: request.kind, name: request.target?.name ?? "" },
				});
				confirmations.set(preview.confirmationId, {
					confirmation: preview,
					digest: requestDigest,
				});
				const record = actionRecord(
					request,
					"rejected",
					pageReference(state),
					createdAt,
					{
						actionId,
						sideEffect: true,
						reasonCode: "BROWSER_SIDE_EFFECT_CONFIRMATION_REQUIRED",
						confirmation: preview,
					},
				);
				if (request.idempotencyKey) {
					actions.set(request.idempotencyKey, record);
					actionDigests.set(request.idempotencyKey, requestDigest);
				}
				return record;
			}
			const pending = confirmations.get(confirmation.confirmationId);
			if (
				!pending ||
				pending.digest !== requestDigest ||
				confirmation.actionId !== actionId ||
				confirmation.parameterDigest !== pending.digest ||
				confirmation.capabilityVersion !== capability.capabilityVersion ||
				confirmation.origin !== currentOrigin ||
				confirmation.pageRevision !== state.revision ||
				confirmation.subjectId !== authorization.subjectId ||
				confirmation.agentId !== authorization.agentId ||
				confirmation.conversationId !== authorization.conversationId ||
				confirmation.executionId !== authorization.executionId ||
				confirmation.elementId !== request.target?.elementId ||
				confirmation.preview.kind !== pending.confirmation.preview.kind ||
				confirmation.preview.name !== pending.confirmation.preview.name
			)
				return actionRecord(
					request,
					"rejected",
					pageReference(state),
					createdAt,
					{
						actionId,
						sideEffect: true,
						reasonCode: "BROWSER_SIDE_EFFECT_CONFIRMATION_INVALID",
					},
				);
			confirmations.delete(confirmation.confirmationId);
		}

		const targetPageState = request.targetPage
			? pages.get(request.targetPage.pageId)
			: undefined;
		if (request.kind === "switch_tab") {
			if (
				!targetPageState ||
				targetPageState.revision !== request.targetPage?.pageRevision
			)
				return actionRecord(
					request,
					"rejected",
					pageReference(state),
					createdAt,
					{
						actionId,
						reasonCode: "BROWSER_TAB_REFERENCE_STALE",
					},
				);
		}
		if (
			[
				"click",
				"fill",
				"select",
				"check",
				"uncheck",
				"press",
				"hover",
				"scroll",
				"switch_frame",
				"download",
				"upload",
			].includes(request.kind) &&
			!locator
		)
			return actionRecord(
				request,
				"rejected",
				pageReference(state),
				createdAt,
				{
					actionId,
					reasonCode: "BROWSER_ACTION_TARGET_REQUIRED",
				},
			);

		inFlightActions += 1;
		let artifact: BrowserArtifactV1 | undefined;
		try {
			await installPolicy();
			const timeout = capability.policy.actionTimeoutMs;
			switch (request.kind) {
				case "click":
					await locator?.click({ timeout });
					break;
				case "fill": {
					const type = await locator?.getAttribute("type");
					const name = await locator?.getAttribute("name");
					if (
						type === "hidden" ||
						type === "password" ||
						/(password|token|secret|key)/iu.test(name ?? "")
					)
						throw new BrowserActionRejectedError(
							"BROWSER_SENSITIVE_FIELD_DENIED",
						);
					if (typeof request.value !== "string" || request.value.length > 4096)
						throw new BrowserActionRejectedError(
							"BROWSER_ACTION_VALUE_INVALID",
						);
					await locator?.fill(request.value, { timeout });
					break;
				}
				case "select":
					if (typeof request.value !== "string" || request.value.length > 256)
						throw new BrowserActionRejectedError(
							"BROWSER_ACTION_VALUE_INVALID",
						);
					await locator?.selectOption(request.value, { timeout });
					break;
				case "check":
					await locator?.check({ timeout });
					break;
				case "uncheck":
					await locator?.uncheck({ timeout });
					break;
				case "press":
					if (typeof request.key !== "string" || !isPrintableKey(request.key))
						throw new BrowserActionRejectedError("BROWSER_ACTION_KEY_INVALID");
					await locator?.press(request.key, { timeout });
					break;
				case "hover":
					await locator?.hover({ timeout });
					break;
				case "scroll":
					await locator?.scrollIntoViewIfNeeded({ timeout });
					break;
				case "wait": {
					const durationMs = request.durationMs ?? 0;
					if (
						!Number.isSafeInteger(durationMs) ||
						durationMs < 0 ||
						durationMs > timeout
					)
						throw new BrowserActionRejectedError("BROWSER_ACTION_WAIT_INVALID");
					await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
					break;
				}
				case "switch_tab":
					break;
				case "switch_frame": {
					const handle = await locator?.elementHandle({ timeout });
					const frame = await handle?.contentFrame();
					if (!frame)
						throw new BrowserActionRejectedError("BROWSER_FRAME_UNAVAILABLE");
					state.activeFrame = frame;
					state.elements.clear();
					break;
				}
				case "screenshot":
					artifact = await screenshotForState(state, capability);
					break;
				case "download":
					artifact = await downloadForState(state, locator, capability);
					break;
				case "upload":
					await uploadForState(state, locator, request.file, capability);
					break;
			}
			const resultPage = targetPageState
				? pageReference(targetPageState)
				: pageReference(state);
			const record = actionRecord(request, "completed", resultPage, createdAt, {
				actionId,
				sideEffect: inferredSideEffect,
				completedAt: new Date().toISOString(),
				artifact,
			});
			if (request.idempotencyKey) {
				actions.set(request.idempotencyKey, record);
				actionDigests.set(request.idempotencyKey, requestDigest);
			}
			return record;
		} catch (error) {
			const rejected = error instanceof BrowserActionRejectedError;
			const record = actionRecord(
				request,
				rejected ? "rejected" : inferredSideEffect ? "unknown" : "failed",
				pageReference(state),
				createdAt,
				{
					actionId,
					sideEffect: inferredSideEffect,
					reasonCode: rejected
						? error.code
						: inferredSideEffect
							? "BROWSER_ACTION_RESULT_UNCONFIRMED"
							: "BROWSER_ACTION_FAILED",
					completedAt: new Date().toISOString(),
				},
			);
			if (request.idempotencyKey) {
				actions.set(request.idempotencyKey, record);
				actionDigests.set(request.idempotencyKey, requestDigest);
			}
			return record;
		} finally {
			inFlightActions -= 1;
		}
	}

	async function screenshotForState(
		state: PageState,
		capability: BrowserCapabilityAvailableV1,
	): Promise<BrowserArtifactV1> {
		const bytes = await state.page.screenshot({
			type: "png",
			timeout: capability.policy.actionTimeoutMs,
		});
		if (bytes.byteLength > capability.policy.maxScreenshotBytes)
			throw new Error("BROWSER_SCREENSHOT_LIMIT_EXCEEDED");
		const descriptor = descriptorForBytes(
			`screenshot-${state.revision}.png`,
			"image/png",
			bytes,
		);
		return {
			page: pageReference(state),
			descriptor,
			bytes,
			kind: "screenshot",
		};
	}

	async function downloadForState(
		state: PageState,
		locator: Locator | undefined,
		capability: BrowserCapabilityAvailableV1,
	): Promise<BrowserArtifactV1> {
		if (downloadCount >= capability.policy.maxDownloads)
			throw new Error("BROWSER_DOWNLOAD_LIMIT_EXCEEDED");
		if (!locator) throw new Error("BROWSER_ACTION_TARGET_REQUIRED");
		downloadCount += 1;
		const [download] = await Promise.all([
			state.page.waitForEvent("download", {
				timeout: capability.policy.actionTimeoutMs,
			}),
			locator.click({ timeout: capability.policy.actionTimeoutMs }),
		]);
		const stream = await download.createReadStream();
		if (!stream) {
			await download.delete().catch(() => undefined);
			throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
		}
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of stream) {
			const value = Buffer.from(chunk as Uint8Array);
			size += value.byteLength;
			if (size > capability.policy.maxDownloadBytes) {
				await download.cancel().catch(() => undefined);
				stream.destroy();
				await download.delete().catch(() => undefined);
				throw new Error("BROWSER_DOWNLOAD_LIMIT_EXCEEDED");
			}
			chunks.push(value);
		}
		if (await download.failure()) {
			await download.delete().catch(() => undefined);
			throw new Error("BROWSER_DOWNLOAD_FAILED");
		}
		const bytes = Buffer.concat(chunks);
		const descriptor = descriptorForBytes(
			download.suggestedFilename(),
			"application/octet-stream",
			bytes,
		);
		return { page: pageReference(state), descriptor, bytes, kind: "download" };
	}

	async function uploadForState(
		_state: PageState,
		locator: Locator | undefined,
		file: BrowserUploadRequestV1["file"] | undefined,
		capability: BrowserCapabilityAvailableV1,
	): Promise<void> {
		if (!locator) throw new Error("BROWSER_ACTION_TARGET_REQUIRED");
		if (!file) throw new Error("BROWSER_UPLOAD_FILE_REQUIRED");
		const { descriptor, bytes } = file;
		assertArtifactDescriptor(descriptor);
		if (
			descriptor.sizeBytes > capability.policy.maxUploadBytes ||
			descriptor.sizeBytes !== bytes.byteLength
		)
			throw new Error("BROWSER_UPLOAD_LIMIT_EXCEEDED");
		if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256)
			throw new Error("BROWSER_UPLOAD_DIGEST_MISMATCH");
		await locator.setInputFiles(
			{
				name: descriptor.name,
				mimeType: descriptor.mediaType,
				buffer: Buffer.from(bytes),
			},
			{ timeout: capability.policy.actionTimeoutMs },
		);
	}

	function artifactResult(record: BrowserActionRecordV1): BrowserArtifactV1 {
		if (record.status !== "completed" || !record.artifact)
			throw new Error(record.reasonCode ?? "BROWSER_ARTIFACT_UNAVAILABLE");
		return record.artifact;
	}

	async function screenshot(
		reference: BrowserPageReferenceV1,
		idempotencyKey = `screenshot:${reference.pageId}:${reference.pageRevision}`,
		operationRef?: string,
		attemptRef?: string,
	): Promise<BrowserArtifactV1> {
		return artifactResult(
			await executeAction({
				kind: "screenshot",
				page: reference,
				idempotencyKey,
				operationRef,
				attemptRef,
			}),
		);
	}

	async function download(
		reference: BrowserPageReferenceV1,
		target: BrowserElementReferenceV1,
		idempotencyKey = `download:${target.elementId}`,
		operationRef?: string,
		attemptRef?: string,
	): Promise<BrowserArtifactV1> {
		return artifactResult(
			await executeAction({
				kind: "download",
				page: reference,
				target,
				idempotencyKey,
				operationRef,
				attemptRef,
			}),
		);
	}

	async function upload(input_: BrowserUploadRequestV1): Promise<void> {
		const result = await executeAction({
			kind: "upload",
			page: input_.page,
			target: input_.target,
			file: input_.file,
			operationRef: input_.operationRef,
			attemptRef: input_.attemptRef,
			idempotencyKey:
				input_.idempotencyKey ?? `upload:${input_.target.elementId}`,
			authorization: input_.authorization,
			confirmation: input_.confirmation,
		});
		if (result.status !== "completed")
			throw new Error(result.reasonCode ?? "BROWSER_UPLOAD_UNAVAILABLE");
	}

	return {
		navigate,
		observe,
		resolveElement,
		listPages,
		recoverPage,
		act: executeAction,
		executeAction,
		screenshot,
		download,
		upload,
	};
}
