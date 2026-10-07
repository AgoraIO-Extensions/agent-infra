import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { expect, it, vi } from "vitest";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
} from "../../../packages/agent-runtime/src/standard-mcp.fixture.js";
import { receiveProtectedStandardMcpInstallation } from "../../agent-runtime-host/src/standard-mcp-installation.js";
import { writeStandardMcpExport } from "../../agent-runtime-host/src/standard-mcp-installation.test-support.js";
import {
	createRuntimeConnectionConsumerSnapshotV1,
	createRuntimeConnectionInstallationRevisionV1,
	runtimeConnectionConsumerProjectionV1,
	runtimeConnectionInstallationRevisionEnvironment,
} from "./connection-consumer-projection.js";

// Controlled format interoperability only; real Linux protection remains #851.
vi.mock("../../agent-runtime-host/src/standard-mcp-protection.js", () => ({
	assertStandardMcpProcessProtection: vi.fn(),
}));

it("delivers the projected supply tuple to the merged Host's actual receiver", async () => {
	const dataDirectory = await realpath(
		await mkdtemp(join(tmpdir(), "worker-installation-reception-")),
	);
	try {
		const fixture = await standardMcpFixture();
		const source = await writeStandardMcpExport(dataDirectory, fixture.target, [
			fixture.input,
		]);
		const snapshot = createRuntimeConnectionConsumerSnapshotV1(
			fixture.target.profile,
			{
				schemaVersion: 1,
				configFingerprint: fixture.target.configFingerprint,
				egressEnforced: true,
				source: fixture.target.source,
			},
		);
		const revision = createRuntimeConnectionInstallationRevisionV1(
			source.manifest.delivery,
			snapshot,
		);
		const projected = runtimeConnectionConsumerProjectionV1(snapshot, revision);
		const value = projected.env.find(
			(entry) =>
				entry.name === runtimeConnectionInstallationRevisionEnvironment,
		)?.value;
		expect(value).toBe(source.revision);
		expect(
			await receiveProtectedStandardMcpInstallation({
				dataDirectory,
				agentId: reference.agentId,
				target: fixture.target,
				revision: value,
			}),
		).toMatchObject({ status: "available" });
		expect(
			await receiveProtectedStandardMcpInstallation({
				dataDirectory,
				agentId: "other-agent",
				target: fixture.target,
				revision: value,
			}),
		).toEqual({ status: "unavailable" });
		const otherProfile = {
			...fixture.target.profile,
			consumerId: "other-consumer",
		};
		expect(
			await receiveProtectedStandardMcpInstallation({
				dataDirectory,
				agentId: reference.agentId,
				target: {
					...fixture.target,
					profile: otherProfile,
					configFingerprint:
						connectionConsumerProfileFingerprintV1(otherProfile),
				},
				revision: value,
			}),
		).toEqual({ status: "unavailable" });
	} finally {
		await closeStandardMcpFixtures();
		await rm(dataDirectory, { recursive: true, force: true });
	}
});
