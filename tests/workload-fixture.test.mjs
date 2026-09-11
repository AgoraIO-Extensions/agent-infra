import assert from "node:assert/strict";
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeWorkloadMarker } from "./fixtures/workload/server.mjs";

async function workspace(t) {
	const directory = await mkdtemp(join(tmpdir(), "workload-fixture-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("initializes after abandoned partial writes and concurrent starts", async (t) => {
	const directory = await workspace(t);
	const marker = join(directory, "marker");
	await writeFile(`${marker}.interrupted.tmp`, "ret");
	await Promise.all(
		Array.from({ length: 8 }, () => initializeWorkloadMarker(marker)),
	);
	assert.equal(await readFile(marker, "utf8"), "retained");
	assert.equal(await readFile(`${marker}.interrupted.tmp`, "utf8"), "ret");
	assert.deepEqual((await readdir(directory)).sort(), [
		"marker",
		"marker.interrupted.tmp",
	]);
	const inode = (await stat(marker)).ino;
	await initializeWorkloadMarker(marker);
	assert.equal((await stat(marker)).ino, inode);
});

test("valid marker restart does not require a writable directory", {
	skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
	const directory = await workspace(t);
	const marker = join(directory, "marker");
	await initializeWorkloadMarker(marker);
	await chmod(directory, 0o500);
	try {
		await initializeWorkloadMarker(marker);
		assert.equal(await readFile(marker, "utf8"), "retained");
	} finally {
		await chmod(directory, 0o700);
	}
});

test("restart rejects existing incomplete or changed data without repairing it", async (t) => {
	for (const contents of ["", "ret", "changed"]) {
		const directory = await workspace(t);
		const marker = join(directory, "marker");
		await writeFile(marker, contents);
		const inode = (await stat(marker)).ino;
		await assert.rejects(
			initializeWorkloadMarker(marker),
			/Invalid workload fixture marker/,
		);
		assert.equal(await readFile(marker, "utf8"), contents);
		assert.equal((await stat(marker)).ino, inode);
		assert.deepEqual(await readdir(directory), ["marker"]);
	}
});
