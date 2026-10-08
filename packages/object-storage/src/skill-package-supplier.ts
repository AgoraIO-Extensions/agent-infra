import { createHash, sign } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import {
	parseSkillHubRegistrationV1,
	parseSkillHubRequestV1,
	parseSkillPackagePublicationSelectionV1,
	SkillHubOperationErrorV1,
	type SkillHubRequestV1,
	type SkillPackagePublicationContextV1,
	type SkillPackagePublicationObjectV1,
	type SkillPackagePublicationPortV1,
	type SkillPackagePublicationSelectionV1,
	type SkillPackagePublicationStageV1,
	skillPackageObjectRefV1,
	skillPackagePublicationStagesV1,
} from "@agent-infra/platform-core";
import {
	admissionSignatureBytesV1,
	canonicalSkillPackageScanReceiptV1,
	canonicalSkillPackageSourceProofV1,
	prepareSkillPackageV1,
	SkillPackageAdmissionErrorV1,
	type SkillPackageAdmissionSignerV1,
	type SkillPackageScannerV1,
	type SkillPackageScanReceiptV1,
	type SkillPackageSourceProofV1,
	type SkillPackageSourceVerifierV1,
	verifyAdmissionSignatureV1,
	verifySkillPackageScanReceiptV1,
} from "./skill-package-admission.js";
import type { ObjectStorageDataV1 } from "./types.js";

const sha256 = (value: Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));
const expiresAt = () => new Date(Date.now() + 300_000).toISOString();
const fail = (): never => {
	throw new SkillPackageAdmissionErrorV1("dependency_unavailable");
};
export type SkillPackageSupplyInputV1 = Omit<
	SkillPackagePublicationSelectionV1,
	"schemaVersion" | "archiveDigest"
> &
	Readonly<{ archiveBytes: Uint8Array }>;
