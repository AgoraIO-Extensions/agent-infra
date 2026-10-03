import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import release from "./claude-release.json" with { type: "json" };

export const CLAUDE_NATIVE_PROVENANCE = {
	sdkVersion: release.sdkVersion,
	nativeVersion: release.nativeVersion,
};

/** Verify the exact SDK and executable consumed by each Query before supplying its isolated environment. */
export async function verifyClaudeInstallation() {
	try {
		const require = createRequire(import.meta.url);
		const sdkPath = require.resolve("@anthropic-ai/claude-agent-sdk");
		const sdkRequire = createRequire(sdkPath);
		const { header } = process.report.getReport() as {
			header: { glibcVersionRuntime?: string };
		};
		const target = `${process.platform}-${process.arch}${process.platform === "linux" && !header.glibcVersionRuntime ? "-musl" : ""}`;
		const artifact =
			release.artifacts[target as keyof typeof release.artifacts];
		if (!artifact) throw new Error();
		const executable = sdkRequire.resolve(`${artifact.package}/claude`);
		for (const [path, expected] of [
			...Object.entries(release.sdk).map(([name, hash]) => [
				join(dirname(sdkPath), name),
				hash,
			]),
			[executable, artifact.executableSha256],
		] as [string, string][]) {
			if (
				createHash("sha256")
					.update(await readFile(path))
					.digest("hex") !== expected
			)
				throw new Error();
		}
		return {
			...CLAUDE_NATIVE_PROVENANCE,
			executable,
			executableSha256: artifact.executableSha256,
		};
	} catch {
		throw new Error("RUNTIME_CLAUDE_PROVENANCE_MISMATCH");
	}
}
