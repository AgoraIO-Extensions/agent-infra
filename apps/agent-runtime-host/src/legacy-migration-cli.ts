import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readWorkloadReadinessBindingV1 } from "./configuration.js";
import {
	RuntimeLegacyMigrationError,
	type RuntimeLegacyMigrationFilesystem,
	readRuntimeLegacyMigrationV1,
} from "./legacy-migration.js";
import {
	readRuntimeLegacyJournal as journal,
	previewRuntimeLegacyMigration,
} from "./legacy-migration-journal.js";

const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
function fail(): never {
	throw new RuntimeLegacyMigrationError();
}

/** FileRuntimeStore.open may normalize/quarantine old state. None of those changes
 * are permitted by this offline operation: only the verified principal addition is.
 * Signature, complete-set and principal verification remain in the existing loader/Store.
 */
function onlyPrincipalAdded(beforeBytes: Buffer, afterBytes: Buffer) {
	const before = JSON.parse(beforeBytes.toString("utf8"));
	const after = JSON.parse(afterBytes.toString("utf8"));
	if (!before.sessions || !after.sessions) fail();
	if (
		!isDeepStrictEqual(
			Object.keys(before.sessions).sort(),
			Object.keys(after.sessions).sort(),
		)
	)
		fail();
	let changed = 0;
	for (const ref of Object.keys(before.sessions)) {
		const previous = before.sessions[ref];
		const current = after.sessions[ref];
		if (isDeepStrictEqual(previous, current)) continue;
		if (
			previous.authority !== undefined ||
			previous.executionAuthorities !== undefined ||
			!current.authority ||
			!isDeepStrictEqual(current.executionAuthorities, {})
		)
			fail();
		const {
			authority: _authority,
			executionAuthorities: _executions,
			...rest
		} = current;
		if (!isDeepStrictEqual(previous, rest)) fail();
		changed++;
	}
	after.sessions = before.sessions;
	if (changed > 1 || !isDeepStrictEqual(before, after)) fail();
	return changed === 1;
}

/** One-shot deployment bootstrap, never a service or an operation Grant.
 * The operator MUST first stop the Agent through normal lifecycle, drain every Pod
 * using the original PVC. Default mode only emits a verified candidate. Explicit
 * offline-commit additionally requires ALL Platform API/Worker entrypoints for
 * this isolated deployment to remain stopped until this Job terminates and is removed.
 * A remote DB row lock alone cannot guarantee that window after orchestrator failure.
 * The local lock serializes these CLIs, not a running Host. No Driver, listener,
 * DB client, signing private key or original task is opened.
 */
