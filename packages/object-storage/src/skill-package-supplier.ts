import { createHash, sign } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	parseSkillHubIdentitySnapshotV1,
	type SkillHubRequestV1,
	type SkillHubVersionV1,
	type SkillPackageAdmissionSignerV1,
	type SkillPackageScannerV1,
	type SkillPackageSourceProofV1,
	type SkillPackageSourceVerifierV1,
	skillPackageObjectRefV1,
} from "@agent-infra/platform-core";
import {
	admissionSignatureBytesV1,
	canonicalSkillPackageScanReceiptV1,
	canonicalSkillPackageSourceProofV1,
	prepareSkillPackageV1,
	verifyAdmissionSignatureV1,
	verifySkillPackageScanReceiptV1,
} from "./skill-package-admission.js";
import type { ObjectStorageDataV1 } from "./types.js";

const expiresAt = () => new Date(Date.now() + 300_000).toISOString();
const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
function bytes(body: Uint8Array) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(body.slice());
			controller.close();
		},
	});
}
function assertText(value: unknown, maximum = 1024): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		[...value].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || code === 0x7f;
		})
	)
		throw new Error("invalid package evidence");
}
function assertSourceProof(
	value: SkillPackageSourceProofV1,
	input: SkillPackageSupplyInputV1,
) {
	if (
		value.schemaVersion !== 1 ||
		value.provider !== input.provider ||
		value.sourceVersion !== input.sourceVersion ||
		value.sourceDigest !== input.sourceDigest ||
		value.trustRevision !== input.trustRevision ||
		(value.approvalRef !== null && typeof value.approvalRef !== "string") ||
		(input.provider !== "system" &&
			input.provider !== "my_library" &&
			value.approvalRef === null)
	)
		throw new Error("untrusted package source");
	assertText(value.publisherId);
	assertText(value.provider);
	assertText(value.sourceVersion);
	assertText(value.sourceDigest);
	assertText(value.trustRevision);
	if (
		value.approvalRef !== null &&
		(!validEvidenceText(value.approvalRef, 256) ||
			!/^[A-Za-z0-9._:-]+$/.test(value.approvalRef))
	)
		throw new Error("invalid package approval");
}

function validEvidenceText(value: string, maximum: number) {
	return (
		value.length > 0 &&
		value.length <= maximum &&
		[...value].every((character) => {
			const code = character.codePointAt(0) ?? 0;
			return (
				code > 0x1f && code !== 0x7f && !(code >= 0xd800 && code <= 0xdfff)
			);
		})
	);
}

export type SkillPackageSupplyInputV1 = Readonly<{
	name: string;
	skillId: string;
	skillVersionId: string;
	visibility: "PRIVATE" | "MEMBER" | "ORGANIZATION" | "MARKET";
	provider:
		| "system"
		| "my_library"
		| "market"
		| "clawhub"
		| "skillhub"
		| "npx"
		| "github";
	version: string;
	sourceVersion: string;
	sourceDigest: string;
	approvalRef: string | null;
	trustRevision: string;
	policyRevision: string;
	archiveBytes: Uint8Array;
}>;

export interface SkillHubLifecyclePortV1 {
	registerVersion(
		context: SkillHubRequestV1,
		key: string,
		input: unknown,
	): Promise<{ replayed: boolean; version: SkillHubVersionV1 }>;
}

export interface SkillPackageSupplierOptionsV1 {
	readonly storage: ObjectStorageDataV1 & {
		upload(request: {
			objectRef: string;
			descriptor: {
				name: string;
				mediaType: string;
				sizeBytes: number;
				sha256: string;
			};
			expiresAt: string;
			body: ReadableStream<Uint8Array>;
		}): Promise<{
			sizeBytes: number;
			mediaType: string;
			sha256: string;
			etag: string;
			version: string;
		}>;
		download(request: {
			objectRef: string;
			version: string;
			etag: string;
			expiresAt: string;
		}): Promise<ReadableStream<Uint8Array>>;
	};
	readonly lifecycle: SkillHubLifecyclePortV1;
	readonly resolveIdentity: (userId: string) => Promise<unknown>;
	readonly resolvePolicyRevision: () => Promise<string>;
	readonly sourceVerifier: SkillPackageSourceVerifierV1;
	readonly scanner: SkillPackageScannerV1;
	readonly signer: SkillPackageAdmissionSignerV1;
}

