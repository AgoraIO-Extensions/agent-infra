#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	templateValidationContextV1Schema,
} from "../../packages/model-catalog/dist/index.mjs";

const templates = ["codex", "claude", "opencode", "pi"];
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const sourcePattern = /^[a-f0-9]{40}$/u;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const preflightFields = [
	"schemaVersion",
	"scope",
	"templateId",
	"sourceCommit",
	"imageDigest",
	"configurationRevision",
	"modelId",
	"terminalStatus",
	"modelFactSource",
	"modelOperationCount",
	"validatedAt",
];

export function templatePreflightValidationReceipt(measurement) {
	const projection = Object.fromEntries(preflightFields.map((field) => [field, measurement[field]]));
	return measurement.validationTarget === undefined ? projection : {
		...projection, schemaVersion: 2,
		executionId: measurement.executionId,
		validationTarget: templateValidationContextV1Schema.parse(measurement.validationTarget),
	};
}

function fail(message) {
	throw new Error(message);
}

async function privateFile(path, label) {
	if (!isAbsolute(path)) fail(`${label}_PATH_INVALID`);
	const stat = await lstat(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		stat.uid !== process.getuid?.() ||
		stat.size > 1024 * 1024
	)
		fail(`${label}_FILE_INVALID`);
	return readFile(path);
}

async function privateJson(path, label) {
	try { return JSON.parse(await privateFile(path, label)); }
	catch (error) {
		if (error instanceof SyntaxError) fail(`${label}_JSON_INVALID`);
		throw error;
	}
}

function exactRecord(value, keys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(`${label}_SHAPE_INVALID`);
	if (Object.keys(value).some((key) => !keys.includes(key)))
		fail(`${label}_UNBOUNDED`);
	return value;
}

function parseExpectations(value) {
	const input = exactRecord(
		value,
		["schemaVersion", "sourceSha", "minValidityMs", "templates"],
		"EXPECTATIONS",
	);
	if (
		input.schemaVersion !== 1 ||
		!sourcePattern.test(input.sourceSha) ||
		!Number.isSafeInteger(input.minValidityMs) ||
		input.minValidityMs < 60_000 ||
		input.minValidityMs > 86_400_000 ||
		!Array.isArray(input.templates) ||
		input.templates.length !== templates.length
	)
		fail("EXPECTATIONS_INVALID");
	const seen = new Set();
	return {
		sourceSha: input.sourceSha,
		minValidityMs: input.minValidityMs,
		templates: input.templates.map((entry) => {
			const item = exactRecord(
				entry,
				[
					"templateId",
					"driver",
					"imageDigest",
					"configurationRevision",
					"modelId",
					"validationFile",
					"preflightFile",
				],
				"TEMPLATE_EXPECTATION",
			);
			if (
				!templates.includes(item.templateId) ||
				seen.has(item.templateId) ||
				!new Set(["codex", "claude", "acp", "pi"]).has(item.driver) ||
				!digestPattern.test(item.imageDigest) ||
				typeof item.configurationRevision !== "string" ||
				!item.configurationRevision ||
				typeof item.modelId !== "string" ||
				!item.modelId ||
				typeof item.validationFile !== "string" ||
				typeof item.preflightFile !== "string"
			)
				fail("TEMPLATE_EXPECTATION_INVALID");
			seen.add(item.templateId);
			return { ...item };
		}),
	};
}

function parseValidation(value, expected, sourceSha) {
	const item = exactRecord(
		value,
		[
			"schemaVersion",
			"templateId",
			"sourceCommit",
			"imageDigest",
			"driver",
			"configurationRevision",
			"status",
			"evidenceKind",
			"executionId",
			"modelId",
			"validatedAt",
			"validUntil",
		],
		"VALIDATION",
	);
	if (
		item.schemaVersion !== 1 ||
		item.templateId !== expected.templateId ||
		item.sourceCommit !== sourceSha ||
		item.imageDigest !== expected.imageDigest ||
		item.driver !== expected.driver ||
		item.configurationRevision !== expected.configurationRevision ||
		item.status !== "passed" ||
		item.evidenceKind !== "real-runtime-model" ||
		typeof item.executionId !== "string" ||
		!item.executionId ||
		item.modelId !== expected.modelId ||
		!Number.isSafeInteger(item.validatedAt) ||
		!Number.isSafeInteger(item.validUntil)
	)
		fail("VALIDATION_TUPLE_INVALID");
	return item;
}

