import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	prepareSkillPackageV1,
	SkillPackageAdmissionErrorV1,
	type SkillPackageScannerV1,
	type SkillPackageScanReceiptV1,
} from "./skill-package-admission.js";
import {
	decideSkillPackageAdmissionV1,
	type SkillPackageReviewPolicyV1,
} from "./skill-package-review-policy.js";

const execFile = promisify(callback);
const fail = (code: "scan_unavailable" | "scan_rejected"): never => {
	throw new SkillPackageAdmissionErrorV1(code);
};

/** Runs pinned NVIDIA SkillSpector static analysis without executing the Skill. */
export function createSkillSpectorSkillPackageScannerV1(options: Readonly<{
	executable: string;
	scannerId: string;
	engineVersion: string;
	rulesetDigest: string;
	policyRevision: string;
	maximumReceiptAgeMs: number;
	timeoutMs: number;
	reviewPolicy: SkillPackageReviewPolicyV1;
	stagingRoot?: string;
}>) {
	if (
		!options.executable ||
		!options.scannerId ||
		!options.engineVersion ||
		!/^[a-f0-9]{64}$/.test(options.rulesetDigest) ||
		!options.policyRevision ||
		options.reviewPolicy.policyRevision !== options.policyRevision ||
		!Number.isSafeInteger(options.maximumReceiptAgeMs) ||
		options.maximumReceiptAgeMs < 1 ||
		options.maximumReceiptAgeMs > 86_400_000 ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > 300_000
	)
		fail("scan_unavailable");
	const scanner: SkillPackageScannerV1 = {
		async scan(input): Promise<SkillPackageScanReceiptV1> {
			let staging: string | undefined;
			try {
				if (input.policyRevision !== options.policyRevision) fail("scan_unavailable");
				staging = await mkdtemp(
					join(options.stagingRoot ?? tmpdir(), "agent-infra-skillspector-"),
				);
				const payload = join(staging, "payload");
				await mkdir(payload, { recursive: true, mode: 0o700 });
				const stream = await input.openPackage();
				const reader = stream.getReader();
				const chunks: Uint8Array[] = [];
				try {
					while (true) {
						const next = await reader.read();
						if (next.done) break;
						chunks.push(next.value);
					}
				} finally {
					await reader.cancel().catch(() => {});
					reader.releaseLock();
				}
				const prepared = prepareSkillPackageV1({
					archiveBytes: Buffer.concat(chunks),
					name: input.name,
					version: input.version,
				});
				if (
					prepared.packageDigest !== input.packageDigest ||
					prepared.packageDigest !== input.packageObject.sha256 ||
					prepared.fileCount !== input.fileCount ||
					prepared.totalBytes !== input.totalBytes ||
					createHash("sha256").update(prepared.manifestBytes).digest("hex") !==
						input.manifestDigest
				)
					fail("scan_unavailable");
				for (const file of prepared.files) {
					const target = join(payload, file.path);
					await mkdir(dirname(target), { recursive: true, mode: 0o700 });
					await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
				}
				let stdout = "";
				try {
					({ stdout } = await execFile(
						options.executable,
						["scan", payload, "--no-llm", "--format", "json", "--output", "-"],
						{ timeout: options.timeoutMs, maxBuffer: 4_000_000, encoding: "utf8" },
					));
				} catch (error) {
					if (
						typeof error === "object" &&
						error !== null &&
						"code" in error &&
						(error as { code?: unknown }).code === 1
					)
						fail("scan_rejected");
					fail("scan_unavailable");
				}
				let report: unknown;
				try {
					report = JSON.parse(stdout);
				} catch {
					fail("scan_unavailable");
				}
				const reportObject =
					report && typeof report === "object"
						? (report as {
								risk_assessment?: { recommendation?: unknown };
								findings?: unknown;
								filtered_findings?: unknown;
								components?: unknown;
								metadata?: { coverage_complete?: unknown };
						  })
						: undefined;
				const assessment =
					report && typeof report === "object"
						? (report as {
								risk_assessment?: { recommendation?: unknown };
								metadata?: { llm_requested?: unknown };
						  }).risk_assessment
						: undefined;
				const recommendation = assessment?.recommendation;
				if (
					recommendation !== "SAFE" &&
					recommendation !== "CAUTION" &&
					recommendation !== "DO_NOT_INSTALL"
				)
					fail("scan_unavailable");
				const typedRecommendation = recommendation as
					| "SAFE"
					| "CAUTION"
					| "DO_NOT_INSTALL";
				const rawFindings = Array.isArray(reportObject?.findings)
					? reportObject.findings
					: Array.isArray(reportObject?.filtered_findings)
						? reportObject.filtered_findings
						: [];
				const findings = rawFindings.flatMap((item) => {
					if (!item || typeof item !== "object") return [];
					const value = item as Record<string, unknown>;
					const ruleId = value.rule_id ?? value.ruleId;
					const category = value.category;
					const severity = value.severity;
					if (
						typeof ruleId !== "string" ||
						typeof category !== "string" ||
						(severity !== "LOW" &&
							severity !== "MEDIUM" &&
							severity !== "HIGH" &&
							severity !== "CRITICAL")
					)
						return [];
					return [{
						ruleId,
						category,
						severity,
						deterministic: value.deterministic !== false,
					}];
				});
				const decision = decideSkillPackageAdmissionV1({
					policy: options.reviewPolicy,
					assessment: {
						schemaVersion: 1,
						scannerId: options.scannerId,
						engineVersion: options.engineVersion,
						rulesetDigest: options.rulesetDigest,
						policyRevision: options.policyRevision,
						packageDigest: input.packageDigest,
						manifestDigest: input.manifestDigest,
						scannedFileCount: prepared.fileCount,
						scannedBytes: prepared.totalBytes,
						scannedAt: new Date().toISOString(),
						expiresAt: new Date(
							Date.now() + options.maximumReceiptAgeMs,
						).toISOString(),
						coverageComplete:
							reportObject?.metadata?.coverage_complete !== false &&
							Array.isArray(reportObject?.components),
						recommendation: typedRecommendation,
						scanMode: "static",
						findings,
					},
				});
				if (decision.decision === "rejected") fail("scan_rejected");
				const admissionDecision: "auto_published" | "pending_review" =
					decision.decision === "auto_published" ||
					decision.decision === "pending_review"
						? decision.decision
						: fail("scan_rejected");
				const scannedAt = new Date();
				return Object.freeze({
					schemaVersion: 1,
					scannerId: options.scannerId,
					engineVersion: options.engineVersion,
					rulesetDigest: options.rulesetDigest,
					policyRevision: options.policyRevision,
					scannedAt: scannedAt.toISOString(),
					expiresAt: new Date(
						scannedAt.getTime() + options.maximumReceiptAgeMs,
					).toISOString(),
					packageDigest: input.packageDigest,
					manifestDigest: input.manifestDigest,
					scannedFileCount: prepared.fileCount,
					scannedBytes: prepared.totalBytes,
					verdict: "clean" as const,
					admissionDecision,
				});
			} catch (error) {
				if (error instanceof SkillPackageAdmissionErrorV1) throw error;
				throw new SkillPackageAdmissionErrorV1("scan_unavailable");
			} finally {
				if (staging)
					await rm(staging, { recursive: true, force: true }).catch(() => {});
			}
		},
	};
	return Object.freeze(scanner);
}
