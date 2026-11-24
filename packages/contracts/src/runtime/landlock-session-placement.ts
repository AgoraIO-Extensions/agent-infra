import { z } from "zod";

const id = z.string().min(1).max(256);
const positive = z.number().int().positive().safe();
export const LandlockSessionScopeV1Schema = z.strictObject({
	principalDigest: id,
	channelId: id,
	agentId: id,
	sessionId: id,
	sandboxId: id,
	namespace: id,
	generation: positive,
	resourceFence: positive,
	imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	resourceConfigurationHash: id,
	driver: z.enum(["claude", "acp", "pi"]),
});
export type LandlockSessionScopeV1 = z.infer<
	typeof LandlockSessionScopeV1Schema
>;
/** Store-owned original placement. Fresh admission authority is never serialized. */
export const LandlockSessionPlacementV1Schema = z
	.strictObject({
		schemaVersion: z.literal(1),
		revision: id,
		scope: LandlockSessionScopeV1Schema,
		approvalRef: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
		architecture: z.enum(["amd64", "arm64"]),
		nodeNames: z
			.array(
				z
					.string()
					.max(253)
					.regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/),
			)
			.min(1)
			.max(64),
		nodeUids: z.array(id).min(1).max(64),
	})
	.superRefine((p, ctx) => {
		if (
			p.nodeNames.length !== p.nodeUids.length ||
			new Set(p.nodeNames).size !== p.nodeNames.length ||
			new Set(p.nodeUids).size !== p.nodeUids.length
		)
			ctx.addIssue({ code: "custom", message: "Invalid node identities" });
	});
export type LandlockSessionPlacementV1 = z.infer<
	typeof LandlockSessionPlacementV1Schema
>;
export const LandlockSessionReadinessV1Schema = z.strictObject({
	podUid: id,
	nodeName: id,
	nodeUid: id,
	launcherExitCode: z.literal(0),
});
export type LandlockSessionReadinessV1 = z.infer<
	typeof LandlockSessionReadinessV1Schema
>;
