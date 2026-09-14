import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
export interface NativeProcessLaunch {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	close?: () => Promise<void>;
	reusable?: () => boolean;
}
type OwnerVariable = "AGENT_INFRA_ACP_OWNER" | "AGENT_INFRA_PI_OWNER";

import { DurableJsonFile } from "./durable-json.js";

interface Owner {
	pid: number;
	token: string;
}
const unavailable = () => new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");

function groupExists(pid: number) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw unavailable();
	}
}

async function ownerFile(directory: string) {
	const path = join(directory, "process.json");
	try {
		if (!(await lstat(path)).isFile()) throw unavailable();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
	}
	return DurableJsonFile.open<{ owner?: Owner }>(path, {});
}

async function retire(
	file: DurableJsonFile<{ owner?: Owner }>,
	ownerVariable: OwnerVariable,
) {
	const owner = file.read().owner;
	if (!owner) return;
	if (
		!Number.isSafeInteger(owner.pid) ||
		owner.pid < 2 ||
		!/^[a-f0-9-]{36}$/.test(owner.token)
	)
		throw unavailable();
	if (groupExists(owner.pid)) {
		// Verify an unguessable launch token before signaling a persisted PID. Never kill a reused PID.
		let environment: string;
		try {
			environment =
				process.platform === "linux"
					? (await readFile(`/proc/${owner.pid}/environ`, "utf8")).replaceAll(
							"\0",
							" ",
						)
					: (
							await promisify(execFile)(
								"/bin/ps",
								["eww", "-p", String(owner.pid), "-o", "command="],
								{ timeout: 3000, maxBuffer: 2_097_152 },
							)
						).stdout;
		} catch {
			throw unavailable();
		}
		if (
			!new RegExp(`(?:^|\\s)${ownerVariable}=${owner.token}(?:\\s|$)`).test(
				environment,
			)
		)
			throw unavailable();
		try {
			process.kill(-owner.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH")
				throw unavailable();
		}
		for (let attempt = 0; attempt < 80 && groupExists(owner.pid); attempt++)
			await delay(25);
		if (groupExists(owner.pid)) throw unavailable();
	}
	await file.update((state) => {
		delete state.owner;
	});
}

export async function retireNativeProcess(
	directory: string,
	ownerVariable: OwnerVariable,
) {
	await retire(await ownerFile(directory), ownerVariable);
}

/** One owned process group per native Session; persist ownership before sending any native request. */
export async function spawnNativeProcess(
	directory: string,
	cwd: string,
	launch: NativeProcessLaunch,
	ownerVariable: OwnerVariable,
) {
	const file = await ownerFile(directory);
	await retire(file, ownerVariable);
	const token = randomUUID();
	const child = spawn(launch.command, launch.args, {
		cwd,
		env: { ...launch.env, [ownerVariable]: token },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
		shell: false,
	});
	child.stderr.resume();
	child.on("error", () => {});
	const exited = new Promise<void>((resolve) => child.once("close", resolve));
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH")
						throw unavailable();
				}
			}
			await exited;
			if (child.pid && groupExists(child.pid)) throw unavailable();
			await file.update((state) => {
				delete state.owner;
			});
		})();
		return closing;
	};
	try {
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", () => reject(unavailable()));
		});
		const pid = child.pid;
		if (!pid) throw unavailable();
		await file.update((state) => {
			state.owner = { pid, token };
		});
		return { child, close, exited };
	} catch {
		await close();
		throw unavailable();
	}
}
