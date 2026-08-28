import { z } from "zod";

const boundedToken = () =>
	z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9._~-]+$/);
const nonEmptyString = () => z.string().min(1);
const rfc3339Timestamp = new RegExp(
	`${z.regexes.date.source.slice(0, -1)}[Tt](?:[01]\\d|2[0-3]):[0-5]\\d:(?:[0-5]\\d|60)(?:\\.\\d+)?(?:[Zz]|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`,
);

export const SchemaVersionV1Schema = z.literal(1);
export const OpaqueIdV1Schema = nonEmptyString();
export const Rfc3339TimestampV1Schema = z
	.string()
	.regex(rfc3339Timestamp)
	.meta({ format: "date-time" });
export const TraceIdV1Schema = nonEmptyString();
export const RequestIdV1Schema = nonEmptyString();
export const IdempotencyKeyV1Schema = boundedToken();
export const OpaqueCursorV1Schema = nonEmptyString();
export const RetryableV1Schema = z.boolean();

export const ProtocolErrorV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	code: nonEmptyString(),
	message: nonEmptyString(),
	retryable: RetryableV1Schema,
	traceId: TraceIdV1Schema,
});

export type ProtocolErrorV1 = z.infer<typeof ProtocolErrorV1Schema>;
