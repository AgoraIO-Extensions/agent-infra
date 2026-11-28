import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { parseDocument } from "yaml";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizer,
} from "./driver.js";
import { RuntimeHostError } from "./errors.js";
import type { NativeSessionOptions } from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

const unavailable = () => new Error("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
const denied = () => new Error("RUNTIME_AUTHORIZATION_DENIED");
const maximumMetadataBytes = 30_000;
const namePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;

async function readEntry(path: string, includeMetadata = false) {
	if ((await realpath(path)) !== path) throw unavailable();
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink > 2) throw unavailable();
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(64 * 1024);
		// The Native read can page through large documents. Discovery only needs the header.
		const header = Buffer.alloc(
			includeMetadata ? Math.min(stat.size, maximumMetadataBytes) : 0,
		);
		let offset = 0;
		while (offset < stat.size) {
			const { bytesRead } = await file.read(
				buffer,
				0,
				Math.min(buffer.length, stat.size - offset),
				offset,
			);
			if (!bytesRead) throw unavailable();
			const chunk = buffer.subarray(0, bytesRead);
			hash.update(chunk);
			if (offset < header.length) chunk.copy(header, offset);
			offset += bytesRead;
		}
		const after = await file.stat();
		if (
			after.size !== stat.size ||
			after.mtimeMs !== stat.mtimeMs ||
			after.nlink !== stat.nlink
		)
			throw unavailable();
		return { header, digest: hash.digest("hex") };
	} finally {
		await file.close();
	}
}

type Entry = Readonly<{ name: string; description: string; path: string }>;

/** Only regular entry files in the trusted Session projection can become native read targets. */
export async function openPublishedDeploymentSkills(input: {
	root: string;
	scope: string;
	sessionScope: string;
	hub?: RuntimeFilesystemSkillDirectoryV1;
	bundledNames: Iterable<string>;
}) {
	if (input.scope !== input.sessionScope) throw denied();
	const skills = join(input.root, ".agents", "skills");
	const receipt = join(input.root, ".agents", "sha256");
	const folders = await readdir(skills, { withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw unavailable();
		},
	);
	const byPath = new Map<string, Entry & { digest: string }>();
	const names = new Set<string>();
	const conflicts = new Set<string>();
	const reserved = new Set([
		...input.bundledNames,
		...(input.hub?.findSkills().map((entry) => entry.name) ?? []),
	]);
	let frozenDigest: string | undefined;
	if (folders.length) {
		if (
			(await realpath(skills)) !== skills ||
			(await realpath(receipt)) !== receipt
		)
			throw unavailable();
		frozenDigest = await readFile(receipt, "utf8");
		if (!/^[a-f0-9]{64}$/.test(frozenDigest)) throw unavailable();
	}
	for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!folder.isDirectory()) continue;
		const path = join(skills, folder.name, "SKILL.md");
		const { header, digest } = await readEntry(path, true);
		const frontmatter =
			/^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
				header.toString("utf8"),
			)?.[1];
		if (!frontmatter) continue;
		const doc = parseDocument(frontmatter);
		if (doc.errors.length || doc.warnings.length) continue;
		const name = doc.get("name");
		const description = doc.get("description");
		if (typeof name !== "string" || !namePattern.test(name)) continue;
		if (names.has(name) || reserved.has(name)) conflicts.add(name);
		names.add(name);
		// A folder is used in the upstream external_directory glob. Never accept pattern characters.
		if (
			/[\\*?[\]{}\p{Cc}]/u.test(folder.name) ||
			typeof description !== "string" ||
			!description.trim() ||
			description.length > 1024 ||
			doc.get("disable-model-invocation") === true
		)
			continue;
		byPath.set(path, { name, description, path, digest });
	}
	const assertUnambiguous = (name?: string) => {
		if (name === undefined ? conflicts.size > 0 : conflicts.has(name))
			throw new RuntimeHostError(
				"RUNTIME_SKILL_SOURCE_CONFLICT",
				"RUNTIME_SKILL_SOURCE_CONFLICT",
				409,
			);
	};
	const entries = [...byPath.values()]
		.filter((entry) => !conflicts.has(entry.name))
		.map(({ name, description, path }) => ({ name, description, path }));
	if (Buffer.byteLength(JSON.stringify(entries)) > maximumMetadataBytes)
		throw unavailable();
	return {
		entries,
		conflictingNames: [...conflicts],
		assertUnambiguous,
		async verifyRead(path: string) {
			const entry = byPath.get(path);
			if (!entry) throw denied();
			assertUnambiguous(entry.name);
			if (input.hub?.findSkills().some((skill) => skill.name === entry.name))
				throw new RuntimeHostError(
					"RUNTIME_SKILL_SOURCE_CONFLICT",
					"RUNTIME_SKILL_SOURCE_CONFLICT",
					409,
				);
			if (
				(await realpath(receipt)) !== receipt ||
				(await readFile(receipt, "utf8")) !== frozenDigest ||
				(await readEntry(path)).digest !== entry.digest
			)
				throw denied();
		},
	};
}

