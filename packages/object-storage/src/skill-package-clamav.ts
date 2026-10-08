import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	prepareSkillPackageV1,
	SkillPackageAdmissionErrorV1,
	type SkillPackageScannerV1,
} from "./skill-package-admission.js";

const execFile = promisify(callback);
const failure = (): never => {
	throw new SkillPackageAdmissionErrorV1("scan_unavailable");
};
/** Native scanner; deployment paths are never accepted from Skill publication input. */
export function createClamAvSkillPackageScannerV1(
	options: Readonly<{
		executable: string;
		databaseDirectory: string;
		scannerId: string;
		policyRevision: string;
		maximumReceiptAgeMs: number;
		timeoutMs: number;
		stagingRoot?: string;
	}>,
) {
	if (
		!options.executable ||
		!options.databaseDirectory ||
		!options.scannerId ||
		!options.policyRevision ||
		!Number.isSafeInteger(options.maximumReceiptAgeMs) ||
		options.maximumReceiptAgeMs < 1 ||
		options.maximumReceiptAgeMs > 86_400_000 ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > 300_000
	)
		failure();
	const run = (args: string[]) =>
		execFile(options.executable, args, {
			timeout: options.timeoutMs,
			maxBuffer: 2_000_000,
			encoding: "utf8",
		});
	const describe = async (snapshotDirectory?: string) => {
		const engine = await run(["--version"]);
		const engineVersion = engine.stdout.trim();
		if (
			!/^ClamAV [0-9][^\r\n]{0,255}$/.test(engineVersion) ||
			engine.stderr.length
		)
			failure();
		const directory = await readdir(options.databaseDirectory, {
			withFileTypes: true,
		});
		const names = directory.map((item) => item.name).toSorted();
		if (
			!names.length ||
			names.length > 64 ||
			directory.some(
				(item) =>
					!item.isFile() ||
					!/^[A-Za-z0-9._-]+\.(?:cvd|cld|ndb|hdb|hsb|ldb|mdb|msb|sfp|fp|pdb|wdb|cdb|ign|ign2|yar|yara)$/.test(
						item.name,
					),
			)
		)
			failure();
		const hash = createHash("sha256");
		let total = 0;
		for (const name of names) {
			const file = await open(
				join(options.databaseDirectory, name),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				const info = await file.stat();
				if (
					!info.isFile() ||
					info.size > 512_000_000 ||
					total + info.size > 512_000_000
				)
					failure();
				const content = await file.readFile();
				total += content.byteLength;
				if (content.byteLength !== info.size) failure();
				hash.update(JSON.stringify([name, content.byteLength])).update(content);
				if (snapshotDirectory)
					await writeFile(join(snapshotDirectory, name), content, {
						flag: "wx",
						mode: 0o600,
					});
			} finally {
				await file.close();
			}
		}
		return Object.freeze({
			scannerId: options.scannerId,
			engineVersion,
			rulesetDigest: hash.digest("hex"),
			policyRevision: options.policyRevision,
			maximumReceiptAgeMs: options.maximumReceiptAgeMs,
		});
	};
	const scanner: SkillPackageScannerV1 = {
		async scan(input) {
			let staging: string | undefined;
			try {
				staging = await mkdtemp(
					join(options.stagingRoot ?? tmpdir(), "agent-infra-skill-scan-"),
				);
				const databaseDirectory = join(staging, "database");
				const payloadDirectory = join(staging, "payload");
				await mkdir(databaseDirectory, { mode: 0o700 });
				await mkdir(payloadDirectory, { mode: 0o700 });
				const metadata = await describe(databaseDirectory);
				if (input.policyRevision !== metadata.policyRevision) failure();
				const stream = await input.openPackage();
				const reader = stream.getReader();
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				try {
					while (true) {
						const next = await reader.read();
						if (next.done) break;
						bytes += next.value.byteLength;
						if (bytes > 50_000_000 || bytes > input.packageObject.sizeBytes)
							failure();
						chunks.push(next.value);
					}
				} finally {
					await reader.cancel().catch(() => {});
					reader.releaseLock();
				}
				const archiveBytes = Buffer.concat(chunks);
				const prepared = prepareSkillPackageV1({
					archiveBytes,
					name: input.name,
					version: input.version,
				});
				if (
					prepared.packageDigest !== input.packageDigest ||
					prepared.packageDigest !== input.packageObject.sha256 ||
					bytes !== input.packageObject.sizeBytes ||
					createHash("sha256").update(prepared.manifestBytes).digest("hex") !==
						input.manifestDigest ||
					prepared.fileCount !== input.fileCount ||
					prepared.totalBytes !== input.totalBytes
				)
					failure();
				const paths: string[] = [];
				for (const [index, file] of prepared.files.entries()) {
					const path = join(payloadDirectory, `payload-${index}`);
					paths.push(path);
					await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
				}
				let report!: { stdout: string; stderr: string };
				try {
					report = await run([
						`--database=${databaseDirectory}`,
						"--stdout",
						"--no-summary",
						"--disable-cache=yes",
						"--alert-exceeds-max=yes",
						"--alert-encrypted=yes",
						"--max-filesize=50000000",
						"--max-scansize=50000000",
						"--max-files=2000",
						"--max-recursion=16",
						payloadDirectory,
					]);
				} catch (error) {
					if (
						typeof error === "object" &&
						error !== null &&
						"code" in error &&
						(error as { code?: unknown }).code === 1
					)
						throw new SkillPackageAdmissionErrorV1("scan_rejected");
					failure();
				}
				if (report.stderr.length) failure();
				const responses = report.stdout.trim().split(/\r?\n/);
				if (
					responses.length !== paths.length ||
					paths.some(
						(path) =>
							!responses.includes(`${path}: OK`) &&
							!responses.includes(`${path}: Empty file`),
					)
				)
					failure();
				const current = await describe();
				if (JSON.stringify(current) !== JSON.stringify(metadata)) failure();
				const scannedAt = new Date();
				return Object.freeze({
					schemaVersion: 1,
					scannerId: metadata.scannerId,
					engineVersion: metadata.engineVersion,
					rulesetDigest: metadata.rulesetDigest,
					policyRevision: metadata.policyRevision,
					scannedAt: scannedAt.toISOString(),
					expiresAt: new Date(
						scannedAt.getTime() + options.maximumReceiptAgeMs,
					).toISOString(),
					packageDigest: input.packageDigest,
					manifestDigest: input.manifestDigest,
					scannedFileCount: prepared.fileCount,
					scannedBytes: prepared.totalBytes,
					verdict: "clean",
				});
			} catch (error) {
				if (error instanceof SkillPackageAdmissionErrorV1) throw error;
				return failure();
			} finally {
				if (staging)
					await rm(staging, { recursive: true, force: true }).catch(() => {
						/* Preserve the scan verdict; deployment cleanup reconciles the owned staging root. */
					});
			}
		},
	};
	return Object.freeze({
		...scanner,
		describe: async () => {
			try {
				return await describe();
			} catch {
				return failure();
			}
		},
	});
}
