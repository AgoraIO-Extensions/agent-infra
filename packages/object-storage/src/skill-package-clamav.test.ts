import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
} from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseSkillPackagePublicationSelectionV1,
	parseSkillPackagePublicationStateV1,
	type SkillHubRegistrationV1,
	type SkillPackagePublicationContextV1,
	type SkillPackagePublicationPortV1,
	type SkillPackagePublicationStateV1,
} from "@agent-infra/platform-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeObjectStorageV1 } from "./index.js";
import {
	packSkillProjectSnapshotV1,
	prepareSkillPackageV1,
	SkillPackageAdmissionErrorV1,
} from "./skill-package-admission.js";
import { createClamAvSkillPackageScannerV1 } from "./skill-package-clamav.js";
import { SkillPackageSupplierV1 } from "./skill-package-supplier.js";
import { createSkillProjectSourceVerifierV1 } from "./skill-project-source.js";

// Counts bytes the scanner reads from the deployment ruleset, whatever read API it uses.
const ruleset = vi.hoisted(() => ({ root: "\u0000", bytes: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const open: typeof actual.open = async (...args) => {
		const handle = await actual.open(...args);
		if (!String(args[0]).startsWith(ruleset.root)) return handle;
		return new Proxy(handle, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				if (property === "read")
					return async (...input: unknown[]) => {
						const result = await value.apply(target, input);
						ruleset.bytes += result.bytesRead;
						return result;
					};
				if (property === "readFile")
					return async (...input: unknown[]) => {
						const result = await value.apply(target, input);
						ruleset.bytes += Buffer.byteLength(result);
						return result;
					};
				return value.bind(target);
			},
		});
	};
	return { ...actual, open };
});

const sha256 = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");
const settle = () => new Promise((resolve) => setTimeout(resolve, 2_100));
let root: string;
let database: string;
let rulesetBytes: number;
let scannerLog: string;

/** The ruleset digest exactly as the deployed policy pins it: name/length header then all bytes, in name order. */
async function expectedDigest(directory: string) {
	const hash = createHash("sha256");
	for (const name of (await readdir(directory)).toSorted()) {
		const bytes = await readFile(join(directory, name));
		hash.update(JSON.stringify([name, bytes.byteLength])).update(bytes);
	}
	return hash.digest("hex");
}
function scanner(databaseDirectory = database) {
	return createClamAvSkillPackageScannerV1({
		executable: join(root, "clamscan"),
		databaseDirectory,
		stagingRoot: join(root, "staging"),
		scannerId: "native-clamav",
		policyRevision: "policy-1",
		maximumReceiptAgeMs: 300_000,
		timeoutMs: 30_000,
	});
}
async function scannerRecords() {
	const text = await readFile(scannerLog, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; database?: string[][] });
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "skill-clamav-"));
	database = join(root, "database");
	await mkdir(database);
	await mkdir(join(root, "staging"));
	// Synthetic stand-ins for main/daily/bytecode CVDs; sizes are not multiples of any read size.
	for (const [name, size] of [
		["main.cvd", 3_145_731],
		["daily.cvd", 1_048_583],
		["bytecode.cvd", 65_537],
	] as const)
		await writeFile(join(database, name), randomBytes(size));
	rulesetBytes = 3_145_731 + 1_048_583 + 65_537;
	scannerLog = join(root, "scanner.log");
	process.env.FAKE_CLAMSCAN_LOG = scannerLog;
	// Synthetic engine: no ClamAV, network or real signatures. It records the database it was given.
	await writeFile(
		join(root, "clamscan"),
		`#!/usr/bin/env node
const { appendFileSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const args = process.argv.slice(2);
const record = (value) => appendFileSync(process.env.FAKE_CLAMSCAN_LOG, JSON.stringify(value) + "\\n");
if (args.length === 1 && args[0] === "--version") {
	record({ kind: "version" });
	process.stdout.write("ClamAV 1.4.6/27000/synthetic\\n");
	process.exit(0);
}
const database = args.find((value) => value.startsWith("--database=")).slice("--database=".length);
const payload = args[args.length - 1];
record({ kind: "scan", database: readdirSync(database).sort().map((name) =>
	[name, createHash("sha256").update(readFileSync(join(database, name))).digest("hex")]) });
const change = process.env.FAKE_CLAMSCAN_CHANGE_SOURCE;
if (change) { const bytes = readFileSync(change); bytes[0] ^= 0xff; writeFileSync(change, bytes); }
for (const name of readdirSync(payload)) process.stdout.write(join(payload, name) + ": OK\\n");
`,
	);
	await chmod(join(root, "clamscan"), 0o755);
	// Deployed rulesets are copied at Pod start, long before the first publication.
	await settle();
	ruleset.root = database;
});
afterAll(async () => {
	delete process.env.FAKE_CLAMSCAN_LOG;
	delete process.env.FAKE_CLAMSCAN_CHANGE_SOURCE;
	await rm(root, { recursive: true, force: true });
});

