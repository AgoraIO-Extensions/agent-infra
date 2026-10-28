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
		issuedAt: new Date(report.issuedAt as string).toISOString(),
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

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

/** Native 2.x reports describe static coverage; they cannot attest a dynamic probe. */
function parseNativeReport(
	value: unknown,
	binding: Parameters<typeof parseReport>[1],
	files: readonly { readonly path: string }[],
): SkillSpectorScanReportV1 {
	const report = record(value);
	const metadata = record(report.metadata);
	const skill = record(report.skill);
	const coverage = record(report.analysis_completeness);
	const empty = (value: unknown) => Array.isArray(value) && value.length === 0;
	if (
		metadata.skillspector_version !== binding.engineVersion ||
		metadata.llm_requested !== false ||
		report.execution_successful !== true ||
		coverage.execution_successful !== true ||
		coverage.is_complete !== true ||
		coverage.status !== "complete" ||
		coverage.coverage_percent !== 100 ||
		coverage.total_components !== files.length ||
		coverage.scanned_components !== files.length ||
		coverage.fully_inspected_files !== files.length ||
		coverage.partially_inspected_files !== 0 ||
		coverage.entirely_uninspected_files !== 0 ||
		!empty(coverage.ledger_exceptions) ||
		!empty(coverage.scope_exclusions) ||
		!empty(coverage.limitations) ||
		report.suppressed_count !== 0 ||
		!empty(report.suppressed) ||
		!Array.isArray(report.issues) ||
		coverage.findings_before_filtering !== report.issues.length ||
		coverage.findings_after_filtering !== report.issues.length ||
		!Array.isArray(report.components) ||
		!Array.isArray(coverage.analyzer_statuses) ||
		coverage.analyzer_statuses.length === 0
	)
		invalid();
	const paths = report.components.map((component) => record(component).path);
	if (
		paths.length !== files.length ||
		new Set(paths).size !== files.length ||
		files.some((file) => !paths.includes(file.path))
	)
		invalid();
	const ids = new Set<string>();
	let completed = 0;
	for (const item of coverage.analyzer_statuses) {
		const analyzer = record(item);
		const id = analyzer.analyzer_id;
		const planned = analyzer.planned_work;
		if (
			typeof id !== "string" ||
			!id ||
			ids.has(id) ||
			!Number.isSafeInteger(planned) ||
			(planned as number) < 0 ||
			analyzer.completed !== planned ||
			["partial", "skipped", "failed", "unaccounted"].some(
				(key) => analyzer[key] !== 0,
			)
		)
			invalid();
		ids.add(id);
		if (analyzer.status === "completed" && (planned as number) > 0) completed++;
		else if (
			planned !== 0 ||
			!(
				analyzer.status === "not_applicable" ||
				(analyzer.status === "disabled" && id.startsWith("semantic_"))
			)
		)
			invalid();
	}
	if (!completed) invalid();
	const findings = report.issues.map((value) => {
		const finding = record(value);
		if (
			typeof finding.id !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(finding.id) ||
			typeof finding.severity !== "string" ||
			!Object.hasOwn(severityRank, finding.severity.toLowerCase()) ||
			typeof finding.category !== "string" ||
			!finding.category
		)
			invalid();
		return {
			code: finding.id,
			severity: finding.severity.toLowerCase(),
			category: finding.category === "Supply Chain" ? "supply_chain" : "static",
		};
	});
	return parseReport(
		{
			schemaVersion: 1,
			...binding,
			issuedAt: skill.scanned_at,
			coverage: "complete",
			findings,
			dynamicProbe: { required: false, completed: false, violations: [] },
		},
		binding,
	);
}

/** Execute the pinned native SkillSpector CLI using static analysis only. */
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
				const prepared = prepareSkillPackageV1({
					archiveBytes: input.archiveBytes,
					name: "scanner-input",
					version: "1.0.0",
				});
				let findingsExit = false;
				const result = await execFile(
					options.executable,
					["scan", archive, "--no-llm", "--format", "json"],
					{
						timeout: options.timeoutMs,
						maxBuffer: 2_000_000,
						encoding: "utf8",
						cwd: staging,
						env: {
							...process.env,
							LANGSMITH_TRACING: "false",
							LANGCHAIN_TRACING_V2: "false",
						},
					},
				).catch((error: unknown) => {
					// Exit 1 is a completed scan with findings; platform policy still decides admission.
					const failure = record(error);
					if (
						failure.code !== 1 ||
						failure.killed ||
						failure.signal ||
						typeof failure.stdout !== "string" ||
						typeof failure.stderr !== "string"
					)
						throw error;
					findingsExit = true;
					return { stdout: failure.stdout, stderr: failure.stderr };
				});
				if (result.stderr || !result.stdout.trim()) invalid();
				const report = parseNativeReport(
					JSON.parse(result.stdout),
					{
						packageDigest: input.packageDigest,
						manifestDigest: input.manifestDigest,
						policyRevision: input.policyRevision,
						scannerId: options.scannerId,
						engineVersion: options.engineVersion,
						rulesetDigest: options.rulesetDigest,
					},
					prepared.manifest.files,
				);
				if (findingsExit && report.findingCount === 0) invalid();
				return report;
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
