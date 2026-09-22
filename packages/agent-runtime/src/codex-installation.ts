import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { CODEX_APP_SERVER_V2_PROVENANCE } from "./codex-app-server-bridge.js";
import release from "./codex-release.json" with { type: "json" };

export const CODEX_PILOT_EXECUTABLE = "/opt/codex/bin/codex";

export async function verifyCodexPilotInstallation() {
	try {
		if (
			JSON.stringify(release.provenance) !==
			JSON.stringify(CODEX_APP_SERVER_V2_PROVENANCE)
		) {
			throw new Error();
		}
		const artifact =
			process.arch === "arm64"
				? release.artifacts.arm64
				: process.arch === "x64"
					? release.artifacts.amd64
					: undefined;
		if (!artifact || process.platform !== "linux") throw new Error();
		const installed = await readFile("/opt/codex/share/release.json", "utf8");
		if (JSON.stringify(JSON.parse(installed)) !== JSON.stringify(release)) {
			throw new Error();
		}
		for (const [path, expected] of [
			[CODEX_PILOT_EXECUTABLE, artifact.executableSha256],
			...Object.entries(release.legal).map(([name, digest]) => [
				`/opt/codex/share/${name}`,
				digest,
			]),
		] as [string, string][]) {
			const digest = createHash("sha256")
				.update(await readFile(path))
				.digest("hex");
			if (`sha256:${digest}` !== expected) throw new Error();
		}
		return release.provenance;
	} catch {
		throw new Error("RUNTIME_CODEX_PROVENANCE_MISMATCH");
	}
}
