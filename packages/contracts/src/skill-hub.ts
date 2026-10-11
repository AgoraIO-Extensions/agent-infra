import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
// Preserve the opaque S3 VersionId; the wire character bound accompanies the UTF-8 byte check.
const objectVersion = z
	.string()
	.min(1)
	.max(1024)
	.regex(/^(?!null(?![\s\S]))[\s\S]+$/)
	.refine(
		(value) =>
			value.isWellFormed() &&
			new TextEncoder().encode(value).byteLength <= 1024,
	);
const packageName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/);
const relativePackagePath = z
	.string()
	.regex(
		/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/,
	);
const fileRoot = z
	.string()
	.regex(/^\/[A-Za-z0-9._/-]{1,255}$/)
	.refine((value) => !value.split("/").includes(".."));
const networkOrigin = z.string().refine((value) => {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
});

export const SkillProviderIdV1Schema = z.enum([
	"system",
	"my_library",
	"market",
	"clawhub",
	"skillhub",
	"npx",
	"github",
]);
export type SkillProviderIdV1 = z.infer<typeof SkillProviderIdV1Schema>;

export const SkillVisibilityV1Schema = z.enum([
	"PRIVATE",
	"MEMBER",
	"ORGANIZATION",
	"MARKET",
]);
export type SkillVisibilityV1 = z.infer<typeof SkillVisibilityV1Schema>;

export const SkillFileEntryV1Schema = z.strictObject({
	path: relativePackagePath.max(512),
	sizeBytes: z.number().int().nonnegative(),
	sha256,
});
export type SkillFileEntryV1 = z.infer<typeof SkillFileEntryV1Schema>;

export const SkillPackageManifestV1Schema = z
	.strictObject({
		schemaVersion: z.literal(1),
		name: packageName,
		version: identifier,
		entryPath: z.literal("SKILL.md"),
		files: z.array(SkillFileEntryV1Schema).min(1).max(2000),
		packageDigest: sha256,
	})
	.superRefine((value, context) => {
		const paths = new Set(value.files.map((entry) => entry.path));
		if (paths.size !== value.files.length) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["files"],
				message: "package file paths must be unique",
			});
		}
		if (!paths.has("SKILL.md")) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["files"],
				message: "package must contain SKILL.md",
			});
		}
	});
export type SkillPackageManifestV1 = z.infer<
	typeof SkillPackageManifestV1Schema
>;

export const SkillVersionRefV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	skillId: identifier,
	skillVersionId: identifier,
	provider: SkillProviderIdV1Schema,
	version: identifier,
	packageObjectVersion: objectVersion,
	packageDigest: sha256,
	manifestDigest: sha256,
	signatureDigest: sha256,
});
export type SkillVersionRefV1 = z.infer<typeof SkillVersionRefV1Schema>;

export const SkillGrantV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	tools: z.array(identifier).max(128),
	connections: z.array(identifier).max(128),
	fileRoots: z.array(fileRoot).max(32),
	networkOrigins: z.array(networkOrigin).max(32),
	scripts: z.literal(false),
});
export type SkillGrantV1 = z.infer<typeof SkillGrantV1Schema>;

export const SkillAgentVersionBindingV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	agentId: identifier,
	agentVersion: identifier,
	skillVersion: SkillVersionRefV1Schema,
	grant: SkillGrantV1Schema,
	syncRevision: z.number().int().positive(),
});
export type SkillAgentVersionBindingV1 = z.infer<
	typeof SkillAgentVersionBindingV1Schema
>;

const positiveRevision = z.number().int().positive();
const failureReason = z.string().min(1).max(256);

export const SkillHubAppliedReceiptV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	agentId: identifier,
	agentVersion: identifier,
	skillName: packageName,
	configurationRevision: positiveRevision,
	syncRevision: positiveRevision,
	skillVersionId: identifier,
	generationId: sha256,
	packageDigest: sha256,
	manifestDigest: sha256,
	targetPath: z.string().regex(/^\.agents\/skills\/[a-z0-9][a-z0-9._-]{0,62}$/),
	readOnly: z.literal(true),
});
export type SkillHubAppliedReceiptV1 = z.infer<
	typeof SkillHubAppliedReceiptV1Schema
>;

const skillHubSyncBindingBase = {
	schemaVersion: z.literal(1),
	agentId: identifier,
	agentVersion: identifier,
	skillName: packageName,
	skillVersion: SkillVersionRefV1Schema,
	configurationRevision: positiveRevision,
	syncRevision: positiveRevision,
};

