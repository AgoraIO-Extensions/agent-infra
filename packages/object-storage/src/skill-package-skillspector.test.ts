import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	createSkillSpectorAdapterV1,
	decideSkillPackageAdmissionV1,
} from "./skill-package-skillspector.js";

const policy = {
	policyRevision: "policy-v1",
	maximumReceiptAgeMs: 60_000,
	fatalSeverities: ["high", "critical"] as const,
	maximumAutomaticSeverity: "low" as const,
};

const report = (overrides: Record<string, unknown> = {}) => ({
	schemaVersion: 1 as const,
	scannerId: "skillspector",
	engineVersion: "1.0.0",
	rulesetDigest: "a".repeat(64),
	policyRevision: "policy-v1",
	packageDigest: "b".repeat(64),
	manifestDigest: "c".repeat(64),
	coverage: "complete" as const,
	findingCount: 0,
	findings: [],
	dynamicProbe: { required: false, completed: false, violations: [] },
	...overrides,
});

it("fails closed for incomplete evidence and fatal findings", () => {
	expect(
		decideSkillPackageAdmissionV1(report({ coverage: "incomplete" }), policy),
	).toMatchObject({
		outcome: "rejected",
		reason: "incomplete_evidence",
	});
	expect(
		decideSkillPackageAdmissionV1(
			report({
				findings: [{ code: "network", severity: "high", category: "static" }],
			}),
			policy,
		),
	).toMatchObject({ outcome: "rejected", reason: "fatal_finding" });
});

it("routes uncertain findings to review but publishes clean complete reports", () => {
	expect(
		decideSkillPackageAdmissionV1(
			report({
				findings: [
					{
						code: "prompt-injection",
						severity: "medium",
						category: "semantic",
					},
				],
			}),
			policy,
		),
	).toMatchObject({ outcome: "pending_review", reason: "review_required" });
	expect(decideSkillPackageAdmissionV1(report(), policy)).toMatchObject({
		outcome: "auto_published",
		reason: "clean",
	});
});

it("executes the external scanner with a staged archive and validates its report", async () => {
	const directory = await mkdtemp(join(tmpdir(), "skillspector-test-"));
	const executable = join(directory, "scanner.cjs");
	const archive = new TextEncoder().encode("archive");
	await writeFile(
		executable,
		`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const archivePath = args[args.indexOf("--archive") + 1];
if (!fs.statSync(archivePath).isFile()) process.exit(1);
const value = (name) => args[args.indexOf(name) + 1];
process.stdout.write(JSON.stringify({schemaVersion:1,scannerId:value("--scanner-id"),engineVersion:value("--engine-version"),rulesetDigest:value("--ruleset-digest"),policyRevision:value("--policy-revision"),packageDigest:value("--package-digest"),manifestDigest:value("--manifest-digest"),coverage:"complete",findings:[],dynamicProbe:{required:false,completed:false,violations:[]}}));
`,
		{ mode: 0o700 },
	);
	try {
		const adapter = createSkillSpectorAdapterV1({
			executable,
			scannerId: "skillspector",
			engineVersion: "1.0.0",
			rulesetDigest: "a".repeat(64),
			timeoutMs: 10_000,
		});
		const result = await adapter.scan({
			packageDigest: createHash("sha256").update(archive).digest("hex"),
			manifestDigest: "c".repeat(64),
			policyRevision: "policy-v1",
			archiveBytes: archive,
		});
		expect(result).toMatchObject({
			scannerId: "skillspector",
			coverage: "complete",
			findingCount: 0,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
