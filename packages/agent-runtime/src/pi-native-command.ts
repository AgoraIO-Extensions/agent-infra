import { isAbsolute, relative, resolve } from "node:path";
import { piRecord } from "./pi-rpc.js";

const unavailable = () =>
	new Error("RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE");
const maxCommands = 150;
const maxMetadataBytes = 30_000;
const maxTextBytes = 4096;

export type PiNativeCommandSourceV1 = "extension" | "prompt" | "skill";

export type PiNativeCommandV1 = Readonly<{
	name: string;
	description?: string;
	source: PiNativeCommandSourceV1;
	location?: string;
	path?: string;
}>;

export type PiNativeCommandDirectoryV1 = Readonly<{
	nativeId: string;
	commands: readonly PiNativeCommandV1[];
	readAt: number;
}>;

function text(value: unknown, maximum = maxTextBytes): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		!value.isWellFormed() ||
		[...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	)
		return undefined;
	return value;
}

function exactRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
) {
	const record = piRecord(value);
	if (!record) throw unavailable();
	const keys = Object.keys(record);
	const allowed = new Set([...required, ...optional]);
	if (
		keys.length < required.length ||
		keys.length > required.length + optional.length ||
		required.some((key) => !Object.hasOwn(record, key)) ||
		keys.some((key) => !allowed.has(key))
	)
		throw unavailable();
	return record;
}

function containedPath(value: string, roots: readonly string[]) {
	if (!isAbsolute(value) || value.includes("\\")) return false;
	const normalized = resolve(value);
	return roots.some((root) => {
		const relativePath = relative(resolve(root), normalized);
		return (
			relativePath !== "" &&
			!relativePath.startsWith("..") &&
			!isAbsolute(relativePath)
		);
	});
}

function parseCommand(value: unknown, roots: readonly string[]) {
	const record = exactRecord(
		value,
		["name", "source"],
		["description", "location", "path"],
	);
	const name = text(record.name, 128);
	const source = record.source;
	if (
		!name ||
		!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name) ||
		(source !== "extension" && source !== "prompt" && source !== "skill")
	)
		throw unavailable();
	const description =
		record.description === undefined
			? undefined
			: text(record.description, 1024);
	const location =
		record.location === undefined ? undefined : text(record.location);
	const path = record.path === undefined ? undefined : text(record.path);
	if (
		(record.description !== undefined && description === undefined) ||
		(record.location !== undefined && location === undefined) ||
		(record.path !== undefined && path === undefined) ||
		(path !== undefined &&
			(path.includes("\0") ||
				path.split("/").some((part) => part === "..") ||
				(isAbsolute(path) && !containedPath(path, roots))))
	)
		throw unavailable();
	if (source === "skill" && path === undefined) throw unavailable();
	return Object.freeze({
		name,
		...(description === undefined ? {} : { description }),
		source,
		...(location === undefined ? {} : { location }),
		...(path === undefined ? {} : { path }),
	});
}

/** Parse only the reviewed Pi 0.86 `get_commands` payload. */
export function parsePiGetCommandsV1(
	value: unknown,
	options: Readonly<{ allowedRoots?: readonly string[] }> = {},
): readonly PiNativeCommandV1[] {
	try {
		if (JSON.stringify(value).length > maxMetadataBytes) throw unavailable();
	} catch {
		throw unavailable();
	}
	const record = exactRecord(value, ["commands"]);
	if (!Array.isArray(record.commands) || record.commands.length > maxCommands)
		throw unavailable();
	const commands = record.commands.map((command) =>
		parseCommand(command, options.allowedRoots ?? []),
	);
	const names = new Set(commands.map((command) => command.name));
	if (names.size !== commands.length) throw unavailable();
	return Object.freeze(
		commands.toSorted((left, right) => left.name.localeCompare(right.name)),
	);
}

/**
 * Bounded, session-bound preparation seam. It does not expose a RuntimeDriver
 * method yet; #1348/#1148 must provide the authenticated Host consumer first.
 */
export async function readPiNativeCommandsV1(options: {
	nativeId: string;
	expiresAt: number;
	signal: AbortSignal;
	request: () => Promise<unknown>;
	close?: () => Promise<void>;
	allowedRoots?: readonly string[];
}): Promise<PiNativeCommandDirectoryV1> {
	if (
		!text(options.nativeId, 256) ||
		!Number.isSafeInteger(options.expiresAt) ||
		options.expiresAt <= Date.now() ||
		options.signal.aborted
	)
		throw unavailable();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const remaining = options.expiresAt - Date.now();
		const cancelled = new Promise<never>((_, reject) => {
			abort = () => {
				reject(unavailable());
				void options.close?.().catch(() => {});
			};
		});
		onAbort = () => abort?.();
		options.signal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(onAbort, remaining);
		const payload = await Promise.race([options.request(), cancelled]);
		if (options.signal.aborted || Date.now() >= options.expiresAt)
			throw unavailable();
		return Object.freeze({
			nativeId: options.nativeId,
			commands: parsePiGetCommandsV1(payload, options),
			readAt: Date.now(),
		});
	} catch {
		throw unavailable();
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) options.signal.removeEventListener("abort", onAbort);
	}
}