const pendingSkillHubSyncBindingV1Schema = z.strictObject({
	...skillHubSyncBindingBase,
	state: z.literal("pending_sync"),
	failureReason: z.null(),
	appliedReceipt: z.null(),
});
const syncedSkillHubSyncBindingV1Schema = z
	.strictObject({
		...skillHubSyncBindingBase,
		state: z.literal("synced"),
		failureReason: z.null(),
		appliedReceipt: SkillHubAppliedReceiptV1Schema,
	})
	.superRefine((value, context) => {
		const receipt = value.appliedReceipt;
		if (
			receipt.agentId !== value.agentId ||
			receipt.agentVersion !== value.agentVersion ||
			receipt.skillName !== value.skillName ||
			receipt.configurationRevision !== value.configurationRevision ||
			receipt.syncRevision !== value.syncRevision ||
			receipt.skillVersionId !== value.skillVersion.skillVersionId ||
			receipt.packageDigest !== value.skillVersion.packageDigest ||
			receipt.manifestDigest !== value.skillVersion.manifestDigest ||
			receipt.targetPath !== `.agents/skills/${value.skillName}`
		)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["appliedReceipt"],
				message: "Applied receipt binding mismatch",
			});
	});
const failedSkillHubSyncBindingV1Schema = z.strictObject({
	...skillHubSyncBindingBase,
	state: z.literal("failed"),
	failureReason,
	appliedReceipt: z.null(),
});
const revokedSkillHubSyncBindingV1Schema = z.strictObject({
	...skillHubSyncBindingBase,
	state: z.literal("revoked"),
	failureReason: z.null(),
	appliedReceipt: z.null(),
});

export const SkillHubSyncBindingV1Schema = z.discriminatedUnion("state", [
	pendingSkillHubSyncBindingV1Schema,
	syncedSkillHubSyncBindingV1Schema,
	failedSkillHubSyncBindingV1Schema,
	revokedSkillHubSyncBindingV1Schema,
]);
export type SkillHubSyncBindingV1 = z.infer<typeof SkillHubSyncBindingV1Schema>;

export function validateSkillHubAppliedReceiptV1(
	binding: SkillHubSyncBindingV1,
	receipt: SkillHubAppliedReceiptV1,
): SkillHubAppliedReceiptV1 {
	if (
		binding.state !== "synced" ||
		receipt.agentId !== binding.agentId ||
		receipt.agentVersion !== binding.agentVersion ||
		receipt.skillName !== binding.skillName ||
		receipt.configurationRevision !== binding.configurationRevision ||
		receipt.syncRevision !== binding.syncRevision ||
		receipt.skillVersionId !== binding.skillVersion.skillVersionId ||
		receipt.generationId !== binding.appliedReceipt?.generationId ||
		receipt.packageDigest !== binding.skillVersion.packageDigest ||
		receipt.manifestDigest !== binding.skillVersion.manifestDigest ||
		receipt.targetPath !== `.agents/skills/${binding.skillName}`
	)
		throw new Error("Skill Hub Applied receipt binding mismatch");
	return receipt;
}

export const SkillWorkloadProjectionV1Schema = z
	.strictObject({
		schemaVersion: z.literal(1),
		agentId: identifier,
		agentVersion: identifier,
		skillVersion: SkillVersionRefV1Schema,
		manifest: SkillPackageManifestV1Schema,
		targetPath: z
			.string()
			.regex(/^\.agents\/skills\/[a-z0-9][a-z0-9._-]{0,62}$/),
		readOnly: z.literal(true),
		grant: SkillGrantV1Schema,
	})
	.superRefine((value, context) => {
		if (value.manifest.name !== value.targetPath.split("/").at(-1)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["targetPath"],
				message: "targetPath must match manifest.name",
			});
		}
		if (value.manifest.packageDigest !== value.skillVersion.packageDigest) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["manifest", "packageDigest"],
				message: "manifest packageDigest must match skillVersion packageDigest",
			});
		}
	});
export type SkillWorkloadProjectionV1 = z.infer<
	typeof SkillWorkloadProjectionV1Schema
>;

/** Build the only Worker projection from a verified materialized manifest. */
export function createSkillWorkloadProjectionV1(input: {
	readonly agentId: string;
	readonly agentVersion: string;
	readonly skillVersion: SkillVersionRefV1;
	readonly manifest: unknown;
	readonly manifestDigest: string;
	readonly grant: SkillGrantV1;
}): SkillWorkloadProjectionV1 {
	const manifest = SkillPackageManifestV1Schema.parse(input.manifest);
	if (
		!/^[a-f0-9]{64}$/.test(input.manifestDigest) ||
		input.manifestDigest !== input.skillVersion.manifestDigest
	)
		throw new Error("Materialized Skill manifest digest mismatch");
	return SkillWorkloadProjectionV1Schema.parse({
		schemaVersion: 1,
		agentId: input.agentId,
		agentVersion: input.agentVersion,
		skillVersion: input.skillVersion,
		manifest,
		targetPath: `.agents/skills/${manifest.name}`,
		readOnly: true,
		grant: input.grant,
	});
}

export const MagicSkillProviderOrderV1 = [
	"system",
	"my_library",
	"market",
	"clawhub",
	"skillhub",
	"npx",
	"github",
] as const satisfies readonly SkillProviderIdV1[];
