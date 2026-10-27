import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	prepareSkillPackageV1,
	SkillPackageAdmissionErrorV1,
	type SkillPackageScannerV1,
	type SkillPackageScanReceiptV1,
} from "./skill-package-admission.js";

const execFile = promisify(callback);

export type SkillSpectorFindingV1 = Readonly<{
	code: string;
	severity: "info" | "low" | "medium" | "high" | "critical";
	category: "static" | "supply_chain" | "semantic" | "dynamic";
}>;

export type SkillSpectorScanReportV1 = Readonly<{
	schemaVersion: 1;
	scannerId: string;
	engineVersion: string;
	rulesetDigest: string;
	policyRevision: string;
	packageDigest: string;
	manifestDigest: string;
	issuedAt: string;
	coverage: "complete" | "incomplete";
	findingCount: number;
	findings: readonly SkillSpectorFindingV1[];
	dynamicProbe: Readonly<{
		required: boolean;
		completed: boolean;
		violations: readonly string[];
	}>;
}>;

export type SkillPackageAutomaticAdmissionPolicyV1 = Readonly<{
	policyRevision: string;
	maximumReceiptAgeMs: number;
	fatalSeverities: readonly ("high" | "critical")[];
	maximumAutomaticSeverity: "info" | "low" | "medium";
	dynamicProbeRequired?: boolean;
	now?: () => number;
}>;

export type SkillPackageAutomaticAdmissionDecisionV1 = Readonly<{
	outcome: "auto_published" | "pending_review" | "rejected";
	policyRevision: string;
	reason:
		| "clean"
		| "review_required"
		| "fatal_finding"
		| "incomplete_evidence"
		| "policy_mismatch";
	findingCount: number;
}>;

const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const validDigest = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const severityRank = {
	info: 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
} as const;

function invalid(): never {
	throw new Error("SKILL_SPECTOR_REPORT_INVALID");
}

function parseReport(
	value: unknown,
	input: Readonly<{
		packageDigest: string;
		manifestDigest: string;
		policyRevision: string;
		scannerId: string;
		engineVersion: string;
		rulesetDigest: string;
	}>,
): SkillSpectorScanReportV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const report = value as Record<string, unknown>;
	const findings = report.findings;
	const probe = report.dynamicProbe;
	if (
		report.schemaVersion !== 1 ||
		report.scannerId !== input.scannerId ||
		report.engineVersion !== input.engineVersion ||
		report.rulesetDigest !== input.rulesetDigest ||
		typeof report.issuedAt !== "string" ||
		!Number.isFinite(Date.parse(report.issuedAt)) ||
		report.policyRevision !== input.policyRevision ||
		report.packageDigest !== input.packageDigest ||
		report.manifestDigest !== input.manifestDigest ||
		(report.coverage !== "complete" && report.coverage !== "incomplete") ||
		!Array.isArray(findings) ||
		(!Array.isArray(probe) && (!probe || typeof probe !== "object"))
	)
		invalid();
	const parsedFindings = findings.map((finding) => {
		if (!finding || typeof finding !== "object") invalid();
		const item = finding as Record<string, unknown>;
		if (
			typeof item.code !== "string" ||
			typeof item.category !== "string" ||
			typeof item.severity !== "string" ||
			!Object.hasOwn(severityRank, item.severity)
		)
			invalid();
		return Object.freeze({
			code: item.code,
			category: item.category as SkillSpectorFindingV1["category"],
			severity: item.severity as SkillSpectorFindingV1["severity"],
		});
	});
	const dynamicProbe = probe as Record<string, unknown>;
	if (
		typeof dynamicProbe.required !== "boolean" ||
		typeof dynamicProbe.completed !== "boolean" ||
		!Array.isArray(dynamicProbe.violations) ||
		!dynamicProbe.violations.every((item) => typeof item === "string")
	)
		invalid();
	return Object.freeze({
		schemaVersion: 1,
		scannerId: report.scannerId as string,
		engineVersion: report.engineVersion as string,
		rulesetDigest: report.rulesetDigest as string,
		policyRevision: report.policyRevision as string,
		packageDigest: report.packageDigest as string,
		manifestDigest: report.manifestDigest as string,
		issuedAt: report.issuedAt as string,
		coverage: report.coverage as SkillSpectorScanReportV1["coverage"],
		findingCount: parsedFindings.length,
		findings: Object.freeze(parsedFindings),
		dynamicProbe: Object.freeze({
			required: dynamicProbe.required as boolean,
			completed: dynamicProbe.completed as boolean,
			violations: Object.freeze(dynamicProbe.violations as string[]),
		}),
	});
}

