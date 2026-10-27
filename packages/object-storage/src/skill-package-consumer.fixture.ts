import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
	parseSkillPackagePublicationSelectionV1,
	parseSkillPackagePublicationStateV1,
	type SkillHubRegistrationV1,
	type SkillPackagePublicationContextV1,
	type SkillPackagePublicationStateV1,
} from "@agent-infra/platform-core";
import { FakeObjectStorageV1 } from "./index.js";
import {
	packSkillProjectSnapshotV1,
	type SkillPackageSourceVerifierV1,
} from "./skill-package-admission.js";
import {
	createSkillPackageConsumerV1,
	type SkillPackageConsumerPolicyV1,
} from "./skill-package-consumer.js";
import { SkillPackageSupplierV1 } from "./skill-package-supplier.js";

const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
/** Controlled supplier with real ZIP, canonical evidence and native Ed25519; scanner is explicitly a fixture. */
export async function publicationFixture(receiptTtlMs = 50_000) {
	const storage = new FakeObjectStorageV1({ contentPolicy: "skill-package" });
	const keys = generateKeyPairSync("ed25519");
	let sourceAllowed = true;
	const sourceVerifier: SkillPackageSourceVerifierV1 = {
		verify: async (i) => {
			if (!sourceAllowed) throw new Error("private-source-denial");
			return {
				schemaVersion: 1,
				provider: i.provider,
				publisherId: i.ownerId,
				sourceVersion: i.sourceVersion,
				sourceDigest: i.sourceDigest,
				approvalRef: i.approvalRef,
				trustRevision: i.trustRevision,
			};
		},
	};
	let policy: SkillPackageConsumerPolicyV1 = {
		policyRevision: "policy-1",
		trustRevision: "trust-1",
		keyId: "key-1",
		keyState: "active",
		publicKey: keys.publicKey,
		maximumReceiptAgeMs: 60_000,
		scannerId: "fixture-scanner",
		engineVersion: "fixture-1",
		rulesetDigest: "a".repeat(64),
		allowInternalWithoutApproval: true,
	};
	let state!: SkillPackagePublicationStateV1;
	let version!: SkillHubRegistrationV1;
	let publications = 0;
	const supplier = new SkillPackageSupplierV1({
		storage,
		sourceVerifier,
		resolveAdmissionPolicy: async () => ({
			...policy,
			signer: {
				...keys,
				keyId: policy.keyId,
				trustRevision: policy.trustRevision,
			},
		}),
		lifecycle: {
			publishPackage: async (_context, _key, raw, work, revalidate) => {
				publications++;
				state = {
					schemaVersion: 1,
					operationId: randomUUID(),
					ownerId: "owner-a",
					selection: parseSkillPackagePublicationSelectionV1(raw),
					intents: {},
					objects: {},
				};
				const context: SkillPackagePublicationContextV1 = {
					get state() {
						return state;
					},
					replayed: false,
					guard: async () => {},
					intend: async (stage, intent) => {
						state = parseSkillPackagePublicationStateV1({
							...state,
							intents: { ...state.intents, [stage]: intent },
						});
					},
					save: async (stage, object) => {
						state = parseSkillPackagePublicationStateV1({
							...state,
							objects: { ...state.objects, [stage]: object },
						});
					},
				};
				version = await work(context);
				await revalidate();
				return {
					replayed: false,
					version: {
						...version,
						ownerId: "owner-a",
						state: "published",
						needUpgrade: false,
						reviewedBy: null,
						reviewReason: null,
						revokedAt: null,
					},
					artifacts: state.objects,
				};
			},
		},
		scanner: {
			scan: async (i) => ({
				schemaVersion: 1,
				scannerId: policy.scannerId,
				engineVersion: policy.engineVersion,
				rulesetDigest: policy.rulesetDigest,
				policyRevision: policy.policyRevision,
				scannedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + receiptTtlMs).toISOString(),
				packageDigest: i.packageDigest,
				manifestDigest: i.manifestDigest,
				scannedFileCount: i.fileCount,
				scannedBytes: i.totalBytes,
				verdict: "clean",
			admissionDecision: "pending_review",
			}),
		},
	});
	const archiveBytes = packSkillProjectSnapshotV1([
		{ path: "SKILL.md", bytes: Buffer.from("# fixture\n") },
		{ path: "references/data.txt", bytes: Buffer.from("fixture resource") },
	]);
	await supplier.admitVersion(
		{
			userId: "owner-a",
			requestId: "fixture-request",
			traceId: "fixture-trace",
		},
		{
			name: "fixture",
			skillId: "skill-a",
			skillVersionId: "version-a",
			visibility: "PRIVATE",
			provider: "my_library",
			version: "1.0.0",
			sourceVersion: "source-1",
			sourceDigest: sha(archiveBytes),
			approvalRef: null,
			trustRevision: policy.trustRevision,
			policyRevision: policy.policyRevision,
			archiveBytes,
		},
	);
	const options = {
		storage,
		readPublication: async () => ({ state, version, ownerId: "owner-a" }),
		sourceVerifier,
		resolveAdmissionPolicy: async () => policy,
	};
	return {
		options,
		get state() {
			return state;
		},
		get version() {
			return version;
		},
		get publications() {
			return publications;
		},
		setState: (value: SkillPackagePublicationStateV1) => {
			state = value;
		},
		setPolicy: (patch: Partial<SkillPackageConsumerPolicyV1>) => {
			policy = { ...policy, ...patch };
		},
		denySource: () => {
			sourceAllowed = false;
		},
		consumer: createSkillPackageConsumerV1(options),
		input: {
			skillVersionId: version.skillVersionId,
			packageObjectVersion: version.packageObjectVersion,
		},
	};
}
