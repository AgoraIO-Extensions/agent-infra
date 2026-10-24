import { createHash } from "node:crypto";
import {
	type NativeMetadataCommandEffectV2,
	type NativeMetadataCommandsProjectionV2,
	NativeMetadataCommandsProjectionV2Schema,
	type NativeMetadataProjectionV1,
	NativeMetadataProjectionV1Schema,
} from "@agent-infra/contracts/runtime";
import { RuntimeHostError } from "./errors.js";

// `localeCompare` depends on the host locale, so the same directory could sort
// differently (and produce a different `revision` digest) on another host.
const compareByName = (
	left: { readonly name: string },
	right: { readonly name: string },
) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

const maxCapabilities = 128;
const maxIdentityText = 256;
const maxCapabilityText = 256;
const maxDescription = 4096;
const maxSourceVersion = 128;
const digestPattern = /^[a-f0-9]{64}$/;

export type NativeMetadataProjectionSourceV1 = Readonly<{
	name: string;
	version: string;
}>;

type NativeMetadataCommandRecord = Readonly<Record<string, unknown>>;
type NativeMetadataSkillRecord = Readonly<Record<string, unknown>>;

function invalid(): never {
	throw new RuntimeHostError(
		"RUNTIME_NATIVE_METADATA_INVALID",
		"Native metadata projection is unavailable",
		503,
		false,
		"unavailable",
	);
}

function boundedText(
	value: unknown,
	maximum: number,
	allowEmpty = false,
): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		value.length > maximum ||
		!value.isWellFormed() ||
		[...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 0x20 || code === 0x7f;
		})
	)
		invalid();
	return value;
}

function digest(value: unknown): string {
	try {
		return createHash("sha256").update(JSON.stringify(value)).digest("hex");
	} catch {
		invalid();
	}
}

function record(value: unknown): NativeMetadataCommandRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as NativeMetadataCommandRecord;
}

