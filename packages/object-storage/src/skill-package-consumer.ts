import { createHash, KeyObject } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	parseSkillHubRegistrationV1,
	parseSkillPackagePublicationStateV1,
	type SkillHubRegistrationV1,
	type SkillPackagePublicationObjectV1,
	type SkillPackagePublicationStageV1,
	type SkillPackagePublicationStateV1,
	skillPackagePublicationStagesV1,
} from "@agent-infra/platform-core";
import {
	admissionSignatureBytesV1,
	canonicalSkillPackageScanReceiptV1,
	canonicalSkillPackageSourceProofV1,
	prepareSkillPackageV1,
	SkillPackageAdmissionErrorV1,
	type SkillPackageScanReceiptV1,
	type SkillPackageSourceProofV1,
	type SkillPackageSourceVerifierV1,
	verifyAdmissionSignatureV1,
	verifySkillPackageScanReceiptV1,
} from "./skill-package-admission.js";
import type { ObjectStorageDataV1 } from "./types.js";

/** Internal, already authorized Store read. No HTTP or caller admission claims. */
export type SkillPackagePublicationReadV1 = Readonly<{
	state: SkillPackagePublicationStateV1;
	version: SkillHubRegistrationV1;
	ownerId: string;
}>;
export type SkillPackageConsumerPolicyV1 = Readonly<{
	policyRevision: string;
	trustRevision: string;
	maximumReceiptAgeMs: number;
	scannerId: string;
	engineVersion: string;
	rulesetDigest: string;
	keyId: string;
	keyState: "active" | "revoked";
	publicKey: KeyObject;
	/** Explicit deployment approval for internal sources without an approval reference. */
	allowInternalWithoutApproval: boolean;
}>;
export type SkillPackageConsumerOptionsV1 = Readonly<{
	storage: Pick<ObjectStorageDataV1, "download">;
	readPublication: (input: {
		skillVersionId: string;
		packageObjectVersion: string;
	}) => Promise<SkillPackagePublicationReadV1 | null>;
	resolveAdmissionPolicy: () => Promise<SkillPackageConsumerPolicyV1>;
	sourceVerifier: SkillPackageSourceVerifierV1;
}>;
const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown) => Buffer.from(JSON.stringify(value));
const fail = (): never => {
	throw new SkillPackageAdmissionErrorV1("dependency_unavailable");
};
const equalBytes = (actual: Uint8Array, expected: Uint8Array) => {
	if (!Buffer.from(actual).equals(expected)) fail();
};
async function readFixed(
	storage: SkillPackageConsumerOptionsV1["storage"],
	object: SkillPackagePublicationObjectV1,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const stream = await storage.download({
		objectRef: object.objectRef,
		version: object.version,
		etag: object.etag,
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		signal,
		expectedMetadata: {
			sizeBytes: object.sizeBytes,
			mediaType: object.mediaType,
		},
	});
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > object.sizeBytes) fail();
			chunks.push(next.value);
		}
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const bytes = Buffer.concat(chunks);
	if (size !== object.sizeBytes || sha(bytes) !== object.sha256) fail();
	return bytes;
}

