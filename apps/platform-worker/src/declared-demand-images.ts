import { createHash } from "node:crypto";
import {
	type RuntimeDemandImageContextV1,
	runtimeDemandImageContextV1,
} from "./runtime-demand-images.js";

const sha = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const imageRef =
	/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@(sha256:[a-f0-9]{64})$/;
const name = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
function check(value: unknown): asserts value {
	if (!value) throw new Error("DECLARED_IMAGE_INPUT_INVALID");
}
function object(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	check(value && typeof value === "object" && !Array.isArray(value));
	check(Object.keys(value).every((key) => keys.includes(key)));
	return value as Record<string, unknown>;
}
function text(value: unknown, pattern = name): string {
	check(typeof value === "string" && pattern.test(value));
	return value;
}
function array(value: unknown): unknown[] {
	check(Array.isArray(value) && value.length <= 10_000);
	return value;
}
const set = (values: readonly string[]) => [...new Set(values)].sort();

/** Consume only Ho's approved image-only export, never raw values, requests, env or Pod bodies. */
export function projectApprovedDeclaredDemandImagesV1(
	bytes: Uint8Array,
	expected: {
		readonly sha256: string;
		readonly producerSourceSha: string;
		readonly context: RuntimeDemandImageContextV1;
		readonly casByKey: Readonly<Record<string, string>>;
	},
) {
	check(bytes.byteLength <= 1024 * 1024);
	text(expected.sha256, sha);
	const fileHash = createHash("sha256").update(bytes).digest("hex");
	check(fileHash === expected.sha256);
	const context = runtimeDemandImageContextV1(expected.context);
	const input = object(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
		[
			"schemaVersion",
			"context",
			"producerSourceSha",
			"producerInputHash",
			"groups",
			"publications",
		],
	);
	check(input.schemaVersion === 1);
	const suppliedContext = object(input.context, [
		...Object.keys(expected.context),
		"contextHash",
	]);
	if (suppliedContext.contextHash !== undefined)
		check(suppliedContext.contextHash === context.contextHash);
	check(
		runtimeDemandImageContextV1(input.context as RuntimeDemandImageContextV1)
			.contextHash === context.contextHash,
	);
	check(
		text(input.producerSourceSha, commit) ===
			text(expected.producerSourceSha, commit),
	);
	const producerInputHash = text(input.producerInputHash, sha);
	const publications = array(input.publications).map((raw) => {
		const value = object(raw, ["image", "role", "sourceSha", "manifestHash"]);
		return {
			image: text(value.image, imageRef),
			role: text(value.role),
			sourceSha: text(value.sourceSha, commit),
			manifestHash: text(value.manifestHash, sha),
		};
	});
	const roles = new Set<string>();
	const groups = array(input.groups).map((raw) => {
		const group = object(raw, [
			"role",
			"kind",
			"sourceKind",
			"state",
			"namespace",
			"identityScope",
			"replicas",
			"images",
			"spec",
			"binding",
			"reference",
		]);
		const role = text(group.role);
		check(!roles.has(role));
		roles.add(role);
		const kind = text(group.kind);
		const sourceKind = text(group.sourceKind);
		const state = text(group.state);
		const identityScope = text(group.identityScope);
		check(
			["declared", "parent-workload", "session", "snapshot"].includes(kind),
		);
		check(["standard", "custom", "unknown"].includes(sourceKind));
		check(["current", "latest", "retained", "declared"].includes(state));
		check(
			group.namespace === context.namespace &&
				["preparer", "consumer"].includes(identityScope),
		);
		check(
			typeof group.replicas === "number" &&
				Number.isSafeInteger(group.replicas) &&
				group.replicas >= 0,
		);
		if (identityScope === "preparer")
			check(
				kind === "declared" &&
					group.replicas === 0 &&
					group.reference === null &&
					group.binding === null,
			);
		const declared = array(group.images).map((value) => text(value, imageRef));
		check(declared.length > 0 && set(declared).length === declared.length);
		const missing: string[] = [];
		let binding: { key: string; hash: string } | null = null;
		if (group.binding !== null) {
			const value = object(group.binding, ["key", "hash"]);
			binding = {
				key: text(
					value.key,
					/^(?:parent-workload|session):[A-Za-z0-9._-]{1,200}$/,
				),
				hash: text(value.hash, sha),
			};
			check(kind !== "session" || binding.key.startsWith("session:"));
			check(
				kind !== "parent-workload" ||
					binding.key.startsWith("parent-workload:"),
			);
			if (expected.casByKey[binding.key] !== binding.hash)
				missing.push("fresh Store CAS for binding.key");
		} else if (group.identityScope === "consumer")
			missing.push("existing object Store CAS binding");
		let reference: {
			kind: string;
			namespace: string;
			name: string;
			uid: string;
			resourceVersion: string;
		} | null = null;
		if (group.reference !== null) {
			const value = object(group.reference, [
				"kind",
				"namespace",
				"name",
				"uid",
				"resourceVersion",
			]);
			check(
				["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job"].includes(
					String(value.kind),
				) && value.namespace === context.namespace,
			);
			reference = {
				kind: text(value.kind),
				namespace: context.namespace,
				name: text(value.name),
				uid: text(value.uid),
				resourceVersion: text(value.resourceVersion),
			};
		}
		const containers: {
			name: string | null;
			kind: string;
			image: string;
			entrypointShapeHash: string | null;
			entrypointSource: string;
		}[] = [];
		if (group.spec === null) {
			missing.push("normal final Pod container/init projection");
			containers.push(
				...declared.map((image) => ({
					name: null,
					kind: "UNKNOWN",
					image,
					entrypointShapeHash: null,
					entrypointSource: "UNKNOWN",
				})),
			);
		} else {
			const spec = object(group.spec, ["containers", "initContainers"]);
			const names = new Set<string>();
			for (const [field, entries] of [
				["containers", array(spec.containers)],
				["initContainers", array(spec.initContainers)],
			] as const) {
				if (field === "containers" && kind !== "snapshot")
					check(entries.length > 0);
				for (const [index, rawContainer] of entries.entries()) {
					const value = object(rawContainer, [
						"name",
						"image",
						"entrypointShapeHash",
						"entrypointSource",
					]);
					const containerName = text(value.name);
					check(!names.has(containerName));
					names.add(containerName);
					check(
						["pod-override", "image-default-unverified"].includes(
							String(value.entrypointSource),
						),
					);
					containers.push({
						name: containerName,
						kind:
							field === "initContainers"
								? "init"
								: index === 0
									? "main"
									: "sidecar",
						image: text(value.image, imageRef),
						entrypointShapeHash: text(value.entrypointShapeHash, sha),
						entrypointSource: text(value.entrypointSource),
					});
				}
			}
			check(
				containers.length > 0 &&
					JSON.stringify(set(containers.map((value) => value.image))) ===
						JSON.stringify(set(declared)),
			);
		}
		const images = containers.map((value) => {
			const proofs = publications.filter(
				(publication) => publication.image === value.image,
			);
			if (proofs.length === 0)
				missing.push(
					`approved manifest binding for ${value.name ?? "image group"}`,
				);
			return {
				...value,
				digest: value.image.slice(value.image.lastIndexOf("@") + 1),
				publications: proofs,
			};
		});
		return {
			role,
			kind,
			sourceKind,
			state,
			namespace: context.namespace,
			identityScope,
			replicas: group.replicas,
			binding,
			reference,
			images,
			status: missing.length
				? "UNKNOWN_MISSING_TRUSTED_FIELD"
				: "BOUND_APPROVED_IMAGE_GROUP",
			missing: set(missing),
			identityEvidence: reference
				? "approved-file-UID-RV; live-unverified"
				: "NO_ACTUAL_RESOURCE_PROOF",
		};
	});
	return {
		schemaVersion: 1,
		fileHash,
		producerSourceSha: input.producerSourceSha,
		producerInputHash,
		contextHash: context.contextHash,
		fileReadAt: new Date().toISOString(),
		scope: "approved-image-file-groups-only",
		groups,
		emptyAfterFileEnumeration: groups.length === 0,
		globalAbsenceProven: false,
		retirementDecision: "NOT_EVALUATED",
		futureSessionsCreated: 0,
		fieldWrites: 0,
	};
}
