import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { projectApprovedDeclaredDemandImagesV1 } from "./declared-demand-images.js";
import { runtimeDemandImageContextV1 } from "./runtime-demand-images.js";

const context = {
	platformSource: "2".repeat(40),
	runtimeAuthority: "4".repeat(40),
	planHash: "a".repeat(64),
	clusterUid: "cluster",
	namespace: "runtime",
	namespaceUid: "namespace",
	release: "release",
	helmRevision: 36,
	installationId: "installation",
	directoryBindingHash: "b".repeat(64),
	directorySnapshotHash: "c".repeat(64),
};
const main = `ghcr.io/example/codex@sha256:${"1".repeat(64)}`;
const init = `ghcr.io/example/materializer@sha256:${"2".repeat(64)}`;
const entry = (name: string, image: string) => ({
	name,
	image,
	entrypointShapeHash: "d".repeat(64),
	entrypointSource: "pod-override",
});
function fixture() {
	return {
		schemaVersion: 1,
		context: { ...context },
		producerSourceSha: "e".repeat(40),
		producerInputHash: "e".repeat(64),
		groups: [
			{
				role: "desired-custom/agent",
				kind: "parent-workload",
				sourceKind: "custom",
				state: "current",
				namespace: "runtime",
				identityScope: "consumer",
				replicas: 1,
				images: [main, init],
				spec: {
					containers: [entry("runtime", main), entry("executor", main)],
					initContainers: [entry("snapshot-init", init)],
				},
				binding: { key: "parent-workload:agent", hash: "f".repeat(64) },
				reference: {
					kind: "Pod",
					namespace: "runtime",
					name: "pod",
					uid: "pod-uid",
					resourceVersion: "12",
				},
			},
		],
		publications: [
			{
				image: main,
				role: "codex",
				sourceSha: "4".repeat(40),
				manifestHash: "4".repeat(64),
			},
			{
				image: init,
				role: "snapshot-materializer",
				sourceSha: "2".repeat(40),
				manifestHash: "2".repeat(64),
			},
		],
	};
}
function run(
	value: unknown,
	casByKey: Readonly<Record<string, string>> = {
		"parent-workload:agent": "f".repeat(64),
	},
) {
	const bytes = Buffer.from(JSON.stringify(value));
	return projectApprovedDeclaredDemandImagesV1(bytes, {
		sha256: createHash("sha256").update(bytes).digest("hex"),
		producerSourceSha: "e".repeat(40),
		context,
		casByKey,
	});
}

it("keeps exact main/init/sidecar refs, mixed publication sources, target and fresh CAS", () => {
	const receipt = run(fixture());
	expect(receipt.groups[0]?.status).toBe("BOUND_APPROVED_IMAGE_GROUP");
	expect(receipt.groups[0]?.images.map((row) => [row.kind, row.image])).toEqual(
		[
			["main", main],
			["sidecar", main],
			["init", init],
		],
	);
	expect(
		receipt.groups[0]?.images.map((row) => row.publications[0]?.sourceSha),
	).toEqual(["4".repeat(40), "4".repeat(40), "2".repeat(40)]);
	expect(receipt.globalAbsenceProven).toBe(false);
	expect(receipt.retirementDecision).toBe("NOT_EVALUATED");
});

it("reuses a normal Runtime receipt context while rejecting a forged supplied context hash", () => {
	const value = { ...fixture(), context: runtimeDemandImageContextV1(context) };
	expect(run(value).groups[0]?.status).toBe("BOUND_APPROVED_IMAGE_GROUP");
	expect(() =>
		run({
			...value,
			context: { ...value.context, contextHash: "0".repeat(64) },
		}),
	).toThrow();
});

it("accepts a direct Session Pod with exact Session CAS without inventing a controller", () => {
	const value = fixture();
	const group = value.groups[0];
	if (!group) throw new Error("missing fixture");
	group.kind = "session";
	group.binding.key = "session:sandbox";
	const receipt = run(value, { "session:sandbox": "f".repeat(64) });
	expect(receipt.groups[0]?.reference?.kind).toBe("Pod");
	expect(receipt.groups[0]?.status).toBe("BOUND_APPROVED_IMAGE_GROUP");
});

