import { expect, it, vi } from "vitest";

const constructors = vi.hoisted(() => ({
	session: vi.fn(),
	snapshots: vi.fn(),
}));
vi.mock("@agent-infra/platform-store", async (original) => ({
	...(await original<typeof import("@agent-infra/platform-store")>()),
	openPostgresSessionSandboxImageReaderV1: constructors.session,
	openPostgresWorkspaceSnapshotMaterializationReaderV1: constructors.snapshots,
}));

import { readSessionDemandImagesV1 } from "./session-demand-images.js";

it("rejects missing/type/length input errors before any DB reader is constructed", async () => {
	const input = {
		databaseUrl: "postgresql://synthetic/platform",
		namespace: "runtime",
		contextHash: "a".repeat(64),
		authorities: [],
		bindings: [],
	};
	for (const change of [
		{ databaseUrl: undefined },
		{ databaseUrl: "" },
		{ databaseUrl: `postgresql://synthetic/${"x".repeat(8192)}` },
		{ contextHash: null },
		{ authorities: null },
		{ bindings: null },
	]) {
		await expect(
			readSessionDemandImagesV1({
				...input,
				...change,
			} as unknown as Parameters<typeof readSessionDemandImagesV1>[0]),
		).rejects.toThrow("SESSION_IMAGE_READ_FAILED");
	}
	expect(constructors.session).not.toHaveBeenCalled();
	expect(constructors.snapshots).not.toHaveBeenCalled();
});
