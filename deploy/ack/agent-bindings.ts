import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { provisionAgents, readPrivateText } from "./provision-agents.ts";

type Source = { kind: string; templateId?: string; interactionMode?: string };
type Entry = { agentId: string; ready: boolean };
type State = {
	schemaVersion: 1;
	origin: string;
	sourceSha: string;
	requestHash: string;
	agents: Record<string, Entry>;
};
type Binding = { name: string; agentId: string; ready: boolean };
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const templates = ["codex", "claude", "opencode", "pi"];

export async function privateJson(file: string) {
	assert(isAbsolute(file));
	const handle = await open(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await handle.stat();
		assert(
			stat.isFile() &&
				stat.uid === process.getuid?.() &&
				(stat.mode & 0o077) === 0,
		);
		assert(stat.size <= 1024 * 1024);
		const bytes = Buffer.alloc(1024 * 1024 + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		assert(bytesRead <= 1024 * 1024);
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(0, bytesRead),
			),
		);
	} finally {
		await handle.close();
	}
}

async function privateDirectory(directory: string) {
	assert(isAbsolute(directory));
	const stat = await lstat(directory);
	assert(
		stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			stat.uid === process.getuid?.() &&
			(stat.mode & 0o077) === 0,
	);
	const canonical = await realpath(directory);
	let inGit = false;
	try {
		inGit =
			execFileSync(
				"git",
				["-C", canonical, "rev-parse", "--is-inside-work-tree"],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			).trim() === "true";
	} catch {
		// A private state directory has no enclosing repository.
	}
	assert(!inGit);
	return canonical;
}

async function atomicJson(file: string, value: unknown) {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value, null, 2), {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, file);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

