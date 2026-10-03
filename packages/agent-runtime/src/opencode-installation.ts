import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import release from "./opencode-release.json" with { type: "json" };

export const OPENCODE_NATIVE_PROVENANCE = {
	nativeVersion: release.nativeVersion,
	sdkVersion: release.sdkVersion,
	upstreamCommit: release.upstreamCommit,
};

export async function verifyOpenCodeInstallation(executable: string) {
	try {
		const require = createRequire(import.meta.url);
		const sdk = JSON.parse(
			await readFile(
				join(
					dirname(require.resolve("@agentclientprotocol/sdk")),
					"../package.json",
				),
				"utf8",
			),
		);
		if (sdk.version !== release.sdkVersion) throw new Error();
		const { header } = process.report.getReport() as {
			header: { glibcVersionRuntime?: string };
		};
		const target = `${process.platform}-${process.arch}${process.platform === "linux" && !header.glibcVersionRuntime ? "-musl" : ""}`;
		const artifact =
			release.artifacts[target as keyof typeof release.artifacts];
		if (!artifact) throw new Error();
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(executable)) hash.update(chunk);
		if (hash.digest("hex") !== artifact.executableSha256) throw new Error();
		return {
			...OPENCODE_NATIVE_PROVENANCE,
			executable,
			executableSha256: artifact.executableSha256,
		};
	} catch {
		throw new Error("RUNTIME_OPENCODE_PROVENANCE_MISMATCH");
	}
}
