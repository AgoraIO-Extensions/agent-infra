import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Installation-only acceptance: no native process, provider, Turn or Connection.
const [
	imageId,
	testImageId,
	sourceRevision,
	configVersion,
	output,
	sessionId,
	...extra
] = process.argv.slice(2);
assert(imageId && /^sha256:[a-f0-9]{64}$/.test(imageId));
assert(testImageId && /^sha256:[a-f0-9]{64}$/.test(testImageId));
assert(sourceRevision && /^[a-f0-9]{40}$/.test(sourceRevision));
assert(
	configVersion && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configVersion),
);
assert(output && extra.length === 0);
assert(sessionId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId));
const source = execFileSync("git", ["rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();
assert.equal(sourceRevision, source);
assert.equal(
	execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
	"",
);
const command = (args: string[]) =>
	execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });
const inspect = (id: string) => {
	const value = JSON.parse(
		command(["image", "inspect", id, "--format", "{{json .}}"]),
	);
	assert.equal(value.Id, id);
	assert.equal(
		value.Config.Labels["org.opencontainers.image.revision"],
		sourceRevision,
	);
	assert.equal(value.Config.User, "node");
	return value;
};
const inspection = inspect(imageId);
const testInspection = inspect(testImageId);
assert.equal(
	testInspection.Config.Labels["org.agora.agent-infra.runtime-stage"],
	"installed-skill-test",
);
// The same source/installation is read in both stages, including official files.
const inventorySource = `
const readInstalledInventory = async () => {
  const inventory = [];
  for (const name of (await readdir("/opt/codex", {recursive:true})).sort()) {
    const path = "/opt/codex/" + name;
    const stat = await lstat(path);
    assert(!stat.isSymbolicLink());
    assert(stat.isFile() || stat.isDirectory());
    // Directory nlink differs across COPY/overlay layers despite identical trees.
    // Regular-file nlink is security-relevant and must reject every hardlink.
    if (stat.isFile()) assert.equal(stat.nlink, 1);
    inventory.push({path:name, kind:stat.isFile() ? "file" : "directory", uid:stat.uid, gid:stat.gid, mode:stat.mode & 0o7777,
      ...(stat.isFile() ? {nlink:stat.nlink, sizeBytes:stat.size, sha256:hash(await readFile(path))} : {})});
  }
  return inventory;
};
`;
const run = (stage: string, id: string, argv: string[]) => {
	const attempt = randomUUID();
	const name = `runtime-installed-skill-${sessionId}-${stage}-${attempt}`;
	try {
		return JSON.parse(
			command([
				"run",
				"--rm",
				"--pull=never",
				"--network=none",
				"--cap-drop=ALL",
				"--name",
				name,
				"--security-opt=no-new-privileges",
				"--label",
				`ao.session=${sessionId}`,
				"--label",
				`agent-infra.installation-stage=${stage}`,
				"--label",
				`agent-infra.installation-attempt=${attempt}`,
				"--entrypoint",
				"node",
				id,
				...argv,
			]),
		);
	} finally {
		const remaining = spawnSync(
			"docker",
			["container", "inspect", name, "--format", "{{json .}}"],
			{ encoding: "utf8", timeout: 10_000 },
		);
		if (remaining.status === 0) {
			const container = JSON.parse(remaining.stdout);
			assert.equal(container.Config.Labels["ao.session"], sessionId);
			assert.equal(
				container.Config.Labels["agent-infra.installation-stage"],
				stage,
			);
			assert.equal(
				container.Config.Labels["agent-infra.installation-attempt"],
				attempt,
			);
			command(["container", "rm", "--force", "--volumes", container.Id]);
		} else {
			assert(
				!remaining.error &&
					remaining.status === 1 &&
					remaining.stderr.includes("No such"),
				"Installation container cleanup could not be verified",
			);
		}
	}
};