/**
 * The normal project publication chain without a database: the real supplier, ClamAV adapter, project source
 * verifier and fake object storage, the deployed API admission policy resolver (readPolicy + scanner.describe,
 * as generated for `providerImport.resolveAdmissionPolicy`) and a lifecycle port that keeps the call pattern of
 * PostgresSkillHubLifecycleV1.publishPackage: guard, work, guard, then revalidate before and after registration.
 */
async function publicationChain(
	hooks: { afterSave?: (stage: string) => Promise<void> } = {},
) {
	const clamav = scanner();
	const pinned = await clamav.describe();
	const keys = generateKeyPairSync("ed25519");
	const counts = { resolutions: 0, scans: 0, registrations: 0 };
	const readPolicy = () => ({
		policyRevision: "policy-1",
		trustRevision: "trust-1",
		keyId: "key-1",
		scannerId: pinned.scannerId,
		engineVersion: pinned.engineVersion,
		rulesetDigest: pinned.rulesetDigest,
		maximumReceiptAgeMs: pinned.maximumReceiptAgeMs,
	});
	const lifecycle: SkillPackagePublicationPortV1 = {
		async publishPackage(context, _key, raw, work, revalidate) {
			const selection = parseSkillPackagePublicationSelectionV1(raw);
			let state: SkillPackagePublicationStateV1 =
				parseSkillPackagePublicationStateV1({
					schemaVersion: 1,
					operationId: randomUUID(),
					ownerId: context.userId,
					selection,
					intents: {},
					objects: {},
				});
			const publication: SkillPackagePublicationContextV1 = {
				get state() {
					return state;
				},
				replayed: false,
				guard: async () => {},
				intend: async (stage, intent) => {
					if (!state.intents[stage])
						state = parseSkillPackagePublicationStateV1({
							...state,
							intents: { ...state.intents, [stage]: intent },
						});
				},
				save: async (stage, object) => {
					if (!state.objects[stage])
						state = parseSkillPackagePublicationStateV1({
							...state,
							objects: { ...state.objects, [stage]: object },
						});
					await hooks.afterSave?.(stage);
				},
			};
			await publication.guard();
			const registration: SkillHubRegistrationV1 = await work(publication);
			await publication.guard();
			await revalidate();
			if (
				registration.admissionDecision !==
				state.intents.scan?.evidence?.admissionDecision
			)
				throw new Error("synthetic store refused the admission decision");
			counts.registrations++;
			await revalidate();
			return {
				replayed: false,
				version: {
					...registration,
					ownerId: context.userId,
					state: "pending_review",
					needUpgrade: false,
					reviewedBy: null,
					reviewReason: null,
					revokedAt: null,
				} as never,
				artifacts: state.objects,
			};
		},
	};
	const supplier = new SkillPackageSupplierV1({
		storage: new FakeObjectStorageV1({ contentPolicy: "skill-package" }),
		lifecycle,
		sourceVerifier: createSkillProjectSourceVerifierV1(),
		scanner: {
			scan: async (input) => {
				counts.scans++;
				return clamav.scan(input);
			},
		},
		async resolveAdmissionPolicy() {
			counts.resolutions++;
			const policy = readPolicy();
			const metadata = await clamav.describe();
			if (
				(
					[
						"scannerId",
						"engineVersion",
						"rulesetDigest",
						"policyRevision",
						"maximumReceiptAgeMs",
					] as const
				).some((key) => metadata[key] !== policy[key])
			)
				throw new Error("synthetic policy unavailable");
			if (JSON.stringify(readPolicy()) !== JSON.stringify(policy))
				throw new Error("synthetic policy unavailable");
			return {
				...metadata,
				signer: {
					keyId: policy.keyId,
					trustRevision: policy.trustRevision,
					privateKey: keys.privateKey,
					publicKey: keys.publicKey,
				},
			};
		},
	});
	const projectId = "project-synthetic";
	const owner = "owner-synthetic";
	const key = `publish-${randomUUID()}`;
	const archiveBytes = packSkillProjectSnapshotV1([
		{
			path: "SKILL.md",
			bytes: Buffer.from(`# Synthetic review\n${"x".repeat(3000)}\n`),
		},
		{ path: "references/a.md", bytes: Buffer.from("a".repeat(4500)) },
		{ path: "references/b.md", bytes: Buffer.from("b".repeat(2700)) },
	]);
	return {
		counts,
		pinned,
		publish: () =>
			supplier.admitVersion(
				{
					userId: owner,
					requestId: "request-synthetic",
					traceId: "trace-synthetic",
				},
				{
					name: "synthetic-review",
					skillId: projectId,
					skillVersionId: `skill-version-${sha256(`project:${projectId}:${owner}:${key}`).slice(0, 48)}`,
					visibility: "PRIVATE",
					provider: "my_library",
					version: "0.1.0-synthetic",
					sourceVersion: `project:${projectId}:r2`,
					sourceDigest: sha256(archiveBytes),
					approvalRef: null,
					trustRevision: "trust-1",
					policyRevision: "policy-1",
					archiveBytes,
				},
				key,
			),
	};
}