export type SkillPackageAdmissionPolicyV1 = Readonly<{
	policyRevision: string;
	maximumReceiptAgeMs: number;
	scannerId: string;
	engineVersion: string;
	rulesetDigest: string;
	signer: SkillPackageAdmissionSignerV1;
}>;
export interface SkillPackageSupplierOptionsV1 {
	readonly storage: ObjectStorageDataV1;
	readonly lifecycle: SkillPackagePublicationPortV1;
	/** Re-resolves current service-owned key, revocation, trust and scan configuration. */
	readonly resolveAdmissionPolicy: () => Promise<SkillPackageAdmissionPolicyV1>;
	readonly sourceVerifier: SkillPackageSourceVerifierV1;
	readonly scanner: SkillPackageScannerV1;
}
/** Physical package supply adapter. Lifecycle and durable control metadata stay in Core/Store. */
export class SkillPackageSupplierV1 {
	readonly #options: SkillPackageSupplierOptionsV1;
	constructor(options: SkillPackageSupplierOptionsV1) {
		this.#options = options;
	}
	async #read(object: SkillPackagePublicationObjectV1) {
		const stream = await this.#options.storage.download({
			objectRef: object.objectRef,
			version: object.version,
			etag: object.etag,
			expiresAt: expiresAt(),
		});
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				length += next.value.byteLength;
				if (length > object.sizeBytes) fail();
				chunks.push(next.value);
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		const result = Buffer.concat(chunks);
		if (length !== object.sizeBytes || sha256(result) !== object.sha256) fail();
		return result;
	}
	async admitVersion(
		context: SkillHubRequestV1,
		input: SkillPackageSupplyInputV1,
		key?: string,
	) {
		const request = parseSkillHubRequestV1(context);
		// Snapshot plain data and archive bytes before the first wait; reject caller policy/ownership claims.
		if (
			!input ||
			typeof input !== "object" ||
			types.isProxy(input) ||
			Object.getPrototypeOf(input) !== Object.prototype
		)
			fail();
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const fields = [
			"name",
			"skillId",
			"skillVersionId",
			"visibility",
			"provider",
			"version",
			"sourceVersion",
			"sourceDigest",
			"approvalRef",
			"trustRevision",
			"policyRevision",
			"archiveBytes",
		];
		if (
			Reflect.ownKeys(descriptors).length !== fields.length ||
			fields.some(
				(field) =>
					!descriptors[field]?.enumerable || !("value" in descriptors[field]),
			)
		)
			fail();
		const values = Object.fromEntries(
			fields.map((field) => [field, descriptors[field]?.value]),
		);
		if (
			!(values.archiveBytes instanceof Uint8Array) ||
			types.isProxy(values.archiveBytes) ||
			values.archiveBytes.buffer instanceof SharedArrayBuffer ||
			values.archiveBytes.byteLength > 50_000_000
		)
			fail();
		const archiveBytes = Uint8Array.from(values.archiveBytes);
		const { archiveBytes: _bytes, ...metadata } = values;
		const selection = parseSkillPackagePublicationSelectionV1({
			schemaVersion: 1,
			...metadata,
			archiveDigest: sha256(archiveBytes),
		});
		if (
			selection.provider === "my_library" &&
			selection.sourceDigest !== selection.archiveDigest
		)
			fail();
		let prepared!: ReturnType<typeof prepareSkillPackageV1>;
		const ensurePrepared = () =>
			(prepared ??= prepareSkillPackageV1({
				archiveBytes,
				name: selection.name,
				version: selection.version,
			}));
		let originalPolicy: SkillPackageAdmissionPolicyV1 | undefined;
		let source: SkillPackageSourceProofV1 | undefined;
		let receipt: SkillPackageScanReceiptV1 | undefined;
		let publication: SkillPackagePublicationContextV1 | undefined;
		const policy = async () => {
			const current = await this.#options.resolveAdmissionPolicy();
			if (
				current.policyRevision !== selection.policyRevision ||
				current.signer.trustRevision !== selection.trustRevision ||
				!Number.isSafeInteger(current.maximumReceiptAgeMs) ||
				current.maximumReceiptAgeMs < 1 ||
				current.maximumReceiptAgeMs > 86_400_000 ||
				!/^[a-f0-9]{64}$/.test(current.rulesetDigest)
			)
				fail();
			if (
				originalPolicy &&
				(current.scannerId !== originalPolicy.scannerId ||
					current.engineVersion !== originalPolicy.engineVersion ||
					current.rulesetDigest !== originalPolicy.rulesetDigest ||
					current.maximumReceiptAgeMs !== originalPolicy.maximumReceiptAgeMs ||
					current.signer.keyId !== originalPolicy.signer.keyId ||
					!isDeepStrictEqual(
						current.signer.publicKey,
						originalPolicy.signer.publicKey,
					))
			)
				fail();
			originalPolicy ??= current;
			return current;
		};
		const validate = async () => {
			ensurePrepared();
			await policy();
			const proof = await this.#options.sourceVerifier.verify({
				provider: selection.provider,
				sourceVersion: selection.sourceVersion,
				sourceDigest: selection.sourceDigest,
				archiveDigest: prepared.packageDigest,
				manifestDigest: sha256(prepared.manifestBytes),
				trustRevision: selection.trustRevision,
				approvalRef: selection.approvalRef,
				ownerId: publication?.state.ownerId ?? request.userId,
			});
			const encoded = canonicalSkillPackageSourceProofV1(proof);
			if (
				proof.provider !== selection.provider ||
				proof.sourceVersion !== selection.sourceVersion ||
				proof.sourceDigest !== selection.sourceDigest ||
				proof.trustRevision !== selection.trustRevision ||
				proof.approvalRef !== selection.approvalRef ||
				(!["system", "my_library"].includes(selection.provider) &&
					proof.approvalRef === null)
			)
				fail();
			if (
				source &&
				!Buffer.from(encoded).equals(canonicalSkillPackageSourceProofV1(source))
			)
				fail();
			source ??= Object.freeze(
				JSON.parse(
					Buffer.from(encoded).toString("utf8"),
				) as SkillPackageSourceProofV1,
			);
			const finalPolicy = await policy();
			if (receipt) {
				verifySkillPackageScanReceiptV1(
					receipt,
					prepared,
					sha256(canonicalSkillPackageSourceProofV1(source)),
					selection.policyRevision,
					finalPolicy.maximumReceiptAgeMs,
					publication?.replayed === true,
				);
				if (
					receipt.scannerId !== finalPolicy.scannerId ||
					receipt.engineVersion !== finalPolicy.engineVersion ||
					receipt.rulesetDigest !== finalPolicy.rulesetDigest
				)
					fail();
			}
		};
		const guard = async () => {
			await publication?.guard();
			await validate();
			await publication?.guard();
		};
		try {
			const result = await this.#options.lifecycle.publishPackage(
				request,
				key ??
					`supply-${sha256(
						new TextEncoder().encode(selection.skillVersionId),
					).slice(0, 32)}`,
				selection,
				async (operation) => {
					publication = operation;
					await guard();
					const store = async (
						stage: SkillPackagePublicationStageV1,
						content: Uint8Array,
						evidence: Readonly<Record<string, unknown>> | null = null,
					) => {
						await guard();
						const objectRef = skillPackageObjectRefV1(
							operation.state.operationId,
							stage,
						);
						const mediaType =
							stage === "zip"
								? "application/zip"
								: stage === "signature"
									? "application/octet-stream"
									: "application/json";
						await operation.intend(stage, {
							objectRef,
							mediaType,
							sizeBytes: content.byteLength,
							sha256: sha256(content),
							evidence,
						});
						let object = operation.state.objects[stage];
						if (!object) {
							const stored = await this.#options.storage.upload({
								objectRef,
								descriptor: {
									name:
										stage === "zip"
											? "skill.zip"
											: stage === "signature"
												? "signature.bin"
												: `${stage}.json`,
									mediaType,
									sizeBytes: content.byteLength,
									sha256: sha256(content),
								},
								expiresAt: expiresAt(),
								body: new ReadableStream({
									start(controller) {
										controller.enqueue(content.slice());
										controller.close();
									},
								}),
							});
							object = { objectRef, ...stored };
							if (
								object.sha256 !== sha256(content) ||
								object.sizeBytes !== content.byteLength ||
								object.mediaType !== mediaType
							)
								fail();
							await guard();
							if (!Buffer.from(await this.#read(object)).equals(content))
								fail();
							await guard();
							await operation.save(stage, object);
						}
						if (!Buffer.from(await this.#read(object)).equals(content)) fail();
						await guard();
						return object;
					};
					const zip = await store("zip", prepared.archiveBytes);
					const manifest = await store("manifest", prepared.manifestBytes);
					if (!source) fail();
					const sourceBytes = canonicalSkillPackageSourceProofV1(
						source as SkillPackageSourceProofV1,
					);
					await store("source-proof", sourceBytes, { ...source });
					const savedReceipt = operation.state.intents.scan?.evidence;
					if (savedReceipt)
						receipt = JSON.parse(
							Buffer.from(
								canonicalSkillPackageScanReceiptV1(
									savedReceipt as unknown as SkillPackageScanReceiptV1,
								),
							).toString("utf8"),
						) as SkillPackageScanReceiptV1;
					else {
						await guard();
						receipt = await this.#options.scanner.scan({
							packageDigest: prepared.packageDigest,
							manifestDigest: sha256(prepared.manifestBytes),
							fileCount: prepared.fileCount,
							totalBytes: prepared.totalBytes,
							sourceProofDigest: sha256(sourceBytes),
							policyRevision: selection.policyRevision,
							packageObject: zip,
							name: selection.name,
							version: selection.version,
							openPackage: async () => {
								const content = await this.#read(zip);
								return new ReadableStream({
									start(controller) {
										controller.enqueue(content);
										controller.close();
									},
								});
							},
						});
					}
					// Freeze the original receipt before upload; response loss cannot change scan time on retry.
					receipt = Object.freeze(
						JSON.parse(
							Buffer.from(canonicalSkillPackageScanReceiptV1(receipt)).toString(
								"utf8",
							),
						) as SkillPackageScanReceiptV1,
					);
					await guard();
					const scanBytes = canonicalSkillPackageScanReceiptV1(receipt);
					await store("scan", scanBytes, { ...receipt });
					const signer = (await policy()).signer;
					const recordInput = {
						skillId: selection.skillId,
						skillVersionId: selection.skillVersionId,
						ownerId: operation.state.ownerId,
						provider: selection.provider,
						version: selection.version,
						packageObjectVersion: zip.version,
						packageDigest: prepared.packageDigest,
						manifestDigest: manifest.sha256,
						sourceProofDigest: sha256(sourceBytes),
						scanReceiptDigest: sha256(scanBytes),
						trustRevision: selection.trustRevision,
						policyRevision: selection.policyRevision,
						signingKeyId: signer.keyId,
					};
					const signingBytes = admissionSignatureBytesV1(recordInput);
					const recordBytes = signingBytes.subarray(
						Buffer.byteLength("agent-infra:skill-package-admission:v1\n"),
					);
					await store("signature-record", recordBytes, {
						schemaVersion: 1,
						...recordInput,
					});
					let signature: Uint8Array;
					const savedSignature = operation.state.objects.signature;
					if (savedSignature) signature = await this.#read(savedSignature);
					else signature = sign(null, signingBytes, signer.privateKey);
					verifyAdmissionSignatureV1(
						signingBytes,
						signature,
						(await policy()).signer.publicKey,
					);
					const detached = await store("signature", signature);
					const bundle = {
						schemaVersion: 1,
						operationId: operation.state.operationId,
						ownerId: operation.state.ownerId,
						selection,
						objects: Object.fromEntries(
							skillPackagePublicationStagesV1
								.filter((stage) => stage !== "bundle")
								.map((stage) => [stage, operation.state.objects[stage]]),
						),
					};
					await store("bundle", canonical(bundle), bundle);
					await guard();
					return parseSkillHubRegistrationV1({
						schemaVersion: 1,
						name: selection.name,
						skillId: selection.skillId,
						skillVersionId: selection.skillVersionId,
						visibility: selection.visibility,
						provider: selection.provider,
						version: selection.version,
						packageObjectVersion: zip.version,
						packageDigest: prepared.packageDigest,
						manifestDigest: manifest.sha256,
						signatureDigest: detached.sha256,
						...(Object.hasOwn(selection, "organizationId")
							? { organizationId: selection.organizationId }
							: {}),
					});
				},
				validate,
			);
			return result;
		} catch (error) {
			if (
				error instanceof SkillPackageAdmissionErrorV1 ||
				error instanceof SkillHubOperationErrorV1
			)
				throw error;
			return fail();
		}
	}
}
