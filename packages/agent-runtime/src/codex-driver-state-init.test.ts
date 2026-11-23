import {
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEmptyCodexDriverStateV1 } from "./codex-driver-state-init.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
async function root() {
	const path = await realpath(await mkdtemp(join(tmpdir(), "driver-init-")));
	roots.push(path);
	return path;
}

it("writes the empty schema-2 mapping with 0600 and never replaces an existing path", async () => {
	const directory = await root();
	const path = join(directory, "codex-driver.json");
	await createEmptyCodexDriverStateV1(directory, path);
	expect(await readFile(path, "utf8")).toBe(
		'{"schemaVersion":2,"sessions":{},"operations":{}}\n',
	);
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	await expect(
		createEmptyCodexDriverStateV1(directory, path),
	).rejects.toMatchObject({
		code: "EEXIST",
	});
	const link = join(directory, "link.json");
	await symlink(join(directory, "target.json"), link);
	await expect(
		createEmptyCodexDriverStateV1(directory, link),
	).rejects.toMatchObject({
		code: "EEXIST",
	});
	await expect(stat(join(directory, "target.json"))).rejects.toMatchObject({
		code: "ENOENT",
	});
});
