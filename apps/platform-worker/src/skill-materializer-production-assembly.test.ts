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
				recordAppliedReceipt: async (receipt: unknown) => receipt as never,
			},
			agentVersion: "agent-version-1",
			actor: {
				actorId: "actor-1",
				organizationIds: [],
				isAdministrator: false,
			},
			resolvePackageObject: async () => undefined,
			verifyAdmission: async () => {},
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
