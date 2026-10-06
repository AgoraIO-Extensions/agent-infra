import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const packageName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/);
const relativePackagePath = z
	.string()
	.regex(
		/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/,
	);
const fileRoot = z
	.string()
	.regex(/^\/[A-Za-z0-9._/-]{1,255}$/)
	.refine((value) => !value.split("/").includes(".."));
const networkOrigin = z
	.string()
	.url()
	.refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === ""
		);
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
	packageObjectVersion: identifier,
	packageDigest: sha256,
	manifestDigest: sha256,
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
	});
export type SkillWorkloadProjectionV1 = z.infer<
	typeof SkillWorkloadProjectionV1Schema
>;

export const MagicSkillProviderOrderV1 = [
	"system",
	"my_library",
	"market",
	"clawhub",
	"skillhub",
	"npx",
	"github",
] as const satisfies readonly SkillProviderIdV1[];
