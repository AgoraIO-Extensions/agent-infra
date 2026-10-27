import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	createDeploymentSkillHubMaterializerFactoryV1,
	createDeploymentSkillMaterializerFactoryV1,
} from "./skill-materializer-production-assembly.js";

function runtimeUid() {
	const current = process.geteuid?.() ?? 0;
	return current === 65534 ? 65533 : 65534;
}

it("composes the existing materializer bridge from deployment-owned ports", async () => {
	const root = await mkdtemp(join(tmpdir(), "skill-assembly-"));
	try {
		await chmod(root, 0o700);
		const factory = createDeploymentSkillMaterializerFactoryV1({
			storage: {
				download: async () => {
					throw new Error("not expected for an empty binding set");
				},
			} as never,
			assemblyRoot: root,
			runtimeUid: runtimeUid(),
			resolveBindings: async () => [],
			recordAppliedReceipt: async () => {},
			verifyAdmission: async () => {},
		});
		const materializer = await factory({
			databaseUrl: "postgresql://worker.example.test/platform",
			signal: new AbortController().signal,
		});
		expect(materializer.materialize).toBeTypeOf("function");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.each([
	{ assemblyRoot: "relative", runtimeUid: 65534 },
	{ assemblyRoot: "/tmp/skill-assembly-invalid", runtimeUid: 0 },
])(
	"rejects malformed deployment assembly %#",
	({ assemblyRoot, runtimeUid }) => {
		expect(() =>
			createDeploymentSkillMaterializerFactoryV1({
				storage: { download: async () => new ReadableStream() } as never,
				assemblyRoot,
				runtimeUid,
				resolveBindings: async () => [],
				recordAppliedReceipt: async () => {},
				verifyAdmission: async () => {},
			}),
		).toThrow("SKILL_MATERIALIZER_CONFIGURATION_INVALID");
	},
);

it("composes Store bindings with the physical materializer when configured", async () => {
	const root = await mkdtemp(join(tmpdir(), "skill-assembly-store-"));
	try {
		const factory = createDeploymentSkillHubMaterializerFactoryV1({
			storage: {
				download: async () => {
					throw new Error("not expected for an empty binding set");
				},
			} as never,
			assemblyRoot: root,
			runtimeUid: runtimeUid(),
			store: {
				resolveSyncBindings: async () => [],
				readPublication: async () => null,
				recordAppliedReceipt: async (receipt: unknown) => receipt as never,
			},
			agentVersion: "agent-version-1",
			actor: {
				actorId: "actor-1",
				organizationIds: [],
				isAdministrator: false,
			},
			resolveAdmissionPolicy: async () => {
				throw new Error("no package");
			},
			sourceVerifier: {
				verify: async () => {
					throw new Error("no package");
				},
			},
		});
		expect(factory).toBeTypeOf("function");
		const materializer = await factory?.({
			databaseUrl: "postgresql://worker.example.test/platform",
			signal: new AbortController().signal,
		});
		expect(materializer?.materialize).toBeTypeOf("function");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.each([
	undefined,
	{ storage: {} },
	{ storage: { download: async () => new ReadableStream() } },
	{ agentVersion: () => "caller-derived" },
])(
	"leaves the optional Store materializer unavailable for incomplete input %#",
	(configuration) => {
		expect(
			createDeploymentSkillHubMaterializerFactoryV1(configuration as never),
		).toBeUndefined();
	},
);

import { readdir, readFile } from "node:fs/promises";
import type { SkillHubSyncBindingV1 } from "@agent-infra/contracts";
import { vi } from "vitest";
import { publicationFixture } from "../../../packages/object-storage/src/skill-package-consumer.fixture.js";

it("rejects legacy production callbacks without the original-publication consumer", () => {
	expect(
		createDeploymentSkillHubMaterializerFactoryV1({
			agentVersion: "version",
			resolvePackageObject: async () => null,
			verifyAdmission: async () => {},
		} as never),
	).toBeUndefined();
});
for (const mode of [
	"valid",
	"revoke-before-current",
	"binding-changed",
	"wrong-signature-digest",
]) {
	it(`production consumer materializer: ${mode}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "skill-consumer-worker-"));
		await chmod(root, 0o700);
		const f = await publicationFixture();
		const {
			name: _name,
			visibility: _visibility,
			admissionDecision: _admissionDecision,
			...ref
		} = f.version;
		let revoked = false;
		const binding: SkillHubSyncBindingV1 = {
			schemaVersion: 1,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			skillName: f.version.name,
			skillVersion: {
				...ref,
				signatureDigest:
					mode === "wrong-signature-digest"
						? "d".repeat(64)
						: ref.signatureDigest,
			},
			grant: {
				schemaVersion: 1,
				tools: [],
				connections: [],
				fileRoots: [],
				networkOrigins: [],
				scripts: false,
			},
			configurationRevision: 4,
			syncRevision: 2,
			state: "pending_sync",
			failureReason: null,
			appliedReceipt: null,
		};
		const recordAppliedReceipt = vi.fn(async (receipt) => receipt);
		const factory = createDeploymentSkillHubMaterializerFactoryV1({
			storage: f.options.storage,
			assemblyRoot: root,
			runtimeUid: runtimeUid(),
			agentVersion: "agent-version-1",
			actor: {
				actorId: "owner-a",
				organizationIds: [],
				isAdministrator: false,
			},
			store: {
				readPublication: f.options.readPublication,
				recordAppliedReceipt,
				resolveSyncBindings: async () => {
					if (
						mode === "revoke-before-current" &&
						(await readdir(join(root, "generations")).catch(() => [])).length >
							0
					) {
						f.setPolicy({ keyState: "revoked" });
						revoked = true;
					}
					if (
						mode === "binding-changed" &&
						(await readdir(join(root, "generations")).catch(() => [])).length >
							0
					)
						return [];
					return [binding];
				},
			},
			resolveAdmissionPolicy: f.options.resolveAdmissionPolicy,
			sourceVerifier: f.options.sourceVerifier,
		});
		try {
			expect(factory).toBeTypeOf("function");
			if (!factory) throw new Error("factory unavailable");
			const worker = await factory({
				databaseUrl: "unused",
				signal: new AbortController().signal,
			});
			const input = {
				agentId: "agent-1",
				configurationRevision: 4,
				workloadRevision: 2,
				fence: 1,
			};
			if (mode === "valid") {
				const first = await worker.materialize(input);
				expect(first.skills).toHaveLength(1);
				expect(recordAppliedReceipt).toHaveBeenCalledOnce();
				const restarted = await factory({
					databaseUrl: "unused",
					signal: new AbortController().signal,
				});
				const second = await restarted.materialize(input);
				expect(second.generationId).toBe(first.generationId);
				expect(f.publications).toBe(1);
			} else {
				await expect(worker.materialize(input)).rejects.toThrow();
				expect(recordAppliedReceipt).not.toHaveBeenCalled();
				await expect(readFile(join(root, "CURRENT"))).rejects.toMatchObject({
					code: "ENOENT",
				});
				if (mode === "revoke-before-current") expect(revoked).toBe(true);
			}
		} finally {
			await unseal(root);
			await rm(root, { recursive: true, force: true });
		}
	});
}

async function unseal(path: string): Promise<void> {
	await chmod(path, 0o700);
	for (const entry of await readdir(path, { withFileTypes: true }))
		if (entry.isDirectory()) await unseal(join(path, entry.name));
}
