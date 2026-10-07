import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

import { imageDockerfiles, imageNames, sha256 } from "./image-manifest.mjs";

const root = resolve(import.meta.dirname, "../..");
const directory = join(root, ".ci-images");

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`${binary} ${args[0]} failed (exit ${result.status ?? "unavailable"})`);
  return result.stdout?.trim();
}

export function validateDeploymentImageCoverage(tracked) {
  assert.deepEqual(
    tracked.filter((path) => /^(?:apps\/[^/]+|deploy\/images\/[^/]+)\/Dockerfile$/.test(path)).sort(),
    Object.values(imageDockerfiles).sort(),
    "deployment image coverage drift",
  );
}

export async function source() {
  const commit = command("git", ["rev-parse", "HEAD"]);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(process.env.SOURCE_COMMIT ?? commit, commit, "checkout is not expected commit");
  const lock = await readFile(join(root, "pnpm-lock.yaml"));
  const committedLock = `${command("git", ["show", `${commit}:pnpm-lock.yaml`])}\n`;
  assert.equal(sha256(lock), sha256(committedLock), "lockfile differs from commit");
  const tracked = command("git", ["ls-tree", "-r", "--name-only", commit]).split("\n");
  const workspaces = tracked
    .filter((path) => /^(?:package.json|(?:apps|packages)\/[^/]+\/package.json)$/.test(path))
    .map((path) => (path === "package.json" ? "." : path.slice(0, -13)))
    .sort();
  const parsed = parse(lock.toString());
  assert.equal(parsed.lockfileVersion, "9.0");
  assert.deepEqual(Object.keys(parsed.importers).sort(), workspaces, "workspace coverage drift");
  validateDeploymentImageCoverage(tracked);
  return {
    commit,
    lockfileSha256: sha256(lock),
    runId: process.env.GITHUB_RUN_ID ?? "local",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
    workspaces,
  };
}

async function build() {
  const expected = await source();
  await mkdir(directory, { recursive: true });
  await rm(join(directory, "build.json"), { force: true });
  const temp = await mkdtemp(join(tmpdir(), "agent-infra-image-build-"));
  const manifest = { schemaVersion: 1, source: expected, images: [] };
  await writeFile(join(directory, "build.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    const archive = join(temp, "source.tar");
    const context = join(temp, "context");
    await mkdir(context);
    command("git", ["archive", "--format=tar", `--output=${archive}`, expected.commit]);
    command("tar", ["-xf", archive, "-C", context]);
    for (const name of imageNames) {
      const iid = join(temp, `${name}.id`);
      command("docker", [
        "build",
        "--file",
        join(context, imageDockerfiles[name]),
        "--build-arg",
        `SOURCE_COMMIT=${expected.commit}`,
        "--iidfile",
        iid,
        "--label",
        `org.opencontainers.image.revision=${expected.commit}`,
        "--label",
        `agent-infra.lockfile-sha256=${expected.lockfileSha256}`,
        "--tag",
        `agent-infra-ci/${name}:${expected.commit}`,
        context,
      ], { stdio: "inherit" });
      const imageId = (await readFile(iid, "utf8")).trim();
      assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
      const [image] = JSON.parse(command("docker", ["image", "inspect", imageId]));
      assert.equal(image.Id, imageId);
      assert.equal(image.Config.Labels["org.opencontainers.image.revision"], expected.commit);
      assert.equal(image.Config.Labels["agent-infra.lockfile-sha256"], expected.lockfileSha256);
      manifest.images.push({
        name,
        imageId,
        diffIds: image.RootFS.Layers,
        os: image.Os,
        architecture: image.Architecture,
      });
      await writeFile(join(directory, "build.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    assert.deepEqual(await source(), expected);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv[2], "build", "usage: ci-image-build.mjs build");
    await build();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "image build failed");
    process.exitCode = 1;
  }
}