export async function runRuntimeLegacyMigrationCli(
	environment: NodeJS.ProcessEnv,
	filesystem?: RuntimeLegacyMigrationFilesystem,
) {
	let ownedLock: string | undefined;
	let createdCandidatePath: string | undefined;
	let preserveCandidate = false;
	try {
		const mode =
			environment.AGENT_INFRA_RUNTIME_LEGACY_BOOTSTRAP_MODE ?? "candidate";
		if (mode !== "candidate" && mode !== "offline-commit") fail();
		const dataDirectory = environment.AGENT_INFRA_RUNTIME_DATA_DIR;
		const expectedIssuer = environment.AGENT_INFRA_RUNTIME_GRANT_ISSUER;
		const candidatePath = environment.AGENT_INFRA_RUNTIME_LEGACY_CANDIDATE_FILE;
		if (
			!dataDirectory ||
			!isAbsolute(dataDirectory) ||
			resolve(dataDirectory) !== dataDirectory ||
			dataDirectory === "/" ||
			!expectedIssuer ||
			!candidatePath ||
			!isAbsolute(candidatePath) ||
			resolve(candidatePath) !== candidatePath ||
			!(await lstat(dataDirectory)).isDirectory()
		)
			fail();
		const canonicalDirectory = await realpath(dataDirectory);
		const candidateDirectory = dirname(candidatePath);
		const candidateParent = await realpath(candidateDirectory);
		for (let current = candidateParent; ; current = dirname(current)) {
			const info = await lstat(current);
			const parent = dirname(current);
			const stickyRootDirectory = info.uid === 0 && (info.mode & 0o1000) !== 0;
			if (
				!info.isDirectory() ||
				(await realpath(current)) !== current ||
				((info.mode & 0o022) !== 0 && !stickyRootDirectory)
			)
				fail();
			if (parent === current) break;
		}
		const candidateLeaf = relative(candidateDirectory, candidatePath);
		const canonicalCandidatePath = join(candidateParent, candidateLeaf);
		const withinData = relative(canonicalDirectory, candidateParent);
		if (
			withinData === "" ||
			(!isAbsolute(withinData) &&
				withinData !== ".." &&
				!withinData.startsWith("../")) ||
			((await lstat(candidateParent)).mode & 0o022) !== 0
		)
			fail();
		const binding = readWorkloadReadinessBindingV1(environment);
		if (!binding) fail();
		const migration = await readRuntimeLegacyMigrationV1({
			environment,
			expectedIssuer,
			binding,
			dataDirectory: canonicalDirectory,
			filesystem,
		});
		if (!migration) fail();
		const lock = join(canonicalDirectory, ".legacy-migration-bootstrap-lock");
		await mkdir(lock, { mode: 0o700 });
		ownedLock = lock;
		const path = join(canonicalDirectory, "host.json");
		const before = await journal(path); // Missing original state must never initialize.
		const after = await previewRuntimeLegacyMigration(before.bytes, migration);
		const changed = onlyPrincipalAdded(before.bytes, after);
		const current = await journal(path);
		if (
			current.stat.dev !== before.stat.dev ||
			current.stat.ino !== before.stat.ino ||
			!current.bytes.equals(before.bytes)
		)
			fail();
		// A candidate is reviewable output, never a durable commit to original state.
		// Require a new file outside the original data directory; never overwrite output.
		await writeFile(canonicalCandidatePath, changed ? after : before.bytes, {
			flag: "wx",
			mode: 0o600,
		});
		createdCandidatePath = canonicalCandidatePath;
		if (mode === "offline-commit" && changed) {
			if (!ownedLock) fail();
			const pending = join(ownedLock, "host.json");
			const file = await open(pending, "wx", 0o600);
			try {
				await file.writeFile(after);
				await file.sync();
			} finally {
				await file.close();
			}
			const latest = await journal(path);
			if (
				latest.stat.ino !== before.stat.ino ||
				latest.stat.dev !== before.stat.dev ||
				!latest.bytes.equals(before.bytes)
			)
				fail();
			// Drift check above is NOT atomic CAS. Safety requires the documented offline
			// window; same-filesystem rename and directory fsync provide durable commit.
			await rename(pending, path);
			const directory = await open(canonicalDirectory, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
		const committed = await journal(path);
		if (
			!committed.bytes.equals(
				mode === "offline-commit" && changed ? after : before.bytes,
			)
		)
			fail();
		preserveCandidate = true;
		return {
			schemaVersion: 1 as const,
			status:
				mode === "candidate"
					? ("verified_candidate" as const)
					: changed
						? ("applied" as const)
						: ("replayed" as const),
			commitPerformed: mode === "offline-commit" && changed,
			wouldChange: changed,
			deployment: binding,
			journalBeforeSha256: hash(before.bytes),
			candidateSha256: hash(changed ? after : before.bytes),
			journalAfterSha256: hash(committed.bytes),
			driverOpened: false as const,
			listenerOpened: false as const,
		};
	} catch {
		fail();
	} finally {
		if (createdCandidatePath && !preserveCandidate) {
			try {
				await rm(createdCandidatePath, { force: true });
			} catch {
				console.warn(
					JSON.stringify({
						service: "agent-runtime-host",
						code: "RUNTIME_LEGACY_MIGRATION_CANDIDATE_CLEANUP_FAILED",
					}),
				);
			}
		}
		// Cleanup is best effort. Once the durable rename and read-back succeed,
		// a transient cleanup failure must not turn a committed migration into an
		// apparent failure for the caller.
		try {
			if (ownedLock) await rm(ownedLock, { recursive: true });
		} catch {
			console.warn(
				JSON.stringify({
					service: "agent-runtime-host",
					code: "RUNTIME_LEGACY_MIGRATION_LOCK_CLEANUP_FAILED",
				}),
			);
		}
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	runRuntimeLegacyMigrationCli(process.env).then(
		(result) => console.info(JSON.stringify(result)),
		() => {
			console.error("RUNTIME_LEGACY_MIGRATION_INVALID");
			process.exitCode = 1;
		},
	);
}
