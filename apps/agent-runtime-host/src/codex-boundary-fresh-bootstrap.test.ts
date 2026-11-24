import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntimeDriver } from "@agent-infra/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRuntimeOAuthProvisioningDirectories } from "./runtime-oauth-provisioning.js";

// #4471 / #3054: the Connection bootstrap runs real directory preparation, then the
// Host opens the real Driver on the same data directory in container-boundary mode.
const emptyMapping = '{"schemaVersion":2,"sessions":{},"operations":{}}\n';
const cleanup: string[] = [];
afterEach(async () => {
	for (const path of cleanup.splice(0))
		await rm(path, { recursive: true, force: true });
});

async function layout() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "boundary-init-")));
	cleanup.push(root);
	const dataDirectory = join(root, "runtime");
	const privateDirectory = join(root, "private");
	for (const path of [dataDirectory, privateDirectory])
		await mkdir(path, { mode: 0o700 });
	const statePath = join(dataDirectory, "codex-driver.json");
	return {
		dataDirectory,
		privateDirectory,
		statePath,
		nativeRoot: `${statePath}.native`,
		prepare: () =>
			prepareRuntimeOAuthProvisioningDirectories({
				dataDirectory,
				privateDirectory,
			}),
		// An unknown native lane is refused right after the state check, so the
		// outcome distinguishes "state accepted" from RUNTIME_CODEX_STATE_INVALID
		// without spawning a native process.
		open: () =>
			CodexRuntimeDriver.open({
				path: statePath,
				isolationMode: "container-boundary",
				nativeLane: "unknown",
			} as never),
	};
}

describe("container-boundary fresh Connection bootstrap", () => {
	it("creates the empty Driver mapping before any native skeleton so the real Driver accepts it", async () => {
		const f = await layout();
		await f.prepare();
		await expect(f.open()).rejects.toMatchObject({
			code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
		});
		expect(await readFile(f.statePath, "utf8")).toBe(emptyMapping);
		const info = await lstat(f.statePath);
		expect(info.isFile()).toBe(true);
		expect(info.mode & 0o777).toBe(0o600);
		expect((await lstat(f.nativeRoot)).isDirectory()).toBe(true);
	});

	it("also passes with the nested TLS mount target and after a repeated bootstrap", async () => {
		const f = await layout();
		await f.prepare();
		await expect(f.open()).rejects.toMatchObject({
			code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
		});
		const first = await lstat(f.statePath);
		await mkdir(
			join(f.nativeRoot, "conversations", "standard-mcp-oauth", "tls"),
			{ mode: 0o700 },
		);
		await f.prepare();
		const second = await lstat(f.statePath);
		expect([second.ino, second.dev]).toEqual([first.ino, first.dev]);
		expect(await readFile(f.statePath, "utf8")).toBe(emptyMapping);
		await expect(f.open()).rejects.toMatchObject({
			code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
		});
	});

	it("never rewrites an existing mapping", async () => {
		const f = await layout();
		const existing =
			'{"schemaVersion":2,"sessions":{},"operations":{},"retained":true}\n';
		await writeFile(f.statePath, existing, { mode: 0o600 });
		await f.prepare();
		expect(await readFile(f.statePath, "utf8")).toBe(existing);
	});

	it("keeps refusing a lost mapping next to surviving native business state", async () => {
		const f = await layout();
		const workspace = join(f.nativeRoot, "conversations", "key", "workspace");
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		await writeFile(join(workspace, "notes.txt"), "surviving business file");
		await f.prepare();
		await expect(lstat(f.statePath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(f.open()).rejects.toMatchObject({
			code: "RUNTIME_CODEX_STATE_INVALID",
		});
	});

	it("does not treat an empty native skeleton as a fresh Session", async () => {
		const f = await layout();
		await mkdir(f.nativeRoot, { mode: 0o700 });
		await f.prepare();
		await expect(lstat(f.statePath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(f.open()).rejects.toMatchObject({
			code: "RUNTIME_CODEX_STATE_INVALID",
		});
	});

	it("rejects a symbolic link or non-file at the mapping path without following it", async () => {
		const f = await layout();
		const target = join(f.dataDirectory, "elsewhere.json");
		await writeFile(target, emptyMapping, { mode: 0o600 });
		await symlink(target, f.statePath);
		await expect(f.prepare()).rejects.toThrow();
		expect(await readFile(target, "utf8")).toBe(emptyMapping);
		await rm(f.statePath);
		await symlink(join(f.dataDirectory, "missing.json"), f.statePath);
		await expect(f.prepare()).rejects.toThrow();
		await expect(
			lstat(join(f.dataDirectory, "missing.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await rm(f.statePath);
		await mkdir(f.statePath, { mode: 0o700 });
		await expect(f.prepare()).rejects.toThrow();
	});

	it("creates the mapping exactly once under concurrent bootstrap", async () => {
		const f = await layout();
		await Promise.all([f.prepare(), f.prepare(), f.prepare()]);
		expect(await readFile(f.statePath, "utf8")).toBe(emptyMapping);
		expect((await lstat(f.statePath)).mode & 0o777).toBe(0o600);
		expect(constants.O_EXCL).toBeGreaterThan(0);
	});
});