function exactKeys(
	value: NativeMetadataCommandRecord,
	allowed: readonly string[],
) {
	if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function projectionSource(value: unknown): NativeMetadataProjectionSourceV1 {
	const source = record(value);
	exactKeys(source, ["name", "version"]);
	return {
		name: boundedText(source.name, maxCapabilityText),
		version: boundedText(source.version, maxSourceVersion),
	};
}

function commandDirectory(value: unknown) {
	let commands: readonly unknown[];
	let nativeId: unknown;
	let readAt: unknown;
	if (Array.isArray(value)) {
		commands = value;
	} else {
		const directory = record(value);
		exactKeys(directory, ["nativeId", "commands", "readAt"]);
		nativeId = directory.nativeId;
		readAt = directory.readAt;
		commands = directory.commands as readonly unknown[];
	}
	const boundedNativeId =
		nativeId === undefined ? undefined : boundedText(nativeId, maxIdentityText);
	if (
		readAt !== undefined &&
		(!Number.isSafeInteger(readAt) || (readAt as number) <= 0)
	)
		invalid();
	if (!Array.isArray(commands) || commands.length > maxCapabilities) invalid();
	return { nativeId: boundedNativeId, commands };
}

function commandCapability(
	value: unknown,
	source: NativeMetadataProjectionSourceV1,
) {
	const command = record(value);
	exactKeys(command, [
		"name",
		"description",
		"argumentHint",
		"aliases",
		"input",
		"source",
		"location",
		"path",
	]);
	const name = boundedText(command.name, maxCapabilityText);
	const description = boundedText(
		command.description === undefined ? "" : command.description,
		maxDescription,
		true,
	);
	let argumentHint = "";
	if (command.argumentHint !== undefined)
		argumentHint = boundedText(command.argumentHint, 1024, true);
	if (command.input !== undefined && command.input !== null) {
		const input = record(command.input);
		exactKeys(input, ["hint"]);
		argumentHint = boundedText(input.hint, 1024, true);
	}
	const location =
		command.location === undefined
			? ""
			: boundedText(command.location, 4096, true);
	const path =
		command.path === undefined ? "" : boundedText(command.path, 4096, true);
	const nativeSource =
		command.source === undefined
			? ""
			: boundedText(command.source, maxCapabilityText);
	let aliases: readonly string[] = [];
	if (command.aliases !== undefined) {
		if (!Array.isArray(command.aliases) || command.aliases.length > 32)
			invalid();
		aliases = command.aliases.map((alias) =>
			boundedText(alias, maxCapabilityText),
		);
		if (new Set(aliases).size !== aliases.length || aliases.includes(name))
			invalid();
	}
	return {
		kind: "command" as const,
		name,
		description,
		source,
		identity: { argumentHint, aliases, nativeSource, location, path },
	};
}

export function projectNativeMetadataCommandsV1(input: {
	readonly nativeSessionRef: string;
	readonly configVersion: string;
	readonly source: NativeMetadataProjectionSourceV1;
	readonly directory: unknown;
	readonly assertCurrent?: () => void;
}): NativeMetadataProjectionV1 {
	const nativeSessionRef = boundedText(input.nativeSessionRef, maxIdentityText);
	const configVersion = boundedText(input.configVersion, maxIdentityText);
	const source = projectionSource(input.source);
	input.assertCurrent?.();
	const directory = commandDirectory(input.directory);
	const commands = directory.commands
		.map((command) => commandCapability(command, source))
		.sort(compareByName);
	if (new Set(commands.map((command) => command.name)).size !== commands.length)
		invalid();
	const revision = digest([
		"native-metadata-commands-v1",
		nativeSessionRef,
		configVersion,
		source,
		directory.nativeId,
		commands.map(({ identity, ...command }) => ({ command, identity })),
	]);
	const projection = NativeMetadataProjectionV1Schema.parse({
		selector: "commands",
		revision,
		capabilities: commands.map(({ identity, ...command }) => ({
			id: digest(["native-metadata-command-v1", revision, identity, command]),
			...command,
			parameters: [],
			effect: "read_only",
			availability: "available",
		})),
	});
	input.assertCurrent?.();
	return projection;
}

function skillDirectory(value: unknown) {
	const directory = record(value);
	exactKeys(directory, ["generationId", "entries"]);
	const generationId = boundedText(directory.generationId, maxIdentityText);
	if (!digestPattern.test(generationId)) invalid();
	if (
		!Array.isArray(directory.entries) ||
		directory.entries.length > maxCapabilities
	)
		invalid();
	return { generationId, entries: directory.entries };
}

function skillCapability(value: unknown) {
	const entry = record(value) as NativeMetadataSkillRecord;
	exactKeys(entry, [
		"schemaVersion",
		"name",
		"version",
		"packageDigest",
		"manifestDigest",
		"targetPath",
		"readOnly",
	]);
	if (entry.schemaVersion !== 1 || entry.readOnly !== true) invalid();
	const name = boundedText(entry.name, maxCapabilityText);
	const version = boundedText(entry.version, maxSourceVersion);
	const packageDigest = boundedText(entry.packageDigest, 256);
	const manifestDigest = boundedText(entry.manifestDigest, 256);
	if (!digestPattern.test(packageDigest) || !digestPattern.test(manifestDigest))
		invalid();
	const targetPath = boundedText(entry.targetPath, 4096);
	if (
		!/^\.agents\/skills\/[a-z0-9][a-z0-9._-]{0,62}$/.test(targetPath) ||
		targetPath !== `.agents/skills/${name}`
	)
		invalid();
	return { name, version, packageDigest, manifestDigest, targetPath };
}

export function projectNativeMetadataSkillsV1(input: {
	readonly nativeSessionRef: string;
	readonly configVersion: string;
	readonly sourceName: string;
	readonly directory: unknown;
	readonly assertCurrent?: () => void;
}): NativeMetadataProjectionV1 {
	const nativeSessionRef = boundedText(input.nativeSessionRef, maxIdentityText);
	const configVersion = boundedText(input.configVersion, maxIdentityText);
	const sourceName = boundedText(input.sourceName, maxCapabilityText);
	input.assertCurrent?.();
	const { generationId, entries } = skillDirectory(input.directory);
	const skills = entries.map(skillCapability).sort(compareByName);
	if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
		invalid();
	const revision = digest([
		"native-metadata-skills-v1",
		nativeSessionRef,
		configVersion,
		sourceName,
		generationId,
		skills,
	]);
	const projection = NativeMetadataProjectionV1Schema.parse({
		selector: "skills",
		revision,
		capabilities: skills.map((skill) => ({
			id: digest([
				"native-metadata-skill-v1",
				revision,
				skill.name,
				skill.version,
				skill.packageDigest,
				skill.manifestDigest,
			]),
			kind: "skill",
			name: skill.name,
			description: "",
			source: { name: sourceName, version: skill.version },
			availability: "discovered",
		})),
	});
	input.assertCurrent?.();
	return projection;
}

/** Versioned projection for effects and bounded text hints unavailable in V1. */
export function projectNativeMetadataCommandsV2(input: {
	readonly nativeSessionRef: string;
	readonly configVersion: string;
	readonly source: NativeMetadataProjectionSourceV1;
	readonly directory: unknown;
	readonly effect: NativeMetadataCommandEffectV2;
	readonly argumentHint?: string;
	readonly requiredParameter?: boolean;
	readonly assertCurrent?: () => void;
}): NativeMetadataCommandsProjectionV2 {
	const nativeSessionRef = boundedText(input.nativeSessionRef, maxIdentityText);
	const configVersion = boundedText(input.configVersion, maxIdentityText);
	const source = projectionSource(input.source);
	const argumentHint =
		input.argumentHint === undefined
			? ""
			: boundedText(input.argumentHint, 1024, true);
	const requiredParameter = input.requiredParameter ?? false;
	input.assertCurrent?.();
	const directory = commandDirectory(input.directory);
	const commands = directory.commands
		.map((command) => commandCapability(command, source))
		.sort(compareByName);
	if (new Set(commands.map((command) => command.name)).size !== commands.length)
		invalid();
	const revision = digest([
		"native-metadata-commands-v2",
		nativeSessionRef,
		configVersion,
		source,
		directory.nativeId,
		input.effect,
		argumentHint,
		requiredParameter,
		commands.map(({ identity, ...command }) => ({ command, identity })),
	]);
	const projection = NativeMetadataCommandsProjectionV2Schema.parse({
		schemaVersion: 1,
		selector: "commands",
		revision,
		capabilities: commands.map(({ identity, ...command }) => {
			const hint = input.argumentHint ?? identity.argumentHint;
			return {
				schemaVersion: 2,
				id: digest(["native-metadata-command-v2", revision, identity, command]),
				...command,
				parameters:
					hint.length > 0 || requiredParameter
						? [{ kind: "text", required: requiredParameter, hint }]
						: [],
				effect: input.effect,
				availability: "available",
			};
		}),
	});
	input.assertCurrent?.();
	return projection;
}