export class SkillPackageSupplierV1 {
	readonly #options: SkillPackageSupplierOptionsV1;
	constructor(options: SkillPackageSupplierOptionsV1) {
		this.#options = options;
	}

	async #upload(
		ref: string,
		name: string,
		mediaType: string,
		body: Uint8Array,
	) {
		const descriptor = {
			name,
			mediaType,
			sizeBytes: body.byteLength,
			sha256: sha256(body),
		};
		const stored = await this.#options.storage.upload({
			objectRef: ref,
			descriptor,
			expiresAt: expiresAt(),
			body: bytes(body),
		});
		if (
			stored.sha256 !== descriptor.sha256 ||
			stored.sizeBytes !== descriptor.sizeBytes ||
			stored.mediaType !== descriptor.mediaType
		)
			throw new Error("package object verification failed");
		const inspected = await this.#options.storage.inspect(ref);
		if (
			!inspected ||
			inspected.version !== stored.version ||
			inspected.etag !== stored.etag
		)
			throw new Error("package object version unavailable");
		return { ref, descriptor, stored };
	}
	async #readJson(ref: string) {
		const stored = await this.#options.storage.inspect(ref);
		if (!stored) return null;
		try {
			const stream = await this.#options.storage.download({
				objectRef: ref,
				version: stored.version,
				etag: stored.etag,
				expiresAt: expiresAt(),
			});
			return {
				value: JSON.parse(await new Response(stream).text()) as Record<
					string,
					unknown
				>,
				stored,
			};
		} catch {
			throw new Error("package evidence unavailable");
		}
	}

	async admitVersion(
		context: SkillHubRequestV1,
		input: SkillPackageSupplyInputV1,
	) {
		const identity = parseSkillHubIdentitySnapshotV1(
			await this.#options.resolveIdentity(context.userId),
			context.userId,
		);
		if (identity.actor.userId !== context.userId)
			throw new Error("identity unavailable");
		if (input.trustRevision !== this.#options.signer.trustRevision)
			throw new Error("package trust policy changed");
		if ((await this.#options.resolvePolicyRevision()) !== input.policyRevision)
			throw new Error("package scan policy changed");
		const prepared = prepareSkillPackageV1(input);
		const source = await this.#options.sourceVerifier.verify({
			provider: input.provider,
			sourceVersion: input.sourceVersion,
			sourceDigest: input.sourceDigest,
			trustRevision: input.trustRevision,
			approvalRef: input.approvalRef,
		});
		assertSourceProof(source, input);
		const sourceBytes = canonicalSkillPackageSourceProofV1(source);
		const sourceProofDigest = sha256(sourceBytes);
		const manifestDigest = sha256(prepared.manifestBytes);
		const existingBundleRecord = await this.#readJson(
			skillPackageObjectRefV1(prepared.packageDigest, "bundle"),
		);
		const existingBundle = existingBundleRecord?.value;
		if (existingBundle) {
			if (
				existingBundle.schemaVersion !== 1 ||
				existingBundle.packageDigest !== prepared.packageDigest ||
				existingBundle.manifestDigest !== manifestDigest ||
				existingBundle.sourceProofDigest !== sourceProofDigest ||
				existingBundle.policyRevision !== input.policyRevision ||
				existingBundle.name !== input.name ||
				existingBundle.skillId !== input.skillId ||
				existingBundle.skillVersionId !== input.skillVersionId ||
				existingBundle.ownerId !== identity.actor.userId ||
				existingBundle.provider !== input.provider ||
				existingBundle.version !== input.version ||
				existingBundle.visibility !== input.visibility ||
				existingBundle.trustRevision !== input.trustRevision ||
				typeof existingBundle.signingKeyId !== "string" ||
				typeof existingBundle.scanReceiptDigest !== "string" ||
				typeof existingBundle.packageObjectVersion !== "string" ||
				typeof existingBundle.signatureDigest !== "string"
			)
				throw new Error("package bundle conflict");
			const scanObjectRecord = await this.#readJson(
				skillPackageObjectRefV1(prepared.packageDigest, "scan-receipt"),
			);
			const scanObject = scanObjectRecord?.value;
			if (!scanObject) throw new Error("package scan evidence unavailable");
			verifySkillPackageScanReceiptV1(
				scanObject as never,
				prepared,
				sourceProofDigest,
				input.policyRevision,
			);
			const signatureStored = await this.#options.storage.inspect(
				skillPackageObjectRefV1(prepared.packageDigest, "signature"),
			);
			if (!signatureStored) throw new Error("package signature unavailable");
			const signatureStream = await this.#options.storage.download({
				objectRef: skillPackageObjectRefV1(prepared.packageDigest, "signature"),
				version: signatureStored.version,
				etag: signatureStored.etag,
				expiresAt: expiresAt(),
			});
			const signature = new Uint8Array(
				await new Response(signatureStream).arrayBuffer(),
			);
			verifyAdmissionSignatureV1(
				admissionSignatureBytesV1({
					packageObjectVersion: existingBundle.packageObjectVersion as string,
					skillId: input.skillId,
					skillVersionId: input.skillVersionId,
					ownerId: identity.actor.userId,
					provider: input.provider,
					version: input.version,
					packageDigest: prepared.packageDigest,
					manifestDigest,
					sourceProofDigest,
					scanReceiptDigest: existingBundle.scanReceiptDigest as string,
					trustRevision: input.trustRevision,
					policyRevision: input.policyRevision,
					signingKeyId: existingBundle.signingKeyId as string,
				}),
				signature,
				this.#options.signer.publicKey,
			);
			const currentIdentity = parseSkillHubIdentitySnapshotV1(
				await this.#options.resolveIdentity(context.userId),
				context.userId,
			);
			if (!isDeepStrictEqual(identity, currentIdentity))
				throw new Error("identity changed during package admission");
			if (
				(await this.#options.resolvePolicyRevision()) !== input.policyRevision
			)
				throw new Error("package scan policy changed");
			const registered = await this.#options.lifecycle.registerVersion(
				context,
				`supply-${input.skillVersionId}`,
				{
					schemaVersion: 1,
					name: input.name,
					skillId: input.skillId,
					skillVersionId: input.skillVersionId,
					visibility: input.visibility,
					provider: input.provider,
					version: input.version,
					packageObjectVersion: existingBundle.packageObjectVersion,
					packageDigest: prepared.packageDigest,
					manifestDigest,
					signatureDigest: existingBundle.signatureDigest,
				},
			);
			return Object.freeze({
				...registered,
				artifacts: {
					...existingBundle,
					packageObjectRef: skillPackageObjectRefV1(
						prepared.packageDigest,
						"zip",
					),
					manifestObjectRef: skillPackageObjectRefV1(
						prepared.packageDigest,
						"manifest",
					),
					sourceProofObjectRef: skillPackageObjectRefV1(
						prepared.packageDigest,
						"source-proof",
					),
					scanReceiptObjectRef: skillPackageObjectRefV1(
						prepared.packageDigest,
						"scan-receipt",
					),
					signatureObjectRef: skillPackageObjectRefV1(
						prepared.packageDigest,
						"signature",
					),
					bundleObjectRef: skillPackageObjectRefV1(
						prepared.packageDigest,
						"bundle",
					),
				},
			});
		}
		const scan = await this.#options.scanner.scan({
			packageDigest: prepared.packageDigest,
			manifestDigest,
			fileCount: prepared.fileCount,
			totalBytes: prepared.totalBytes,
			sourceProofDigest,
			policyRevision: input.policyRevision,
		});
		verifySkillPackageScanReceiptV1(
			scan,
			prepared,
			sourceProofDigest,
			input.policyRevision,
		);
		const scanBytes = canonicalSkillPackageScanReceiptV1(scan);
		const zipObject = await this.#upload(
			skillPackageObjectRefV1(prepared.packageDigest, "zip"),
			`${input.name}-${input.version}.zip`,
			"application/zip",
			prepared.archiveBytes,
		);
		await this.#upload(
			skillPackageObjectRefV1(prepared.packageDigest, "manifest"),
			`${input.name}-${input.version}.manifest.json`,
			"application/json",
			prepared.manifestBytes,
		);
		await this.#upload(
			skillPackageObjectRefV1(prepared.packageDigest, "source-proof"),
			`${input.name}-${input.version}.source.json`,
			"application/json",
			sourceBytes,
		);
		await this.#upload(
			skillPackageObjectRefV1(prepared.packageDigest, "scan-receipt"),
			`${input.name}-${input.version}.scan.json`,
			"application/json",
			scanBytes,
		);
		const signaturePayload = admissionSignatureBytesV1({
			packageObjectVersion: zipObject.stored.version,
			skillId: input.skillId,
			skillVersionId: input.skillVersionId,
			ownerId: identity.actor.userId,
			provider: input.provider,
			version: input.version,
			packageDigest: prepared.packageDigest,
			manifestDigest,
			sourceProofDigest,
			scanReceiptDigest: sha256(scanBytes),
			trustRevision: input.trustRevision,
			policyRevision: input.policyRevision,
			signingKeyId: this.#options.signer.keyId,
		});
		const signature = sign(
			null,
			signaturePayload,
			this.#options.signer.privateKey,
		);
		verifyAdmissionSignatureV1(
			signaturePayload,
			signature,
			this.#options.signer.publicKey,
		);
		const signatureObject = await this.#upload(
			skillPackageObjectRefV1(prepared.packageDigest, "signature"),
			`${input.name}-${input.version}.sig`,
			"application/octet-stream",
			signature,
		);
		const bundleObject = await this.#upload(
			skillPackageObjectRefV1(prepared.packageDigest, "bundle"),
			`${input.name}-${input.version}.bundle.json`,
			"application/json",
			new TextEncoder().encode(
				JSON.stringify({
					schemaVersion: 1,
					packageDigest: prepared.packageDigest,
					manifestDigest,
					package: zipObject.stored,
					manifest: await this.#options.storage.inspect(
						skillPackageObjectRefV1(prepared.packageDigest, "manifest"),
					),
					sourceProof: await this.#options.storage.inspect(
						skillPackageObjectRefV1(prepared.packageDigest, "source-proof"),
					),
					scanReceipt: await this.#options.storage.inspect(
						skillPackageObjectRefV1(prepared.packageDigest, "scan-receipt"),
					),
					signature: signatureObject.stored,
					sourceProofDigest,
					scanReceiptDigest: sha256(scanBytes),
					signatureDigest: sha256(signature),
					policyRevision: input.policyRevision,
					name: input.name,
					skillId: input.skillId,
					skillVersionId: input.skillVersionId,
					ownerId: identity.actor.userId,
					provider: input.provider,
					version: input.version,
					visibility: input.visibility,
					trustRevision: input.trustRevision,
					signingKeyId: this.#options.signer.keyId,
					packageObjectRef: zipObject.ref,
					manifestObjectRef: skillPackageObjectRefV1(
						prepared.packageDigest,
						"manifest",
					),
					sourceProofObjectRef: skillPackageObjectRefV1(
						prepared.packageDigest,
						"source-proof",
					),
					scanReceiptObjectRef: skillPackageObjectRefV1(
						prepared.packageDigest,
						"scan-receipt",
					),
					signatureObjectRef: signatureObject.ref,
					packageObjectVersion: zipObject.stored.version,
				}),
			),
		);
		const currentIdentity = parseSkillHubIdentitySnapshotV1(
			await this.#options.resolveIdentity(context.userId),
			context.userId,
		);
		if (!isDeepStrictEqual(identity, currentIdentity))
			throw new Error("identity changed during package admission");
		if ((await this.#options.resolvePolicyRevision()) !== input.policyRevision)
			throw new Error("package scan policy changed");
		const registered = await this.#options.lifecycle.registerVersion(
			context,
			`supply-${input.skillVersionId}`,
			{
				schemaVersion: 1,
				name: input.name,
				skillId: input.skillId,
				skillVersionId: input.skillVersionId,
				visibility: input.visibility,
				provider: input.provider,
				version: input.version,
				packageObjectVersion: zipObject.stored.version,
				packageDigest: prepared.packageDigest,
				manifestDigest,
				signatureDigest: sha256(signature),
			},
		);
		return Object.freeze({
			...registered,
			artifacts: Object.freeze({
				packageObjectRef: zipObject.ref,
				manifestObjectRef: skillPackageObjectRefV1(
					prepared.packageDigest,
					"manifest",
				),
				sourceProofObjectRef: skillPackageObjectRefV1(
					prepared.packageDigest,
					"source-proof",
				),
				scanReceiptObjectRef: skillPackageObjectRefV1(
					prepared.packageDigest,
					"scan-receipt",
				),
				signatureObjectRef: signatureObject.ref,
				bundleObjectRef: bundleObject.ref,
				bundleObjectVersion: bundleObject.stored.version,
				packageObjectVersion: zipObject.stored.version,
				trustRevision: this.#options.signer.trustRevision,
				policyRevision: input.policyRevision,
			}),
		});
	}
}
