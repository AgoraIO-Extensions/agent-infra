const maxCommands = 150;
const maxMetadataBytes = 30_000;
const maxNameBytes = 128;
const maxDescriptionBytes = 4096;
const maxArgumentHintBytes = 1024;

const unavailable = () =>
	new Error("RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE");

export type AcpNativeCommandV1 = Readonly<{
	name: string;
	description: string;
	argumentHint?: string;
	source: "acp";
}>;

export type AcpNativeCommandDirectoryV1 = Readonly<{
	nativeId: string;
	commands: readonly AcpNativeCommandV1[];
	readAt: number;
}>;

function text(value: unknown, maximum: number): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		Buffer.byteLength(value, "utf8") > maximum ||
		!value.isWellFormed() ||
		[...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	)
		return undefined;
	return value;
}

function exactRecord(value: unknown, required: readonly string[]) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw unavailable();
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (
		keys.length !== required.length ||
		required.some((key) => !Object.hasOwn(record, key)) ||
		keys.some((key) => !required.includes(key))
	)
		throw unavailable();
	return record;
}

function parseCommand(value: unknown): AcpNativeCommandV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw unavailable();
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (
		keys.some((key) => !["name", "description", "input"].includes(key)) ||
		!Object.hasOwn(record, "name") ||
		!Object.hasOwn(record, "description")
	)
		throw unavailable();
	const name = text(record.name, maxNameBytes);
	const description = text(record.description, maxDescriptionBytes);
	if (
		!name ||
		!description ||
		!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name)
	)
		throw unavailable();
	let argumentHint: string | undefined;
	if (record.input !== undefined && record.input !== null) {
		const input = exactRecord(record.input, ["hint"]);
		argumentHint = text(input.hint, maxArgumentHintBytes);
		if (!argumentHint) throw unavailable();
	}
	return Object.freeze({
		name,
		description,
		source: "acp" as const,
		...(argumentHint === undefined ? {} : { argumentHint }),
	});
}

export function parseAcpAvailableCommandsV1(
	value: unknown,
): readonly AcpNativeCommandV1[] {
	try {
		const serialized = JSON.stringify(value);
		if (Buffer.byteLength(serialized, "utf8") > maxMetadataBytes)
			throw unavailable();
	} catch {
		throw unavailable();
	}
	if (!Array.isArray(value) || value.length > maxCommands) throw unavailable();
	const commands = value.map(parseCommand);
	if (new Set(commands.map((command) => command.name)).size !== commands.length)
		throw unavailable();
	return Object.freeze(
		commands.toSorted((left, right) => left.name.localeCompare(right.name)),
	);
}

export function createAcpNativeCommandDirectoryV1(input: {
	nativeId: string;
	commands: unknown;
	readAt?: number;
}): AcpNativeCommandDirectoryV1 {
	if (
		!text(input.nativeId, maxNameBytes) ||
		!Number.isSafeInteger(input.readAt ?? Date.now()) ||
		(input.readAt ?? Date.now()) <= 0
	)
		throw unavailable();
	return Object.freeze({
		nativeId: input.nativeId,
		commands: parseAcpAvailableCommandsV1(input.commands),
		readAt: input.readAt ?? Date.now(),
	});
}