describe("ClamAV ruleset description", { timeout: 20_000 }, () => {
	it("describes the pinned ruleset digest and does not re-read an unchanged ruleset", async () => {
		const clamav = scanner();
		ruleset.bytes = 0;
		const first = await clamav.describe();
		expect(first.rulesetDigest).toBe(await expectedDigest(database));
		expect(ruleset.bytes).toBe(rulesetBytes);
		const second = await clamav.describe();
		expect(second).toEqual(first);
		expect(ruleset.bytes).toBe(rulesetBytes);
	});

	it("re-reads files changed shortly before they were read until they have settled", async () => {
		const fresh = join(root, "fresh-database");
		await mkdir(fresh);
		await writeFile(join(fresh, "main.cvd"), randomBytes(70_001));
		const previous = ruleset.root;
		ruleset.root = fresh;
		try {
			const clamav = scanner(fresh);
			ruleset.bytes = 0;
			const first = await clamav.describe();
			const second = await clamav.describe();
			expect(second).toEqual(first);
			expect(ruleset.bytes).toBe(2 * 70_001);
			await settle();
			await clamav.describe();
			expect(ruleset.bytes).toBe(3 * 70_001);
			await clamav.describe();
			expect(ruleset.bytes).toBe(3 * 70_001);
		} finally {
			ruleset.root = previous;
		}
	});

	it.each([
		[
			"rewritten in place with its original size and modification time",
			"in-place",
		],
		["atomically replaced by a file of the same size", "replace"],
		["joined by another ruleset file", "add"],
	] as const)("detects a ruleset %s", async (_name, change) => {
		const directory = join(root, `changed-${change}`);
		await mkdir(directory);
		await writeFile(join(directory, "main.cvd"), randomBytes(50_003));
		await settle();
		const clamav = scanner(directory);
		const before = await clamav.describe();
		const target = join(directory, "main.cvd");
		const original = await stat(target);
		if (change === "in-place") {
			const bytes = await readFile(target);
			bytes[100] = (bytes[100] ?? 0) ^ 0xff;
			await writeFile(target, bytes);
			await utimes(target, original.atime, original.mtime);
		} else if (change === "replace") {
			await writeFile(join(directory, "next.tmp"), randomBytes(50_003));
			await utimes(join(directory, "next.tmp"), original.atime, original.mtime);
			await rename(join(directory, "next.tmp"), target);
		} else await writeFile(join(directory, "extra.ndb"), "Synthetic:0:*:00\n");
		const after = await clamav.describe();
		expect(after.rulesetDigest).not.toBe(before.rulesetDigest);
		expect(after.rulesetDigest).toBe(await expectedDigest(directory));
	});

	it("still scans a full snapshot copy and fails closed if the ruleset changes during the scan", async () => {
		const clamav = scanner();
		const pinned = await clamav.describe();
		expect(pinned.rulesetDigest).toBe(await expectedDigest(database));
		const archive = packSkillProjectSnapshotV1([
			{ path: "SKILL.md", bytes: Buffer.from("# snapshot\n") },
		]);
		const storage = new FakeObjectStorageV1({ contentPolicy: "skill-package" });
		const objectRef = randomUUID();
		const stored = await storage.upload({
			objectRef,
			descriptor: {
				name: "skill.zip",
				mediaType: "application/zip",
				sizeBytes: archive.byteLength,
				sha256: sha256(archive),
			},
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(archive.slice());
					controller.close();
				},
			}),
		});
		const prepared = prepareSkillPackageV1({
			archiveBytes: archive,
			name: "snapshot",
			version: "1.0.0",
		});
		const input = {
			name: "snapshot",
			version: "1.0.0",
			packageDigest: prepared.packageDigest,
			manifestDigest: sha256(prepared.manifestBytes),
			fileCount: prepared.fileCount,
			totalBytes: prepared.totalBytes,
			sourceProofDigest: "c".repeat(64),
			policyRevision: "policy-1",
			packageObject: { objectRef, ...stored },
			openPackage: async () =>
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(archive.slice());
						controller.close();
					},
				}),
		};
		await writeFile(scannerLog, "");
		ruleset.bytes = 0;
		const receipt = await clamav.scan(input);
		expect(receipt.rulesetDigest).toBe(pinned.rulesetDigest);
		expect(ruleset.bytes).toBe(rulesetBytes);
		const [scan] = (await scannerRecords()).filter(
			(row) => row.kind === "scan",
		);
		const source = await Promise.all(
			(await readdir(database))
				.toSorted()
				.map(async (name) => [
					name,
					sha256(await readFile(join(database, name))),
				]),
		);
		expect(scan?.database).toEqual(source);
		process.env.FAKE_CLAMSCAN_CHANGE_SOURCE = join(database, "bytecode.cvd");
		try {
			await expect(clamav.scan(input)).rejects.toMatchObject({
				code: "scan_unavailable",
			});
		} finally {
			delete process.env.FAKE_CLAMSCAN_CHANGE_SOURCE;
		}
		await settle();
	});
});

