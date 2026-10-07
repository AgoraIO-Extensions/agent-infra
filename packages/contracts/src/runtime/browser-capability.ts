import { z } from "zod";

import {
	OpaqueIdV1Schema,
	ProtocolErrorV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";

const nonEmptyString = () => z.string().min(1).max(256);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const hexSha256 = z.string().regex(/^[0-9a-f]{64}$/u);

const browserOrigin = z
	.string()
	.regex(
		/^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?\/$/u,
	)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				(url.protocol === "http:" || url.protocol === "https:") &&
				url.username === "" &&
				url.password === "" &&
				url.pathname === "/" &&
				url.search === "" &&
				url.hash === ""
			);
		} catch {
			return false;
		}
	}, "Browser policy entries must be origins without credentials or paths");

export const BrowserCapabilityOperationV1Schema = z.enum([
	"navigate",
	"observe",
	"interact",
	"files",
	"handoff",
	"side_effects",
]);

export const BrowserCapabilityStatusV1Schema = z.enum([
	"available",
	"not_configured",
	"probe_failed",
	"unavailable",
	"stale",
]);

export const BrowserCapabilityErrorCodeV1Schema = z.enum([
	"BROWSER_CAPABILITY_NOT_CONFIGURED",
	"BROWSER_CAPABILITY_PROBE_FAILED",
	"BROWSER_CAPABILITY_UNAVAILABLE",
	"BROWSER_CAPABILITY_STALE",
	"BROWSER_CAPABILITY_VERSION_UNSUPPORTED",
	"BROWSER_CAPABILITY_POLICY_DENIED",
]);

/** The declaration embedded in an admitted Runtime Manifest. */
export const BrowserCapabilityDeclarationV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	capabilityVersion: z.number().int().positive().max(100),
	operations: z.array(BrowserCapabilityOperationV1Schema).min(1).max(16),
	policy: z.strictObject({
		allowedOrigins: z.array(browserOrigin).max(128),
		maxContexts: z.number().int().min(1).max(4),
		maxTabs: z.number().int().min(1).max(32),
		maxPages: z.number().int().min(1).max(64),
		maxViewportWidth: z.number().int().min(320).max(7680),
		maxViewportHeight: z.number().int().min(240).max(4320),
		maxConcurrentActions: z.number().int().min(1).max(16),
		maxDownloads: z.number().int().min(0).max(256),
		maxDownloadBytes: z.number().int().nonnegative().max(10_000_000_000),
		maxUploadBytes: z.number().int().nonnegative().max(10_000_000_000),
		maxScreenshotBytes: z.number().int().nonnegative().max(100_000_000),
		maxBrowserDurationMs: z.number().int().min(1_000).max(86_400_000),
		maxRetainedProfileBytes: z.number().int().nonnegative().max(10_000_000_000),
		navigationTimeoutMs: z.number().int().min(100).max(300_000),
		actionTimeoutMs: z.number().int().min(100).max(120_000),
		requireSideEffectConfirmation: z.boolean(),
		allowUserHandoff: z.boolean(),
	}),
});

/** Fixed browser build facts returned only after a Runtime probe. */
export const BrowserCapabilityProvenanceV1Schema = z.strictObject({
	browser: z.literal("chromium"),
	chromiumVersion: nonEmptyString(),
	playwrightVersion: nonEmptyString(),
	imageDigest: sha256Digest,
});

export const BrowserCapabilityConformanceReceiptV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	receiptId: OpaqueIdV1Schema,
	probeVersion: nonEmptyString(),
	verifiedAt: Rfc3339TimestampV1Schema,
	manifestDigest: sha256Digest,
	evidenceHash: hexSha256,
	operations: z.array(BrowserCapabilityOperationV1Schema).min(1).max(16),
});

const browserCapabilityBase = {
	schemaVersion: SchemaVersionV1Schema,
	capabilityVersion: z.number().int().positive().max(100),
};

export const BrowserCapabilityAvailableV1Schema = z.strictObject({
	...browserCapabilityBase,
	status: z.literal("available"),
	operations: z.array(BrowserCapabilityOperationV1Schema).min(1).max(16),
	policy: BrowserCapabilityDeclarationV1Schema.shape.policy,
	provenance: BrowserCapabilityProvenanceV1Schema,
	conformance: BrowserCapabilityConformanceReceiptV1Schema,
});

export const BrowserCapabilityUnavailableV1Schema = z.strictObject({
	...browserCapabilityBase,
	status: z.enum(["not_configured", "probe_failed", "unavailable", "stale"]),
	errorCode: BrowserCapabilityErrorCodeV1Schema,
	reason: nonEmptyString(),
	retryable: z.boolean(),
});

/** The only capability projection that may cross the Runtime/API boundary. */
export const BrowserCapabilityProjectionV1Schema = z.discriminatedUnion(
	"status",
	[BrowserCapabilityAvailableV1Schema, BrowserCapabilityUnavailableV1Schema],
);

export const BrowserCapabilityDiscoveryRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	minimumCapabilityVersion: z.number().int().positive().max(100).optional(),
});

export const BrowserCapabilityErrorV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	code: BrowserCapabilityErrorCodeV1Schema,
	reason: nonEmptyString(),
	retryable: z.boolean(),
});

const browserCapabilityJson = (schema: z.ZodType) => ({
	content: { "application/json": { schema } },
});

export const browserCapabilityOpenApiPathsV1 = {
	"/internal/runtime/v1/browser-capability": {
		get: {
			operationId: "discoverBrowserCapabilityV1",
			requestParams: { query: BrowserCapabilityDiscoveryRequestV1Schema },
			responses: {
				"200": {
					description: "Browser Capability projection",
					...browserCapabilityJson(BrowserCapabilityProjectionV1Schema),
				},
				"400": {
					description: "Invalid Browser Capability request",
					...browserCapabilityJson(BrowserCapabilityErrorV1Schema),
				},
				"409": {
					description: "Browser Capability version conflict",
					...browserCapabilityJson(BrowserCapabilityErrorV1Schema),
				},
				"503": {
					description: "Browser Runtime is unavailable",
					...browserCapabilityJson(ProtocolErrorV1Schema),
				},
			},
		},
	},
} as const;

export type BrowserCapabilityOperationV1 = z.infer<
	typeof BrowserCapabilityOperationV1Schema
>;
export type BrowserCapabilityAvailableV1 = z.infer<
	typeof BrowserCapabilityAvailableV1Schema
>;
export type BrowserCapabilityDeclarationV1 = z.infer<
	typeof BrowserCapabilityDeclarationV1Schema
>;
export type BrowserCapabilityProjectionV1 = z.infer<
	typeof BrowserCapabilityProjectionV1Schema
>;