const script = `
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {lstat, readdir, readFile, writeFile, unlink, rename} from "node:fs/promises";
import {verifyCodexPilotInstallation} from "@agent-infra/agent-runtime";
assert.equal(process.getuid(), 1000);
assert.equal(process.env.AGENT_INFRA_RUNTIME_INSTALLED_SKILL, "workspace-summary-v1");
const root = "/opt/codex/agent-infra-skills";
const packageRoot = root + "/workspace-summary";
const manifestPath = root + "/workspace-summary.manifest.json";
const buildPath = "/opt/codex/share/workspace-summary-build.json";
const entryPath = packageRoot + "/SKILL.md";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = await readFile(manifestPath);
const manifest = JSON.parse(bytes);
const entry = await readFile(entryPath);
const inventory = JSON.stringify({domain:"agent-infra.skill-package.v1", files:[["SKILL.md",entry.length,hash(entry)]]}) + "\\n";
assert.deepEqual((await readdir(root)).sort(), ["workspace-summary", "workspace-summary.manifest.json"]);
assert.deepEqual(await readdir(packageRoot), ["SKILL.md"]);
assert.deepEqual(manifest.files, [{path:"SKILL.md", sizeBytes:entry.length, sha256:hash(entry)}]);
assert.equal(manifest.packageDigest.sha256, hash(inventory));
const build = JSON.parse(await readFile(buildPath));
assert.deepEqual(build, {schemaVersion:1, sourceRevision:process.argv[1], manifestSha256:hash(bytes), packageSha256:hash(inventory)});
const modes = [];
for (const path of ["/", "/opt", "/opt/codex", "/opt/codex/share", root, packageRoot, entryPath, manifestPath, buildPath]) {
  const stat = await lstat(path);
  assert.equal(stat.uid, 0); assert.equal(stat.gid, 0);
  assert(!stat.isSymbolicLink());
  if (stat.isFile()) { assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o7777, 0o444); }
  else { assert(stat.isDirectory()); assert.equal(stat.mode & 0o7022, 0); if (!["/","/opt"].includes(path)) assert.equal(stat.mode & 0o7777, 0o555); }
  modes.push({path, uid:stat.uid, gid:stat.gid, mode:stat.mode & 0o7777, nlink:stat.nlink});
}
${inventorySource}
const installedInventory = await readInstalledInventory();
const denied = [];
const reject = async (operation, action) => {
  try { await action(); } catch (error) { assert(["EACCES", "EROFS"].includes(error.code)); denied.push(operation); return; }
  throw new Error("RUNTIME_INSTALLED_SKILL_WRITE_ACCEPTED");
};
for (const path of [entryPath, manifestPath, buildPath]) {
  await reject("write:"+path, () => writeFile(path, "unapproved"));
  await reject("delete:"+path, () => unlink(path));
  await reject("replace:"+path, () => rename(path, path+".replacement"));
}
await reject("package-parent-replace", () => rename(packageRoot, root+"/replacement"));
await reject("resource-parent-replace", () => rename(root, "/opt/codex/replacement"));
const provenance = await verifyCodexPilotInstallation("workspace-summary-v1");
assert.equal(provenance.codexVersion, manifest.runtime.version);
assert.equal(provenance.upstreamCommit, manifest.runtime.upstreamCommit);
console.log(JSON.stringify({status:"passed", uid:process.getuid(), manifest, manifestSha256:hash(bytes), entrySha256:hash(entry), packageSha256:hash(inventory), build, provenance, modes, denied, installedInventory}));
`;
// A writable overlay proves UNIX ownership/mode rejects writes; --read-only is
// deliberately absent. The disposable container has no network or business mount.
const result = run("runner", imageId, [
	"--input-type=module",
	"-e",
	script,
	sourceRevision,
]);
const validatorScript = `
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {lstat, readdir, readFile} from "node:fs/promises";
import {readCodexInstalledSkillDeployment} from "/app/apps/agent-runtime-host/src/configuration.ts";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(process.getuid(),1000);
${inventorySource}
const descriptor = await readCodexInstalledSkillDeployment(process.env, process.argv[2]);
assert(descriptor);
assert.equal(descriptor.deployment.configVersion, process.argv[2]);
assert.equal(descriptor.deployment.imageSourceRevision, process.argv[1]);
assert(Object.isFrozen(descriptor) && Object.isFrozen(descriptor.manifest.files[0]) && Object.isFrozen(descriptor.deployment));
const sourceHashes = {};
for (const path of ["apps/agent-runtime-host/src/configuration.ts", "apps/agent-runtime-host/src/installed-skill.ts", "apps/agent-runtime-host/src/index.ts", "packages/agent-runtime/src/codex-installation.ts", "packages/agent-runtime/src/codex-runtime-driver.ts"]) {
  sourceHashes[path] = hash(await readFile("/app/"+path));
}
console.log(JSON.stringify({descriptor, sourceHashes, installedInventory:await readInstalledInventory()}));
`;
const validation = run("installed-skill-test", testImageId, [
	"--import",
	"/app/apps/agent-runtime-host/node_modules/tsx/dist/loader.mjs",
	"--input-type=module",
	"-e",
	validatorScript,
	sourceRevision,
	configVersion,
]);
assert.deepEqual(validation.installedInventory, result.installedInventory);
assert.deepEqual(validation.descriptor.manifest, result.manifest);
assert.equal(validation.descriptor.manifestSha256, result.manifestSha256);
assert.equal(validation.descriptor.deployment.configVersion, configVersion);
assert.equal(
	validation.descriptor.deployment.imageSourceRevision,
	sourceRevision,
);
for (const [path, digest] of Object.entries(validation.sourceHashes)) {
	assert.equal(
		digest,
		createHash("sha256")
			.update(await readFile(path))
			.digest("hex"),
	);
}
const manifestBytes = await readFile(
	new URL(
		"../deploy/runtime/skills/workspace-summary.manifest.json",
		import.meta.url,
	),
);
const entryBytes = await readFile(
	new URL(
		"../deploy/runtime/skills/workspace-summary/SKILL.md",
		import.meta.url,
	),
);
const hash = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
assert.equal(result.manifestSha256, hash(manifestBytes));
assert.equal(result.entrySha256, hash(entryBytes));
assert.equal(result.build.sourceRevision, sourceRevision);
assert.equal(result.denied.length, 11);
await writeFile(
	output,
	`${JSON.stringify(
		{
			schemaVersion: 1,
			boundary:
				"installation and same-source validator only; configVersion is controlled deployment input, not native loading proof",
			sourceRevision,
			configVersion,
			imageId,
			imageDigest: inspection.Descriptor?.digest ?? null,
			repoDigests: inspection.RepoDigests,
			installation: result,
			validator: validation,
			testImageId,
			testImageDigest: testInspection.Descriptor?.digest ?? null,
			testRepoDigests: testInspection.RepoDigests,
		},
		null,
		2,
	)}\n`,
);
