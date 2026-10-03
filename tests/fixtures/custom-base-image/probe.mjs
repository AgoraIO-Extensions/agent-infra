import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";

assert.match(process.version, /^v24\./);
assert.notEqual(process.getuid(), 0);
await assert.rejects(writeFile("/home/node/readonly-probe", "denied"), {
	code: "EROFS",
});
for (const directory of ["/tmp", "/workspace"]) {
	const path = `${directory}/custom-base-probe`;
	await writeFile(path, "custom-base-ok");
	assert.equal(await readFile(path, "utf8"), "custom-base-ok");
	await rm(path);
}
for (const path of [
	"/app",
	"/opt/codex",
	"/opt/opencode",
	"/var/lib/agent-runtime",
]) {
	await assert.rejects(access(path), { code: "ENOENT" });
}
console.log(
	JSON.stringify({
		status: "passed",
		nodeVersion: process.version,
		uid: process.getuid(),
		readOnlyRoot: true,
		writableMounts: ["/tmp", "/workspace"],
	}),
);