/** Execute a pinned SkillSpector adapter. The adapter receives only a staged ZIP and metadata. */
export function createSkillSpectorAdapterV1(
	options: Readonly<{
		executable: string;
		scannerId: string;
		engineVersion: string;
		rulesetDigest: string;
		timeoutMs: number;
		stagingRoot?: string;
	}>,
) {
	if (
		!options.executable ||
		!options.scannerId ||
		!options.engineVersion ||
		!validDigest(options.rulesetDigest) ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > 300_000
	)
		throw new Error("SKILL_SPECTOR_CONFIG_INVALID");
	return Object.freeze({
		scan: async (
			input: Readonly<{
				packageDigest: string;
				manifestDigest: string;
				policyRevision: string;
				archiveBytes: Uint8Array;
			}>,
		): Promise<SkillSpectorScanReportV1> => {
			if (
				!validDigest(input.packageDigest) ||
				!validDigest(input.manifestDigest)
			)
				invalid();
			const staging = await mkdtemp(
				join(options.stagingRoot ?? tmpdir(), "agent-infra-skillspector-"),
			);
			try {
				const archive = join(staging, "skill.zip");
				await mkdir(staging, { recursive: true, mode: 0o700 });
				await writeFile(archive, input.archiveBytes, {
					flag: "wx",
					mode: 0o600,
				});
				if (sha(input.archiveBytes) !== input.packageDigest) invalid();
				const result = await execFile(
					options.executable,
					[
						"scan",
						"--archive",
						archive,
						"--scanner-id",
						options.scannerId,
						"--engine-version",
						options.engineVersion,
						"--ruleset-digest",
						options.rulesetDigest,
						"--package-digest",
						input.packageDigest,
						"--manifest-digest",
						input.manifestDigest,
						"--policy-revision",
						input.policyRevision,
					],
					{
						timeout: options.timeoutMs,
						maxBuffer: 2_000_000,
						encoding: "utf8",
					},
				);
				if (result.stderr || !result.stdout.trim()) invalid();
				return parseReport(JSON.parse(result.stdout), {
					...input,
					scannerId: options.scannerId,
					engineVersion: options.engineVersion,
					rulesetDigest: options.rulesetDigest,
				});
			} finally {
				await rm(staging, { recursive: true, force: true }).catch(
					() => undefined,
				);
			}
		},
	});
}