export async function provisionWithBindings(
	configFile: string,
	stateDirectory: string,
	blueprintDirectory: string,
	sourceSha: string,
	{ checkOnly = false, requireMatrix = false, materializeOnly = false } = {},
) {
	assert.match(sourceSha, /^[a-f0-9]{40}$/u);
	const directory = await privateDirectory(stateDirectory);
	const lock = join(directory, ".provision-lock");
	await mkdir(lock, { mode: 0o700 });
	try {
		const input = await privateJson(configFile);
		assert(
			input.schemaVersion === 1 &&
				Array.isArray(input.requests) &&
				input.requests.length > 0,
		);
		const url = new URL(input.origin);
		assert(url.protocol === "https:" && url.origin === input.origin);
		const seen = new Set<string>();
		const bodies = [];
		const materials: Record<string, { token: string; body: unknown }> =
			Object.create(null);
		const journeys: {
			name: string;
			filename: string;
			blueprint: Record<string, unknown>;
		}[] = [];
		const filenames = new Set<string>();
		let customCount = 0;
		for (const request of input.requests) {
			assert(
				typeof request.name === "string" &&
					/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(request.name),
			);
			assert(!seen.has(request.name));
			seen.add(request.name);
			assert(
				typeof request.idempotencyKey === "string" &&
					/^[\x21-\x7e]{8,256}$/u.test(request.idempotencyKey),
			);
			const token = await readPrivateText(request.credentialFile, "CREDENTIAL");
			const body = await privateJson(request.bodyFile);
			materials[request.name] = { token, body };
			const source = body.source as Source;
			assert(
				source && (source.kind === "standard" || source.kind === "custom"),
			);
			if (source.kind === "custom") customCount++;
			bodies.push({
				name: request.name,
				body,
				idempotencyKey: request.idempotencyKey,
			});
			let filename: string | undefined;
			if (source.kind === "standard") {
				assert(source.templateId && templates.includes(source.templateId));
				filename = source.templateId;
			} else if (source.interactionMode === "platform-adapter") {
				filename = `custom-${request.name}`;
			}
			if (filename) {
				assert(!filenames.has(filename));
				filenames.add(filename);
				const blueprint = await privateJson(
					join(blueprintDirectory, `${filename}.json`),
				);
				assert(blueprint.origin === input.origin);
				assert(
					typeof blueprint.prompt === "string" && blueprint.prompt.length > 0,
				);
				assert(
					blueprint.owner?.userId &&
						blueprint.other?.userId &&
						blueprint.owner.userId !== blueprint.other.userId,
				);
				for (const subject of [blueprint.owner, blueprint.other]) {
					const storage = await privateJson(subject.stateFile);
					assert(
						Array.isArray(storage.cookies) && Array.isArray(storage.origins),
					);
				}
				journeys.push({ name: request.name, filename, blueprint });
			}
		}
		if (requireMatrix) {
			assert(
				templates.every((template) => filenames.has(template)) &&
					customCount >= 2,
			);
		}
		const requestHash = hash(JSON.stringify({ origin: input.origin, bodies }));
		const stateFile = join(directory, "agent-bindings.json");
		let state: State = {
			schemaVersion: 1,
			origin: input.origin,
			sourceSha,
			requestHash,
			agents: {},
		};
		const exists = await lstat(stateFile).catch((error) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (exists) {
			state = await privateJson(stateFile);
			assert(
				state.schemaVersion === 1 &&
					state.origin === input.origin &&
					state.sourceSha === sourceSha &&
					state.requestHash === requestHash,
			);
			assert(
				state.agents &&
					typeof state.agents === "object" &&
					!Array.isArray(state.agents),
			);
			for (const [name, entry] of Object.entries(state.agents)) {
				assert(
					seen.has(name) &&
						typeof entry.agentId === "string" &&
						entry.agentId.length > 0 &&
						entry.agentId.length <= 256 &&
						typeof entry.ready === "boolean",
				);
			}
		}
		if (checkOnly)
			return {
				schemaVersion: 1,
				kind: "configuration-only",
				pass: true,
				endpointChecked: false,
			};
		const onBinding = async (binding: Binding) => {
			const previous = Object.hasOwn(state.agents, binding.name)
				? state.agents[binding.name]
				: undefined;
			assert(!previous || previous.agentId === binding.agentId);
			assert(
				Object.entries(state.agents).every(
					([name, entry]) =>
						name === binding.name || entry.agentId !== binding.agentId,
				),
			);
			state.agents[binding.name] = {
				agentId: binding.agentId,
				ready: binding.ready,
			};
			await atomicJson(stateFile, state);
		};
		const result = materializeOnly
			? {
					schemaVersion: 1,
					kind: "private-binding-materialization",
					pass: input.requests.every(
						(request: { name: string }) =>
							Object.hasOwn(state.agents, request.name) &&
							state.agents[request.name].ready,
					),
					endpointChecked: false,
				}
			: await provisionAgents(input, {
					bindings: Object.fromEntries(
						Object.entries(state.agents).map(([name, entry]) => [
							name,
							entry.agentId,
						]),
					),
					onBinding,
					materials,
				});
		// Do not expose partly generated acceptance input if any Agent remains unavailable.
		if (result.pass) {
			const output = join(directory, "browser");
			await mkdir(output, { mode: 0o700 }).catch((error) => {
				if (error.code !== "EEXIST") throw error;
			});
			await privateDirectory(output);
			for (const journey of journeys) {
				assert(state.agents[journey.name]?.ready);
				await atomicJson(join(output, `${journey.filename}.json`), {
					...journey.blueprint,
					agentId: state.agents[journey.name].agentId,
				});
			}
		}
		return result;
	} finally {
		await rmdir(lock);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const [mode, config, stateDirectory, blueprints, sourceSha] =
			process.argv.slice(2);
		assert(["check", "provision", "materialize"].includes(mode));
		const result = await provisionWithBindings(
			config,
			stateDirectory,
			blueprints,
			sourceSha,
			{
				checkOnly: mode === "check",
				requireMatrix: mode !== "provision",
				materializeOnly: mode === "materialize",
			},
		);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (!result.pass) process.exitCode = 1;
	} catch {
		process.stderr.write("ACK_AGENT_BINDINGS_FAILED\n");
		process.exitCode = 1;
	}
}
