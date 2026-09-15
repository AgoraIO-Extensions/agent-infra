import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluate, sha256, validateDatabase, validateReport } from "../../.github/scripts/vulnerability-policy.mjs";
import { approvedExceptions, scanImages, source } from "../../.github/scripts/vulnerability-scan.mjs";
import { runCommand } from "./run-command.mjs";

const root = resolve(import.meta.dirname, "../..");
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function docker(args, name, timeoutMs = 60_000) {
	return runCommand(process.env.DOCKER_BIN ?? "docker", args, {
		cwd: root, name, timeoutMs,
	});
}

function inspect(image) {
	return JSON.parse(docker(["image", "inspect", "--format", "{{json .}}", image], "Custom Base Image inspection"));
}

async function configDigest(image) {
	const temp = await mkdtemp(join(tmpdir(), "agent-infra-image-config-"));
	try {
		const archive = join(temp, "image.tar");
		docker(["image", "save", "--output", archive, image], "Custom Base Image config export", 5 * 60_000);
		const tar = process.env.TAR_BIN ?? "tar";
		const options = { cwd: root, name: "Custom Base Image config readback", timeoutMs: 60_000 };
		const manifests = JSON.parse(runCommand(tar, ["-xOf", archive, "manifest.json"], options));
		assert.equal(manifests.length, 1);
		const config = manifests[0].Config;
		assert.match(config, /^(?:blobs\/sha256\/[a-f0-9]{64}|[a-f0-9]{64}\.json)$/);
		runCommand(tar, ["-xf", archive, "-C", temp, config], options);
		return `sha256:${sha256(await readFile(join(temp, config)))}`;
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

export async function scanCustomBaseImage(image, reportDirectory) {
	const expected = await source();
	const actual = inspect(image);
	const target = {
		name: "custom-agent-base",
		imageId: actual.Id,
		diffIds: actual.RootFS.Layers,
		os: actual.Os,
		architecture: actual.Architecture,
	};
	const bundle = await scanImages({ expected, images: [target], reportDirectory });
	assert.deepEqual(bundle.errors, [], "Custom Base Image scan failed");
	const report = bundle.reports[0];
	assert.equal(report.exitCode, 0);
	const bytes = await readFile(join(reportDirectory, report.file));
	assert.equal(sha256(bytes), report.sha256);
	const exceptions = await approvedExceptions();
	validateDatabase(bundle.database);
	const findings = evaluate(validateReport(JSON.parse(bytes), target, expected), exceptions);
	const blocked = findings.filter((finding) => finding.blocked).length;
	const verdict = { passed: blocked === 0, blocked, source: expected, exceptions, findings };
	await writeFile(join(reportDirectory, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
	assert.equal(blocked, 0, "Custom Base Image has blocking vulnerabilities");
	return { scanner: bundle.scanner, database: bundle.database, reportSha256: report.sha256, imageId: actual.Id, blocked };
}

export async function verifyCustomBaseImage(image, { published = false, contextPath = root } = {}) {
	let remote;
	if (published) {
		const digest = image.split("@")[1];
		assert.match(digest, digestPattern, "published Base Image must use an immutable Digest");
		const bytes = docker(["buildx", "imagetools", "inspect", "--raw", image], "Published Base Image manifest readback");
		// runCommand trims its output; OCI manifests contain no surrounding whitespace.
		assert.equal(`sha256:${sha256(bytes)}`, digest, "published manifest content differs from Digest");
		remote = JSON.parse(bytes);
		assert.match(remote.config?.digest, digestPattern);
		docker(["pull", image], "Published Base Image pull", 5 * 60_000);
	}
	const actual = inspect(image);
	if (remote) assert.equal(await configDigest(image),
		remote.config.digest, "pulled config differs from published manifest");
	assert.equal(actual.Config.User, "node");
	assert.equal(actual.Config.WorkingDir, "/workspace");
	assert.deepEqual(actual.Config.ExposedPorts ?? {}, {});
	assert.equal(actual.Config.Labels?.["io.agora.agent.runtime.manifest"], undefined);
	assert.deepEqual((actual.Config.Env ?? []).map((entry) => entry.split("=", 1)[0]).sort(),
		["NODE_VERSION", "PATH", "YARN_VERSION"], "Base Image must contain only upstream Node environment variables");
	const fixture = join(contextPath, "tests/fixtures/custom-base-image");
	const platform = `${actual.Os}/${actual.Architecture}`;
	const options = [
		"run", "--rm", "--pull=never", "--network=none", "--read-only",
		"--platform", platform,
		"--cap-drop=ALL", "--security-opt=no-new-privileges",
		"--tmpfs", "/tmp:rw,size=16m,mode=1777",
		"--tmpfs", "/workspace:rw,size=16m,uid=1000,gid=1000,mode=0700",
	];
	const baseProbe = JSON.parse(docker([
		...options, "--mount", `type=bind,src=${join(fixture, "probe.mjs")},dst=/probe.mjs,readonly`,
		image, "node", "/probe.mjs",
	], "Custom Base Image read-only probe"));
	assert.equal(baseProbe.status, "passed");
	const temp = await mkdtemp(join(tmpdir(), "agent-infra-custom-base-"));
	const childReference = `agent-infra-verification/custom-base-child:${basename(temp).toLowerCase()}`;
	let childLoaded = false;
	try {
		const metadataPath = join(temp, "child.json");
		docker([
			"buildx", "build", "--load", "--provenance=false", "--sbom=false",
			"--platform", platform,
			"--tag", childReference,
			"--build-arg", `BASE_IMAGE=${image}`, "--metadata-file", metadataPath,
			"--file", join(fixture, "Dockerfile"), fixture,
		], "Custom Base Image downstream build", 5 * 60_000);
		childLoaded = true;
		const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
		const exportedDigest = metadata["containerimage.digest"];
		const childConfigDigest = metadata["containerimage.config.digest"];
		const child = inspect(childReference);
		assert.equal(`${child.Os}/${child.Architecture}`, platform, "child platform differs from Base Image");
		const childImageId = child.Id;
		assert.match(exportedDigest, digestPattern);
		assert.match(childConfigDigest, digestPattern);
		assert.match(childImageId, digestPattern);
		if (child.Descriptor) assert.equal(child.Descriptor.digest, exportedDigest);
		assert.equal(await configDigest(childReference), childConfigDigest);
		// Classic Docker's load exporter reports the config ID instead of a manifest Digest.
		const childDigest = exportedDigest === childConfigDigest ? null : exportedDigest;
		assert.ok(!published || childDigest, "published acceptance requires a child manifest Digest; use OCI-capable Docker storage");
		const childProbe = JSON.parse(docker([...options, childReference], "Custom Base Image downstream run"));
		assert.equal(childProbe.status, "passed");
		assert.equal(inspect(image).Id, actual.Id, "Base Image changed during verification");
		return {
			schemaVersion: 1,
			sourceSha: actual.Config.Labels?.["org.opencontainers.image.revision"] ?? null,
			baseImage: image,
			baseImageId: actual.Id,
			baseDigest: published ? image.split("@")[1] : null,
			platform,
			childDigest, childImageId, childConfigDigest, baseProbe, childProbe,
		};
	} finally {
		try {
			if (childLoaded) docker(["image", "rm", childReference], "Custom Base Image downstream cleanup");
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const [image, reportPath, flag, ...extra] = process.argv.slice(2);
		assert.ok(image && reportPath && (!flag || flag === "--published") && extra.length === 0,
			"usage: custom-base-image.mjs <image> <report.json> [--published]");
		const report = await verifyCustomBaseImage(image, { published: flag === "--published" });
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
		console.info("Custom Base Image and downstream verification passed");
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