describe("project publication chain over the ClamAV adapter", {
	timeout: 20_000,
}, () => {
	it("reads the complete ruleset only for the scan snapshot while every guard re-checks the policy", async () => {
		const chain = await publicationChain();
		ruleset.bytes = 0;
		const result = await chain.publish();
		expect(result.version.state).toBe("pending_review");
		expect(chain.counts).toMatchObject({ scans: 1, registrations: 1 });
		// Every guard, the scan, the signature and registration still resolve the current policy.
		expect(chain.counts.resolutions).toBeGreaterThanOrEqual(60);
		expect(ruleset.bytes / rulesetBytes).toBe(1);
	});

	it.each([
		[
			"rewritten in place with its original size and modification time",
			"in-place",
		],
		["atomically replaced by a file of the same size", "replace"],
	] as const)(
		"fails closed when the ruleset is %s after the package was stored",
		async (_name, change) => {
			const target = join(database, "daily.cvd");
			const chain = await publicationChain({
				afterSave: async (stage) => {
					if (stage !== "zip") return;
					const original = await stat(target);
					const bytes = await readFile(target);
					bytes[7] = (bytes[7] ?? 0) ^ 0xff;
					if (change === "in-place") await writeFile(target, bytes);
					else {
						await writeFile(join(root, "daily.next"), bytes);
						await rename(join(root, "daily.next"), target);
					}
					await utimes(target, original.atime, original.mtime);
				},
			});
			await expect(chain.publish()).rejects.toBeInstanceOf(
				SkillPackageAdmissionErrorV1,
			);
			expect(chain.counts).toMatchObject({ scans: 0, registrations: 0 });
			await settle();
		},
	);
});