function parsePreflight(value, expected, sourceSha) {
	const version2 = value?.schemaVersion === 2;
	const item = exactRecord(value, version2 ? [...preflightFields, "validationTarget", "executionId"] : preflightFields, "PREFLIGHT");
	if (
		(!version2 && item.schemaVersion !== 1) ||
		item.scope !== "isolated-template-real-model" ||
		item.templateId !== expected.templateId ||
		item.sourceCommit !== sourceSha ||
		item.imageDigest !== expected.imageDigest ||
		item.configurationRevision !== expected.configurationRevision ||
		item.modelId !== expected.modelId ||
		item.terminalStatus !== "completed" ||
		item.modelFactSource !== "protected-driver-journal" ||
		!Number.isSafeInteger(item.modelOperationCount) ||
		item.modelOperationCount < 1 ||
		!Number.isSafeInteger(item.validatedAt)
	)
		fail("PREFLIGHT_TUPLE_INVALID");
	if (version2) {
		const target = templateValidationContextV1Schema.parse(item.validationTarget);
		if (target.sourceCommit !== sourceSha || typeof item.executionId !== "string" || !item.executionId) fail("PREFLIGHT_TARGET_INVALID");
	}
	return item;
}

/** Source bytes and target proof used by the existing formal publisher, never an adoption result. */
export async function readTemplateValidationAdoptionInputs(input, expectedContext) {
	const expectations = parseExpectations(input);
	const context = templateValidationContextV1Schema.parse(expectedContext);
	if (context.sourceCommit !== expectations.sourceSha) fail("PREFLIGHT_TARGET_INVALID");
	return Promise.all(expectations.templates.map(async (expected) => {
		const candidateBytes = await privateFile(expected.validationFile, "VALIDATION");
		const preflightBytes = await privateFile(expected.preflightFile, "PREFLIGHT");
		const candidate = parseValidation(JSON.parse(candidateBytes), expected, expectations.sourceSha);
		const preflight = parsePreflight(JSON.parse(preflightBytes), expected, expectations.sourceSha);
		if (preflight.schemaVersion !== 2 || preflight.executionId !== candidate.executionId || preflight.validatedAt !== candidate.validatedAt || JSON.stringify(templateValidationContextV1Schema.parse(preflight.validationTarget)) !== JSON.stringify(context)) fail("PREFLIGHT_TARGET_INVALID");
		return { templateId: expected.templateId, candidate, candidateBytes, preflightBytes,
			candidateFileSha256: hash(candidateBytes), preflightFileSha256: hash(preflightBytes),
			validationFile: expected.validationFile, preflightFile: expected.preflightFile };
	}));
}

export async function validateTemplateValidationExpectations(
	input,
	{ now = Date.now() } = {},
) {
	const expectations = parseExpectations(input);
	const results = [];
	for (const expected of expectations.templates) {
		try {
			const validation = parseValidation(
				await privateJson(expected.validationFile, "VALIDATION"),
				expected,
				expectations.sourceSha,
			);
			const preflight = parsePreflight(
				await privateJson(expected.preflightFile, "PREFLIGHT"),
				expected,
				expectations.sourceSha,
			);
			if (
				validation.validatedAt > now ||
				validation.validUntil <= now + expectations.minValidityMs ||
				validation.validUntil <= validation.validatedAt ||
				preflight.validatedAt > now ||
				Math.abs(validation.validatedAt - preflight.validatedAt) > 5 * 60_000
			)
				fail("VALIDATION_EXPIRED_OR_CLOCK_INVALID");
			results.push({
					templateId: expected.templateId,
					status: "passed",
					imageDigestHash: hash(expected.imageDigest),
					configurationRevisionHash: hash(expected.configurationRevision),
					modelIdHash: hash(expected.modelId),
					validatedAt: validation.validatedAt,
					validUntil: validation.validUntil,
				});
		} catch (error) {
			results.push({
					templateId: expected.templateId,
					status: "failed",
					reason:
						error instanceof Error &&
						/^[A-Z0-9_]+$/u.test(error.message)
							? error.message
							: "VALIDATION_FAILED",
			});
		}
	}
	return {
		schemaVersion: 1,
		kind: "ack-template-validation",
		sourceSha: expectations.sourceSha,
		results,
		pass: results.every((result) => result.status === "passed"),
	};
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
	try {
		const file = process.argv[2];
		if (!file) fail("EXPECTATIONS_REQUIRED");
		const result = await validateTemplateValidationExpectations(
			await privateJson(file, "EXPECTATIONS"),
		);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (!result.pass) process.exitCode = 1;
	} catch {
		process.stderr.write("ACK_TEMPLATE_VALIDATION_FAILED\n");
		process.exitCode = 1;
	}
}
