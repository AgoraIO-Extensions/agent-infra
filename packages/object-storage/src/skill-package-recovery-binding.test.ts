import { createHash } from "node:crypto";
import type { SkillPackagePublicationPortV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import { FakeObjectStorageV1 } from "./index.js";
import { packSkillProjectSnapshotV1 } from "./skill-package-admission.js";
import { SkillPackageSupplierV1 } from "./skill-package-supplier.js";
import { createSkillProjectSourceVerifierV1 } from "./skill-project-source.js";

const context = { userId: "owner-a", requestId: "r", traceId: "t" };
const archive = packSkillProjectSnapshotV1([
	{ path: "SKILL.md", bytes: new TextEncoder().encode("# review") },
]);
const input = {
	name: "review",
	skillId: "project-a",
	skillVersionId: "version-a",
	provider: "my_library" as const,
	visibility: "PRIVATE" as const,
	version: "1.0.0",
	sourceVersion: "project:project-a:r2",
	sourceDigest: createHash("sha256").update(archive).digest("hex"),
	approvalRef: null,
	trustRevision: "trust",
	policyRevision: "policy",
	archiveBytes: archive,
};
function setup(resume = true) {
	const failure = async () => {
		throw Object.assign(new Error("synthetic stopped before work"), {
			code: "unavailable",
		});
	};
	const publishPackage = vi.fn(failure);
	const resumePackage = vi.fn(failure);
	const policy = vi.fn();
	const scan = vi.fn();
	const storage = new FakeObjectStorageV1({ contentPolicy: "skill-package" });
	const upload = vi.spyOn(storage, "upload");
	const lifecycle: SkillPackagePublicationPortV1 = {
		publishPackage,
		...(resume ? { resumePackage } : {}),
	};
	const supplier = new SkillPackageSupplierV1({
		storage,
		lifecycle,
		resolveAdmissionPolicy: policy,
		sourceVerifier: createSkillProjectSourceVerifierV1(),
		scanner: { scan },
	});
	return { supplier, publishPackage, resumePackage, upload, policy, scan };
}
describe("supplier original-operation recovery binding", () => {
	it("routes recovery exclusively to the original-operation entry before any package IO", async () => {
		const x = setup();
		await expect(
			x.supplier.admitVersion(context, input, "original-key", "operation-a"),
		).rejects.toBeDefined();
		expect(x.resumePackage).toHaveBeenCalledWith(
			context,
			"operation-a",
			"original-key",
			expect.objectContaining({ skillVersionId: "version-a" }),
			expect.any(Function),
			expect.any(Function),
		);
		expect(x.publishPackage).not.toHaveBeenCalled();
		expect(x.upload).not.toHaveBeenCalled();
		expect(x.scan).not.toHaveBeenCalled();
	});
	it("fails closed without a recovery-capable lifecycle instead of falling back to normal creation", async () => {
		const x = setup(false);
		await expect(
			x.supplier.admitVersion(context, input, "original-key", "operation-a"),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(x.publishPackage).not.toHaveBeenCalled();
		expect(x.upload).not.toHaveBeenCalled();
	});
	it("keeps ordinary publication on the existing normal entry", async () => {
		const x = setup();
		await expect(
			x.supplier.admitVersion(context, input, "original-key"),
		).rejects.toBeDefined();
		expect(x.publishPackage).toHaveBeenCalledOnce();
		expect(x.resumePackage).not.toHaveBeenCalled();
	});
});