/** Apply the server-owned policy. Deterministic findings and incomplete evidence always win. */
export function decideSkillPackageAdmissionV1(
	report: SkillSpectorScanReportV1,
	policy: SkillPackageAutomaticAdmissionPolicyV1,
): SkillPackageAutomaticAdmissionDecisionV1 {
	if (
		report.policyRevision !== policy.policyRevision ||
		!Number.isSafeInteger(policy.maximumReceiptAgeMs) ||
		policy.maximumReceiptAgeMs < 1 ||
		policy.maximumReceiptAgeMs > 86_400_000
	)
		return Object.freeze({
			outcome: "rejected",
			reason: "policy_mismatch",
			policyRevision: policy.policyRevision,
			findingCount: report.findingCount,
		});
	const issuedAt = Date.parse(report.issuedAt);
	const now = policy.now?.() ?? Date.now();
	if (
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(now) ||
		issuedAt > now ||
		now - issuedAt > policy.maximumReceiptAgeMs
	)
		return Object.freeze({
			outcome: "rejected",
			reason: "incomplete_evidence",
			policyRevision: policy.policyRevision,
			findingCount: report.findingCount,
		});
	if (
		report.coverage !== "complete" ||
		((policy.dynamicProbeRequired ?? report.dynamicProbe.required) &&
			(!report.dynamicProbe.completed ||
				report.dynamicProbe.violations.length > 0)) ||
		report.dynamicProbe.violations.length > 0
	)
		return Object.freeze({
			outcome: "rejected",
			reason: "incomplete_evidence",
			policyRevision: policy.policyRevision,
			findingCount: report.findingCount,
		});
	if (
		report.findings.some(
			(finding) => !Object.hasOwn(severityRank, finding.severity),
		)
	)
		return Object.freeze({
			outcome: "rejected",
			reason: "incomplete_evidence",
			policyRevision: policy.policyRevision,
			findingCount: report.findingCount,
		});
	const fatal = report.findings.some((finding) =>
		policy.fatalSeverities.includes(finding.severity as "high" | "critical"),
	);
	if (fatal)
		return Object.freeze({
			outcome: "rejected",
			reason: "fatal_finding",
			policyRevision: policy.policyRevision,
			findingCount: report.findingCount,
		});
	const review = report.findings.some(
		(finding) =>
			severityRank[finding.severity] >
			severityRank[policy.maximumAutomaticSeverity],
	);
	return Object.freeze({
		outcome: review ? "pending_review" : "auto_published",
		reason: review ? "review_required" : "clean",
		policyRevision: policy.policyRevision,
		findingCount: report.findingCount,
	});
}

/** Bridges the validated SkillSpector report into the production supplier seam. */
export function createSkillSpectorPackageScannerV1(
	options: Readonly<{
		adapter: ReturnType<typeof createSkillSpectorAdapterV1>;
		policy: SkillPackageAutomaticAdmissionPolicyV1;
	}>,
): SkillPackageScannerV1 {
	return Object.freeze({
		scan: async (
			input: Parameters<SkillPackageScannerV1["scan"]>[0],
		): Promise<SkillPackageScanReceiptV1> => {
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
			const archiveBytes = Buffer.concat(chunks);
			const prepared = prepareSkillPackageV1({
				archiveBytes,
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
				throw new SkillPackageAdmissionErrorV1("digest_mismatch");
			const report = await options.adapter.scan({
				packageDigest: input.packageDigest,
				manifestDigest: input.manifestDigest,
				policyRevision: input.policyRevision,
				archiveBytes,
			});
			if (
				report.packageDigest !== input.packageDigest ||
				report.manifestDigest !== input.manifestDigest ||
				report.policyRevision !== input.policyRevision
			)
				throw new SkillPackageAdmissionErrorV1("scan_rejected");
			const decision = decideSkillPackageAdmissionV1(report, options.policy);
			if (decision.outcome === "rejected")
				throw new SkillPackageAdmissionErrorV1("scan_rejected");
			const issuedAt = Date.parse(report.issuedAt);
			const expiresAt = new Date(
				issuedAt + options.policy.maximumReceiptAgeMs,
			).toISOString();
			return Object.freeze({
				schemaVersion: 1,
				scannerId: report.scannerId,
				engineVersion: report.engineVersion,
				rulesetDigest: report.rulesetDigest,
				policyRevision: report.policyRevision,
				scannedAt: report.issuedAt,
				expiresAt,
				packageDigest: report.packageDigest,
				manifestDigest: report.manifestDigest,
				scannedFileCount: prepared.fileCount,
				scannedBytes: prepared.totalBytes,
				verdict: "clean" as const,
				admissionDecision: decision.outcome,
				admissionEvidence: {
					coverage: report.coverage,
					findings: report.findings,
					dynamicProbe: report.dynamicProbe,
				},
			});
		},
	});
}
