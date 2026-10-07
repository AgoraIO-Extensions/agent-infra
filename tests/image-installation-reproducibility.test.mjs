import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { imageDockerfiles } from "../deploy/release/image-manifest.mjs";
import { runCommand } from "../deploy/release/run-command.mjs";

const root = resolve(import.meta.dirname, "..");
// These uncached root tests execute before the workspace Turborepo tasks.
const {
	IMAGE_RELEASE_TEST_DOCKER_CONTEXT: context,
	IMAGE_RELEASE_TEST_IMAGES: imageSelection,
	IMAGE_RELEASE_TEST_BUILD_PROXY: buildProxy,
	PLATFORM: platform = "linux/amd64",
} = process.env;
const names = imageSelection?.split(",") ?? [
	"agent-runtime-host",
	"platform-api",
	"platform-worker",
	"enterprise-directory-sync",
	"web",
	"custom-agent-base",
];

for (const name of names) {
	test(`${name} production installation produces identical OCI Digests`, {
		skip: !context,
	}, async () => {
		assert.ok(
			Object.hasOwn(imageDockerfiles, name) && name !== "connection-api",
		);
		const source = await readFile(join(root, imageDockerfiles[name]), "utf8");
		const stage = name === "agent-runtime-host" ? "runtime" : "runner";
		const match =
			name === "custom-agent-base"
				? /^FROM (\S+)\n([\s\S]*)$/.exec(source)
				: new RegExp(`^FROM (\\S+) AS ${stage}\\n([\\s\\S]*)`, "m").exec(
						source,
					);
		assert.ok(match, "production stage is missing");
		const installation = /^RUN ((?:[^\n]*\\\n)*[^\n]*)/m.exec(match[2]);
		assert.ok(installation, "production installation is missing");
		const directory = await mkdtemp(
			join(tmpdir(), "agent-infra-installation-repro-"),
		);
		try {
			const dockerfile = join(directory, "Dockerfile");
			await writeFile(dockerfile, `FROM ${match[1]}\nRUN ${installation[1]}\n`);
			const digests = [];
			for (const pass of [1, 2]) {
				const metadata = join(directory, `${pass}.json`);
				runCommand(
					"docker",
					[
						"--context",
						context,
						"buildx",
						"build",
						"--platform",
						platform,
						"--file",
						dockerfile,
						"--no-cache",
						"--provenance=false",
						"--sbom=false",
						"--build-arg",
						"SOURCE_DATE_EPOCH=1700000000",
						...(buildProxy
							? [
									"--build-arg",
									`HTTP_PROXY=${buildProxy}`,
									"--build-arg",
									`HTTPS_PROXY=${buildProxy}`,
								]
							: []),
						"--tag",
						`agent-infra-installation-repro/${name}:test`,
						"--output",
						`type=oci,dest=${directory}/${pass}.tar,rewrite-timestamp=true`,
						"--metadata-file",
						metadata,
						"--progress=quiet",
						directory,
					],
					{
						cwd: root,
						name: `${name} installation build ${pass}`,
						timeoutMs: 5 * 60_000,
					},
				);
				const digest = JSON.parse(await readFile(metadata, "utf8"))[
					"containerimage.digest"
				];
				assert.match(digest, /^sha256:[a-f0-9]{64}$/);
				digests.push(digest);
			}
			assert.equal(
				digests[0],
				digests[1],
				`${name} production installation is not reproducible`,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
