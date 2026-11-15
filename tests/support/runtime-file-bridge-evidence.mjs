/**
 * #3230：宿主侧测试共用的 FileBridge origin 探针结果。只用于 fake Docker 与校验器测试，
 * 不是镜像证据。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	fileBridgeProbeIsolation,
	fileBridgeProbeOrigin,
	fileBridgeProbeRequiredChecks,
} from "./runtime-file-bridge-probe.mjs";

const digest = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

export function syntheticFileBridgeResult(
	driver,
	{
		architecture = "amd64",
		namespace = "agent-infra-probe",
		releaseBytes = readFileSync(
			resolve(
				import.meta.dirname,
				"../../packages/agent-runtime/src/codex-release.json",
			),
		),
	} = {},
) {
	return {
		schemaVersion: 1,
		status: "passed",
		capability: "file-bridge-origin",
		driver,
		origin: fileBridgeProbeOrigin(namespace),
		assemblies: ["session-sandbox", "agent-workload"],
		isolation: fileBridgeProbeIsolation(driver),
		checks: fileBridgeProbeRequiredChecks(driver),
		exchange: {
			reads: 7,
			contentReads: 5,
			results: 2,
			contentWrites: 2,
			completes: 2,
			violations: 0,
		},
		localModelRequests: 2,
		externalModelRequests: 0,
		stopExitCodes: { sessionSandbox: 0, agentWorkload: 0 },
		installation: {
			platform: "linux",
			architecture,
			codexReleaseSha256: digest(releaseBytes),
			runtimeHostEntrySha256: digest("synthetic-host-entry"),
			startScriptSha256: digest("synthetic-start-script"),
		},
	};
}
