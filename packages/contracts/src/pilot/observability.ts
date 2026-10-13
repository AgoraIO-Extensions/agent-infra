import { z } from "zod";

const count = z.number().int().safe().nonnegative();

/** Redacted, bounded observability process status for the administrator Ops view. */
export const ObservabilityStatusProjectionV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	service: z.literal("platform-api"),
	enabled: z.boolean(),
	state: z.enum(["active", "closing", "closed"]),
	captureFailures: count,
	exportFailures: count,
	droppedLogs: count,
	invalidRecords: count,
	lastExportFailureAt: z.string().datetime({ offset: true }).optional(),
});

export type ObservabilityStatusProjectionV1 = z.infer<
	typeof ObservabilityStatusProjectionV1Schema
>;