/** Read-only verification. Every call re-reads original evidence and current trust. */
export function createSkillPackageConsumerV1(
	options: SkillPackageConsumerOptionsV1,
) {
	return {
		async verify(input: {
			skillVersionId: string;
			packageObjectVersion: string;
			signal?: AbortSignal;
		}) {
			const signal = input.signal ?? new AbortController().signal;
			try {
				signal.throwIfAborted();
				const raw = await options.readPublication(input);
				if (!raw) return fail();
				const state = parseSkillPackagePublicationStateV1(raw.state);
				const version = parseSkillHubRegistrationV1(raw.version);
				const selection = state.selection;
				if (
					raw.ownerId !== state.ownerId ||
					version.skillVersionId !== input.skillVersionId ||
					version.packageObjectVersion !== input.packageObjectVersion
				)
					fail();
				for (const field of [
					"name",
					"skillId",
					"skillVersionId",
					"visibility",
					"provider",
					"version",
				] as const)
					if (version[field] !== selection[field]) fail();
				if (version.organizationId !== selection.organizationId) fail();
				for (const stage of skillPackagePublicationStagesV1) {
					const object = state.objects[stage];
					if (
						!object ||
						object.mediaType !==
							(stage === "zip"
								? "application/zip"
								: stage === "signature"
									? "application/octet-stream"
									: "application/json") ||
						object.sizeBytes < 1 ||
						object.sizeBytes > (stage === "zip" ? 50_000_000 : 2_000_000)
					)
						fail();
				}
				const objects = state.objects as Readonly<
					Record<
						SkillPackagePublicationStageV1,
						SkillPackagePublicationObjectV1
					>
				>;
				const zip = objects.zip;
				if (
					zip.version !== version.packageObjectVersion ||
					zip.sha256 !== version.packageDigest ||
					zip.sha256 !== selection.archiveDigest ||
					objects.manifest.sha256 !== version.manifestDigest ||
					objects.signature.sha256 !== version.signatureDigest
				)
					fail();
				const resolvePolicy = async () => {
					signal.throwIfAborted();
					const p = await options.resolveAdmissionPolicy();
					if (
						p.keyState !== "active" ||
						typeof p.allowInternalWithoutApproval !== "boolean" ||
						!(p.publicKey instanceof KeyObject) ||
						p.publicKey.type !== "public" ||
						p.publicKey.asymmetricKeyType !== "ed25519" ||
						p.trustRevision !== selection.trustRevision ||
						p.policyRevision !== selection.policyRevision ||
						!Number.isSafeInteger(p.maximumReceiptAgeMs) ||
						p.maximumReceiptAgeMs < 1 ||
						p.maximumReceiptAgeMs > 86_400_000 ||
						!/^[a-f0-9]{64}$/.test(p.rulesetDigest)
					)
						fail();
					if (
						selection.approvalRef === null &&
						(!p.allowInternalWithoutApproval ||
							!["system", "my_library"].includes(selection.provider))
					)
						fail();
					return {
						...p,
						publicKey: p.publicKey
							.export({ type: "spki", format: "der" })
							.toString("base64"),
					};
				};
				const initialPolicy = await resolvePolicy();
				const bytes = {} as Record<SkillPackagePublicationStageV1, Buffer>;
				for (const stage of skillPackagePublicationStagesV1)
					bytes[stage] = await readFixed(
						options.storage,
						objects[stage],
						signal,
					);
				const prepared = prepareSkillPackageV1({
					archiveBytes: bytes.zip,
					name: selection.name,
					version: selection.version,
				});
				equalBytes(bytes.manifest, prepared.manifestBytes);
				const source = JSON.parse(
					bytes["source-proof"].toString("utf8"),
				) as SkillPackageSourceProofV1;
				equalBytes(
					bytes["source-proof"],
					canonicalSkillPackageSourceProofV1(source),
				);
				const scan = JSON.parse(
					bytes.scan.toString("utf8"),
				) as SkillPackageScanReceiptV1;
				equalBytes(bytes.scan, canonicalSkillPackageScanReceiptV1(scan));
				for (const stage of [
					"source-proof",
					"scan",
					"signature-record",
				] as const)
					if (
						!isDeepStrictEqual(
							JSON.parse(bytes[stage].toString("utf8")),
							state.intents[stage]?.evidence,
						)
					)
						fail();
				const signatureInput = {
					skillId: selection.skillId,
					skillVersionId: selection.skillVersionId,
					ownerId: state.ownerId,
					provider: selection.provider,
					version: selection.version,
					packageObjectVersion: zip.version,
					packageDigest: zip.sha256,
					manifestDigest: version.manifestDigest,
					sourceProofDigest: sha(bytes["source-proof"]),
					scanReceiptDigest: sha(bytes.scan),
					trustRevision: selection.trustRevision,
					policyRevision: selection.policyRevision,
					signingKeyId: initialPolicy.keyId,
				};
				const signed = admissionSignatureBytesV1(signatureInput);
				equalBytes(
					bytes["signature-record"],
					signed.subarray(
						Buffer.byteLength("agent-infra:skill-package-admission:v1\n"),
					),
				);
				const bundle = {
					schemaVersion: 1,
					operationId: state.operationId,
					ownerId: state.ownerId,
					selection,
					objects: Object.fromEntries(
						skillPackagePublicationStagesV1
							.filter((stage) => stage !== "bundle")
							.map((stage) => [stage, state.objects[stage]]),
					),
				};
				equalBytes(bytes.bundle, canonical(bundle));
				if (!isDeepStrictEqual(bundle, state.intents.bundle?.evidence)) fail();
				const currentSource = await options.sourceVerifier.verify({
					provider: selection.provider,
					sourceVersion: selection.sourceVersion,
					sourceDigest: selection.sourceDigest,
					archiveDigest: zip.sha256,
					manifestDigest: version.manifestDigest,
					trustRevision: selection.trustRevision,
					approvalRef: selection.approvalRef,
					ownerId: state.ownerId,
				});
				equalBytes(
					bytes["source-proof"],
					canonicalSkillPackageSourceProofV1(currentSource),
				);
				if (
					source.provider !== selection.provider ||
					source.sourceVersion !== selection.sourceVersion ||
					source.sourceDigest !== selection.sourceDigest ||
					source.trustRevision !== selection.trustRevision ||
					source.approvalRef !== selection.approvalRef ||
					(selection.provider === "my_library" &&
						(source.publisherId !== state.ownerId ||
							source.sourceDigest !== zip.sha256))
				)
					fail();
				const current = await resolvePolicy();
				if (!isDeepStrictEqual(initialPolicy, current)) fail();
				verifySkillPackageScanReceiptV1(
					scan,
					prepared,
					signatureInput.sourceProofDigest,
					current.policyRevision,
					current.maximumReceiptAgeMs,
				);
				if (
					scan.scannerId !== current.scannerId ||
					scan.engineVersion !== current.engineVersion ||
					scan.rulesetDigest !== current.rulesetDigest
				)
					fail();
				verifyAdmissionSignatureV1(signed, bytes.signature, {
					key: Buffer.from(current.publicKey, "base64"),
					format: "der",
					type: "spki",
				});
				const final = await options.readPublication(input);
				if (
					!final ||
					!isDeepStrictEqual(
						state,
						parseSkillPackagePublicationStateV1(final.state),
					) ||
					!isDeepStrictEqual(
						version,
						parseSkillHubRegistrationV1(final.version),
					) ||
					final.ownerId !== state.ownerId
				)
					fail();
				const finalSource = await options.sourceVerifier.verify({
					provider: selection.provider,
					sourceVersion: selection.sourceVersion,
					sourceDigest: selection.sourceDigest,
					archiveDigest: zip.sha256,
					manifestDigest: version.manifestDigest,
					trustRevision: selection.trustRevision,
					approvalRef: selection.approvalRef,
					ownerId: state.ownerId,
				});
				equalBytes(
					bytes["source-proof"],
					canonicalSkillPackageSourceProofV1(finalSource),
				);
				// Re-read policy after the final Store wait; no cached allow escapes this call.
				if (!isDeepStrictEqual(current, await resolvePolicy())) fail();
				verifySkillPackageScanReceiptV1(
					scan,
					prepared,
					signatureInput.sourceProofDigest,
					current.policyRevision,
					current.maximumReceiptAgeMs,
				);
				signal.throwIfAborted();
				return Object.freeze({
					state,
					version,
					ownerId: state.ownerId,
					packageObject: zip,
				});
			} catch {
				return fail();
			}
		},
	};
}
