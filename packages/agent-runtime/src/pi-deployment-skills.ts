import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { RuntimeExternalActionAuthorizer } from "./driver.js";
import { RuntimeHostError } from "./errors.js";
import type { NativeSessionOptions } from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

export const piDeploymentFiles = "/opt/agent/deployment-view/published/files";
export const piSkillFolderName = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const unavailable = () => new Error("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
const denied = () => new Error("RUNTIME_AUTHORIZATION_DENIED");
const digest = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

/** Both processes see the same Worker-verified, read-only Sandbox subPath. */
export async function openPiDeploymentSkills({
	scope,
	execution,
	hub,
	root = piDeploymentFiles,
}: {
	scope: string;
	execution: NonNullable<NativeSessionOptions["connectionReference"]>;
	hub?: RuntimeFilesystemSkillDirectoryV1;
	root?: string;
}) {
	if (scope !== `${execution.agentId}:${execution.conversationId}`)
		throw denied();
	const skillsRoot = join(root, ".agents", "skills");
	const folders = await readdir(skillsRoot, { withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw unavailable();
		},
	);
	const entries = new Map<
		string,
		{ name: string; sha256: string; visible: boolean }
	>();
	let viewDigest: string | undefined;
	const receipt = join(dirname(root), "sha256");
	const conflicts = new Set<string>();
	const reserved = new Set(hub?.findSkills().map((skill) => skill.name));
	const assertUnambiguous = (name?: string) => {
		if (
			name === undefined
				? [...reserved].some((name) => conflicts.has(name))
				: conflicts.has(name)
		)
			throw new RuntimeHostError(
				"RUNTIME_SKILL_SOURCE_CONFLICT",
				"RUNTIME_SKILL_SOURCE_CONFLICT",
				409,
			);
	};
	if (folders.length) {
		if ((await realpath(skillsRoot)) !== skillsRoot || folders.length > 150)
			throw unavailable();
		viewDigest = await readFile(receipt, "utf8");
		if (!/^[a-f0-9]{64}$/.test(viewDigest)) throw unavailable();
		const { loadSkills } = await import("@earendil-works/pi-coding-agent");
		const names = new Set<string>();
		for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!folder.isDirectory() || !piSkillFolderName.test(folder.name))
				continue;
			const entry = join(skillsRoot, folder.name, "SKILL.md");
			const stat = await lstat(entry).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw unavailable();
			});
			if (!stat?.isFile()) continue;
			if (
				stat.size > 1_048_576 ||
				stat.nlink !== 1 ||
				(await realpath(entry)) !== entry
			)
				throw unavailable();
			const { skills } = loadSkills({
				cwd: root,
				agentDir: root,
				includeDefaults: false,
				skillPaths: [entry],
			});
			const skill = skills[0];
			if (!skill) continue;
			if (reserved.has(skill.name) || names.has(skill.name))
				conflicts.add(skill.name);
			names.add(skill.name);
			entries.set(folder.name, {
				name: skill.name,
				sha256: digest(await readFile(entry)),
				visible: !skill.disableModelInvocation,
			});
		}
	}
	return {
		folders: [...entries]
			.filter(([, entry]) => entry.visible && !conflicts.has(entry.name))
			.map(([folder]) => folder),
		assertUnambiguous,
		async read(path: string) {
			if (
				!path.startsWith(skillsRoot + sep) ||
				path !== resolve(path) ||
				path.includes("\\") ||
				path.includes("\0")
			)
				throw denied();
			const [folder, ...resource] = path
				.slice(skillsRoot.length + 1)
				.split(sep);
			const entry = entries.get(folder ?? "");
			if (!entry?.visible || !resource.length) throw denied();
			assertUnambiguous(entry.name);
			if (
				(await readFile(receipt, "utf8")) !== viewDigest ||
				(await realpath(path)) !== path
			)
				throw denied();
			const file = await open(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576)
					throw unavailable();
				const bytes = await file.readFile();
				if (
					resource.length === 1 &&
					resource[0] === "SKILL.md" &&
					digest(bytes) !== entry.sha256
				)
					throw unavailable();
				return bytes;
			} finally {
				await file.close();
			}
		},
	};
}

/** Authorize this execution's own read and journal the operation before returning any bytes. */
export function piSessionSkillReader(
	directory: Awaited<ReturnType<typeof openPiDeploymentSkills>>,
	session: Pick<
		NativeSessionOptions,
		"runtimeSessionRef" | "executionId" | "recordOperationFact" | "update"
	>,
	authorize: RuntimeExternalActionAuthorizer,
) {
	return async (path: string) => {
		const { executionId, recordOperationFact } = session;
		if (!executionId || !recordOperationFact) throw denied();
		const fact = {
			kind: "tool" as const,
			operationRef: randomUUID(),
			attemptRef: randomUUID(),
			toolId: "Read",
		};
		await recordOperationFact({ ...fact, phase: "intent" });
		let bytes: Buffer;
		let revalidate: () => void;
		try {
			const grant = await authorize({
				...fact,
				nativeSessionRef: session.runtimeSessionRef,
				executionId,
				runtimeOperationId: executionId,
			});
			if (!grant?.revalidate) throw denied();
			revalidate = grant.revalidate;
			revalidate();
			await recordOperationFact({
				...fact,
				phase: "started",
				startedAt: new Date().toISOString(),
			});
			grant.revalidate();
			bytes = await directory.read(path);
			grant.revalidate();
		} catch {
			await recordOperationFact({
				...fact,
				phase: "failed",
				finishedAt: new Date().toISOString(),
				failureCode: "operation_failed",
			});
			throw denied();
		}
		await recordOperationFact({
			...fact,
			phase: "completed",
			finishedAt: new Date().toISOString(),
		});
		await session.update({
			type: "tool",
			payload: {
				toolCallId: fact.operationRef,
				name: "Read",
				phase: "completed",
			},
		});
		revalidate();
		return bytes;
	};
}
