import { SkillWorkloadProjectionV1Schema } from "@agent-infra/contracts";

const maxSkills = 150;
const maxMetadataBytes = 30_000;
const defaultMaxResourceBytes = 1_048_576;

export type RuntimeSkillDirectoryEntryV1 = Readonly<{
	schemaVersion: 1;
	name: string;
	version: string;
	packageDigest: string;
	manifestDigest: string;
	targetPath: string;
	readOnly: true;
}>;

export type RuntimeSkillDirectoryReadRequestV1 = Readonly<{
	skill: RuntimeSkillDirectoryEntryV1;
	relativePath: string;
	maximumBytes: number;
}>;

export class RuntimeSkillDirectoryErrorV1 extends Error {
	readonly code = "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE" as const;

	constructor() {
		super("Runtime Skill directory is unavailable");
		this.name = "RuntimeSkillDirectoryErrorV1";
	}
}

function unavailable(): never {
	throw new RuntimeSkillDirectoryErrorV1();
}

function boundedRelativePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 512 ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.startsWith("/") ||
		value
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	)
		unavailable();
	return value;
}

function projectionEntry(
	projection: unknown,
	agentId: string,
	agentVersion: string,
): RuntimeSkillDirectoryEntryV1 {
	const parsed = SkillWorkloadProjectionV1Schema.safeParse(projection);
	if (
		!parsed.success ||
		parsed.data.agentId !== agentId ||
		parsed.data.agentVersion !== agentVersion ||
		parsed.data.targetPath !== `.agents/skills/${parsed.data.manifest.name}`
	)
		unavailable();
	return Object.freeze({
		schemaVersion: 1,
		name: parsed.data.manifest.name,
		version: parsed.data.skillVersion.version,
		packageDigest: parsed.data.skillVersion.packageDigest,
		manifestDigest: parsed.data.skillVersion.manifestDigest,
		targetPath: parsed.data.targetPath,
		readOnly: true,
	});
}

export function createRuntimeSkillDirectoryV1(input: {
	agentId: string;
	agentVersion: string;
	generationId: string;
	projections: readonly unknown[];
	maximumResourceBytes?: number;
}) {
	if (
		typeof input.agentId !== "string" ||
		typeof input.agentVersion !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.generationId) ||
		!Array.isArray(input.projections) ||
		input.projections.length > maxSkills
	)
		unavailable();
	const entries = input.projections
		.map((projection) =>
			projectionEntry(projection, input.agentId, input.agentVersion),
		)
		.toSorted((left, right) => left.name.localeCompare(right.name));
	if (
		new Set(entries.map((entry) => entry.name)).size !== entries.length ||
		new Set(entries.map((entry) => entry.targetPath)).size !== entries.length
	)
		unavailable();
	const metadata = Object.freeze(entries.map((entry) => Object.freeze(entry)));
	if (
		Buffer.byteLength(
			JSON.stringify({
				schemaVersion: 1,
				generationId: input.generationId,
				skills: metadata,
			}),
			"utf8",
		) > maxMetadataBytes
	)
		unavailable();
	const maximumResourceBytes =
		input.maximumResourceBytes ?? defaultMaxResourceBytes;
	if (
		!Number.isSafeInteger(maximumResourceBytes) ||
		maximumResourceBytes < 1 ||
		maximumResourceBytes > 10_485_760
	)
		unavailable();
	return {
		generationId: input.generationId,
		findSkills(): readonly RuntimeSkillDirectoryEntryV1[] {
			return metadata;
		},
		async readSkill(
			name: string,
			relativePath: string,
			read: (
				request: RuntimeSkillDirectoryReadRequestV1,
			) => Promise<Uint8Array>,
		): Promise<Uint8Array> {
			const skill = metadata.find((entry) => entry.name === name);
			if (!skill || typeof read !== "function") unavailable();
			const bytes = await read({
				skill,
				relativePath: boundedRelativePath(relativePath),
				maximumBytes: maximumResourceBytes,
			});
			if (
				!(bytes instanceof Uint8Array) ||
				bytes.byteLength > maximumResourceBytes
			)
				unavailable();
			return bytes.slice();
		},
	};
}