export function publishedDeploymentSkillInstructions(
	entries: readonly Entry[],
) {
	return entries.length
		? `\nFor a task matching an available deployment Skill, use the native read tool on its exact path to load the instructions.\n${JSON.stringify(entries)}\n`
		: "";
}

/** Maps one announced native read to its original Host journal operation and allow-once decision. */
export function publishedDeploymentReadActions(
	directory: Awaited<ReturnType<typeof openPublishedDeploymentSkills>>,
	session: () => Pick<
		NativeSessionOptions,
		"runtimeSessionRef" | "executionId" | "ordinaryTurn" | "recordOperationFact"
	>,
	authorize: RuntimeExternalActionAuthorizer,
) {
	type Read = {
		id: string;
		path: string;
		startedAt?: string;
		source: ReturnType<typeof session>;
		fact: Extract<RuntimeOperationFactV2, { kind: "tool" }>;
		revalidate: () => void;
		finished: boolean;
	};
	const calls = new Map<string, Read>();
	const nativeNames = new Set<string>();
	const sameTurn = (read: Read) =>
		session().executionId === read.source.executionId && session().ordinaryTurn;
	const assertCurrent = (read: Read) => {
		if (!sameTurn(read) || calls.get(read.id) !== read) throw denied();
		read.revalidate();
	};
	const assertUnambiguous = (name?: string) => {
		directory.assertUnambiguous(name);
		if (
			name &&
			directory.entries.some((entry) => entry.name === name) &&
			nativeNames.has(name)
		)
			throw new RuntimeHostError(
				"RUNTIME_SKILL_SOURCE_CONFLICT",
				"RUNTIME_SKILL_SOURCE_CONFLICT",
				409,
			);
	};
	const finishTool = async (
		id: string,
		phase: "completed" | "failed" | "unknown",
	) => {
		const call = calls.get(id);
		if (!call || call.finished) return;
		call.finished = true;
		await call.source.recordOperationFact?.({
			...call.fact,
			phase,
			...(call.startedAt ? { startedAt: call.startedAt } : {}),
			finishedAt: new Date(
				Math.max(Date.now(), call.startedAt ? Date.parse(call.startedAt) : 0),
			).toISOString(),
			...(phase === "failed"
				? { failureCode: "operation_failed" as const }
				: phase === "unknown"
					? { failureCode: "response_incomplete" as const }
					: {}),
		});
	};
	return {
		assertUnambiguous,
		entriesForPrompt(commands?: readonly { name: string }[]) {
			nativeNames.clear();
			for (const command of commands ?? []) nativeNames.add(command.name);
			return commands && session().ordinaryTurn
				? directory.entries.filter((entry) => !nativeNames.has(entry.name))
				: [];
		},
		async allow(
			id: string,
			path: string,
			commands?: readonly { name: string }[],
		) {
			const source = session();
			const entry = directory.entries.find((entry) => entry.path === path);
			if (
				!source.ordinaryTurn ||
				!source.recordOperationFact ||
				!source.executionId ||
				!entry ||
				!commands ||
				calls.has(id)
			)
				return false;
			assertUnambiguous(entry.name);
			if (commands.some((command) => command.name === entry.name)) return false;
			const fact = {
				kind: "tool" as const,
				toolId: "Read",
				operationRef: randomUUID(),
				attemptRef: randomUUID(),
				phase: "intent" as const,
			};
			// Reserve before the first await. ACP may request permission more than once.
			const call: Read = {
				id,
				path,
				source,
				fact,
				revalidate: () => {
					throw denied();
				},
				finished: false,
			};
			calls.set(id, call);
			await source.recordOperationFact(fact);
			try {
				const grant = await authorize({
					...fact,
					nativeSessionRef: source.runtimeSessionRef,
					executionId: source.executionId,
					runtimeOperationId: source.executionId,
				});
				if (!grant?.revalidate) throw denied();
				call.revalidate = grant.revalidate;
				assertCurrent(call);
				await directory.verifyRead(path);
				assertCurrent(call);
				const startedAt = new Date().toISOString();
				await source.recordOperationFact({
					...fact,
					phase: "started",
					startedAt,
				});
				call.startedAt = startedAt;
				assertCurrent(call);
				return () => assertCurrent(call);
			} catch {
				await finishTool(id, "failed");
				return false;
			}
		},
		ownsToolUse: (id: string) => calls.has(id),
		ownsAction: (action: RuntimeExternalActionAuthorization) =>
			[...calls.values()].some(
				(read) =>
					!read.finished &&
					sameTurn(read) &&
					read.fact.operationRef === action.operationRef &&
					read.fact.attemptRef === action.attemptRef,
			),
		finishTool,
		async finishPending() {
			for (const read of calls.values()) await finishTool(read.id, "unknown");
		},
		// The native process reads only after allow_once. Check that original grant again
		// before the model transport can forward a request containing its tool result.
		revalidate() {
			for (const read of calls.values()) assertCurrent(read);
		},
		async verifySources() {
			for (const read of calls.values()) {
				assertCurrent(read);
				await directory.verifyRead(read.path);
				assertCurrent(read);
			}
		},
		beginTurn() {
			calls.clear();
			nativeNames.clear();
		},
	};
}
