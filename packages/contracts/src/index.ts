import { z } from "zod";

const boundedToken = () =>
	z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9._~-]+$/);
const boundedVisibleText = () =>
	z
		.string()
		.min(1)
		.max(512)
		.regex(/^[\u0020-\u007e]+$/);

export const SchemaVersionV1Schema = z.literal(1);
export const OpaqueIdV1Schema = boundedToken();
export const Rfc3339TimestampV1Schema = z.iso.datetime({ offset: true });
export const TraceIdV1Schema = boundedToken();
export const RequestIdV1Schema = boundedToken();
export const IdempotencyKeyV1Schema = boundedToken();
export const OpaqueCursorV1Schema = boundedVisibleText();
export const RetryableV1Schema = z.boolean();

export const ProtocolErrorV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	code: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Z][A-Z0-9_]*$/),
	message: boundedVisibleText(),
	retryable: RetryableV1Schema,
	traceId: TraceIdV1Schema,
});

export type ProtocolErrorV1 = z.infer<typeof ProtocolErrorV1Schema>;