it("accepts a bound snapshot init projection without inventing a parent main container", () => {
	const value = fixture();
	const receipt = run({
		...value,
		groups: value.groups.map((group) => ({
			...group,
			kind: "snapshot",
			images: [init],
			spec: { containers: [], initContainers: [entry("snapshot-init", init)] },
		})),
	});
	expect(receipt.groups[0]?.images.map((row) => [row.kind, row.image])).toEqual(
		[["init", init]],
	);
	expect(receipt.groups[0]?.status).toBe("BOUND_APPROVED_IMAGE_GROUP");
});

it("keeps stale CAS, absent final container roles or missing publication local and explicit", () => {
	const stale = run(fixture(), {});
	expect(stale.groups[0]?.status).toBe("UNKNOWN_MISSING_TRUSTED_FIELD");
	expect(stale.groups[0]?.images).toHaveLength(3);
	const incomplete = fixture();
	const withoutSpec = {
		...incomplete,
		groups: incomplete.groups.map((group) => ({ ...group, spec: null })),
	};
	const groups = run(withoutSpec).groups;
	expect(groups[0]?.images.map((row) => row.kind)).toEqual([
		"UNKNOWN",
		"UNKNOWN",
	]);
	expect(groups[0]?.missing).toContain(
		"normal final Pod container/init projection",
	);
	const missing = run({ ...incomplete, publications: [] });
	expect(missing.groups[0]?.images.map((row) => row.image)).toContain(init);
	expect(missing.groups[0]?.status).toBe("UNKNOWN_MISSING_TRUSTED_FIELD");
});

it("rejects dropped init refs, mutable refs, raw fields and caller completeness flags", () => {
	const value = fixture();
	for (const changed of [
		{
			...value,
			groups: value.groups.map((group) => ({ ...group, images: [main] })),
		},
		{
			...value,
			groups: value.groups.map((group) => ({
				...group,
				images: ["ghcr.io/example/codex:latest"],
			})),
		},
		{ ...value, complete: true },
		{
			...value,
			groups: value.groups.map((group) => ({
				...group,
				role: "https://private.example.test",
			})),
		},
		{
			...value,
			groups: value.groups.map((group) => ({
				...group,
				spec: { ...group.spec, env: { PRIVATE: "DO_NOT_READ" } },
			})),
		},
	])
		expect(() => run(changed)).toThrow("DECLARED_IMAGE_INPUT_INVALID");
});

it("rejects a different site/source/Directory/producer and an unapproved file hash", () => {
	for (const change of [
		{ namespaceUid: "foreign" },
		{ helmRevision: 22 },
		{ directorySnapshotHash: "9".repeat(64) },
		{ platformSource: "4".repeat(40) },
	])
		expect(() =>
			run({ ...fixture(), context: { ...context, ...change } }),
		).toThrow();
	expect(() =>
		run({ ...fixture(), producerSourceSha: "9".repeat(40) }),
	).toThrow();
	expect(() =>
		projectApprovedDeclaredDemandImagesV1(
			Buffer.from(JSON.stringify(fixture())),
			{
				sha256: "0".repeat(64),
				producerSourceSha: "e".repeat(40),
				context,
				casByKey: {},
			},
		),
	).toThrow();
});

it("treats approved preparer extras as declarations and never manufactures a future Session", () => {
	const value = fixture();
	const receipt = run({
		...value,
		groups: value.groups.map((group) => ({
			...group,
			kind: "declared",
			state: "latest",
			identityScope: "preparer",
			replicas: 0,
			reference: null,
			binding: null,
		})),
	});
	expect(receipt.groups[0]?.identityEvidence).toBe("NO_ACTUAL_RESOURCE_PROOF");
	expect(receipt.futureSessionsCreated).toBe(0);
	expect(() =>
		run({
			...value,
			groups: value.groups.map((group) => ({
				...group,
				kind: "session",
				identityScope: "preparer",
				replicas: 0,
				reference: null,
				binding: null,
			})),
		}),
	).toThrow();
});
