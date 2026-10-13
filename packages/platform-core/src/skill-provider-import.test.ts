import { describe, expect, it, vi } from "vitest";
import { createSkillProviderImportV1 } from "./skill-provider-import.js";
import { createSkillProviderRegistryV1 } from "./skill-provider-registry.js";

const request = { userId: "user-a", requestId: "req-a", traceId: "trace-a" };
const candidate = {
	provider: "github" as const,
	name: "hello",
	version: "1.0.0",
	sourceVersion: "commit-a",
	sourceDigest: "a".repeat(64),
	approvalRef: "approval-a",
	archiveBytes: new Uint8Array([1, 2, 3]),
};

describe("Skill Provider import", () => {
	it("selects exactly one registry candidate and keeps identity server-owned", async () => {
		const admit = vi.fn().mockResolvedValue({ replayed: false, version: {} });
		const importer = createSkillProviderImportV1({
			registry: createSkillProviderRegistryV1({
				github: { discover: async () => [candidate] },
			}),
			admit,
		});
		await importer.importVersion(request, "key-a", {
			schemaVersion: 1,
			name: "hello",
			provider: "github",
			version: "1.0.0",
		});
		expect(admit).toHaveBeenCalledWith(
			expect.objectContaining({
				context: request,
				key: "key-a",
				candidate: expect.objectContaining({ sourceDigest: "a".repeat(64) }),
				selection: expect.objectContaining({ visibility: "PRIVATE" }),
			}),
		);
		expect(admit.mock.calls[0]?.[0].selection).not.toHaveProperty(
			"archiveBytes",
		);
	});

	it("fails closed when provider candidate is absent or ambiguous", async () => {
		const importer = createSkillProviderImportV1({
			registry: createSkillProviderRegistryV1({
				github: { discover: async () => [candidate, candidate] },
			}),
			admit: vi.fn(),
		});
		await expect(
			importer.importVersion(request, "key-a", {
				schemaVersion: 1,
				name: "hello",
				provider: "github",
				version: "1.0.0",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
	});
});
