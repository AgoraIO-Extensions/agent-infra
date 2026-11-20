import { createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CodexSessionExecutorBindingV1,
	codexSessionExecutorBindingDigestV1,
	executorIdentityFileRootV1,
	executorIdentityFileV1,
	executorIdentityInputRootV1,
	verifyExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import { protectExecutorIdentityProcessV1 } from "./executor-identity-process.js";
import { assertRuntimeProcessProtection } from "./process-protection.js";

type Role = "host" | "runner";
type Environment = Readonly<Record<string, string | undefined>>;

function invalid(): never {
	throw new Error("CODEX_EXECUTOR_START_IDENTITY_INVALID");
}

async function readMaterial(path: string, consume: boolean) {
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = await file.stat();
		if (
			!info.isFile() ||
			info.size < 1 ||
			info.size > 16_384 ||
			(consume &&
				(info.uid !== process.getuid?.() ||
					(info.mode & 0o777) !== 0o400 ||
					info.nlink !== 1))
		)
			return invalid();
		if (consume) await unlink(path);
		return await file.readFile();
	} finally {
		await file.close();
	}
}

function verifyMaterial(
	document: Buffer,
	role: Role,
	binding: CodexSessionExecutorBindingV1,
	environment: Environment,
) {
	try {
		const podUid = environment.AGENT_INFRA_RUNTIME_POD_UID;
		const startupRef = environment.AGENT_INFRA_EXECUTOR_STARTUP_REF;
		const issuer = environment.AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY;
		if (!podUid || !startupRef || !issuer) return invalid();
		return verifyExecutorStartIdentityV1(
			JSON.parse(document.toString("utf8")),
			{
				podUid,
				bindingDigest: codexSessionExecutorBindingDigestV1(binding),
				startupRef,
				expiresAt: Number(environment.AGENT_INFRA_EXECUTOR_STARTUP_DEADLINE),
				role,
				instanceBinding: {
					sandboxId: binding.sandboxId,
					generation: binding.sessionGeneration,
					resourceFence: binding.resourceFence,
				},
				now: Date.now(),
				issuerKey: createPublicKey(issuer),
			},
		);
	} catch {
		return invalid();
	}
}

export async function stageExecutorIdentitiesV1(
	binding: CodexSessionExecutorBindingV1,
	environment: Environment,
) {
	assertRuntimeProcessProtection();
	protectExecutorIdentityProcessV1();
	for (const role of ["host", "runner"] as const) {
		const document = await readMaterial(
			join(executorIdentityInputRootV1, role),
			false,
		);
		try {
			verifyMaterial(document, role, binding, environment);
			await writeFile(
				join(executorIdentityFileRootV1, role, executorIdentityFileV1),
				document,
				{
					flag: "wx",
					mode: 0o400,
				},
			);
		} finally {
			document.fill(0);
		}
	}
}

export async function consumeExecutorIdentityV1(
	role: Role,
	binding: CodexSessionExecutorBindingV1,
	environment: Environment,
) {
	assertRuntimeProcessProtection();
	protectExecutorIdentityProcessV1();
	const document = await readMaterial(
		join(executorIdentityFileRootV1, executorIdentityFileV1),
		true,
	);
	try {
		return verifyMaterial(document, role, binding, environment);
	} finally {
		document.fill(0);
	}
}
