import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { workspacePathAllowed } from "./workspace-path.js";

const root = "/opt/agent/workspaces";
const mountPath =
	/^\/opt\/agent\/workspaces\/[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

/** Only dedicated read-only mounts count; image directories and nested mounts do not. */
export function workspaceSnapshotMountRoots(mountinfo: string): string[] {
	const mounts = mountinfo
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const fields = line.split(" ");
			return { path: fields[4] ?? "", options: fields[5]?.split(",") ?? [] };
		});
	return mounts
		.filter(
			(mount) =>
				mountPath.test(mount.path) &&
				mount.options.includes("ro") &&
				mounts.filter((other) => other.path === mount.path).length === 1 &&
				!mounts.some((other) => other.path.startsWith(`${mount.path}/`)),
		)
		.map((mount) => mount.path);
}

export async function workspaceSnapshotReadRoots(): Promise<string[]> {
	if (process.platform !== "linux") return [];
	try {
		const metadata = await lstat(root);
		if (
			!metadata.isDirectory() ||
			metadata.uid !== 0 ||
			(metadata.mode & 0o022) !== 0 ||
			(await realpath(root)) !== root
		)
			return [];
		if (
			await access(root, constants.W_OK).then(
				() => true,
				() => false,
			)
		)
			return [];
		const candidates = workspaceSnapshotMountRoots(
			await readFile("/proc/self/mountinfo", "utf8"),
		);
		const roots: string[] = [];
		for (const path of candidates) {
			if ((await realpath(path)) !== path) continue;
			const marker = `${path}/.snapshot-digest`;
			if (!(await workspacePathAllowed(path, path, marker))) continue;
			if (
				!/^sha256:[a-f0-9]{64}$/.test((await readFile(marker, "utf8")).trim())
			)
				continue;
			roots.push(path);
		}
		return roots;
	} catch {
		return [];
	}
}

export async function workspaceSnapshotFileAllowed(
	path: string,
): Promise<boolean> {
	for (const snapshot of await workspaceSnapshotReadRoots()) {
		if (await workspacePathAllowed(snapshot, snapshot, path)) return true;
	}
	return false;
}
