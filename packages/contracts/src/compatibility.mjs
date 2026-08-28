import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const artifactRelativePaths = [
	"packages/contracts/artifacts/json-schema/common.v1.schema.json",
	"packages/contracts/artifacts/openapi/common.v1.openapi.json",
];

function parseArguments(arguments_) {
	const values = {};
	for (let index = 0; index < arguments_.length; index += 2) {
		const option = arguments_[index];
		const value = arguments_[index + 1];
		if (!value || (option !== "--previous" && option !== "--current")) {
			throw new Error(
				"Usage: compatibility.mjs [--previous path --current path]",
			);
		}
		values[option.slice(2)] = value;
	}
	return values;
}

function valueSet(value) {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function sameValue(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function compareSchema(previous, current, path, changes) {
	const previousTypes = valueSet(previous.type);
	const currentTypes = valueSet(current.type);
	if (previousTypes.some((type) => !currentTypes.includes(type))) {
		changes.push(
			`retyped ${path} from ${previousTypes.join("|")} to ${currentTypes.join("|")}`,
		);
		return;
	}

	if (
		previous.const !== undefined &&
		!sameValue(previous.const, current.const)
	) {
		changes.push(`narrowed ${path} const`);
	}
	if (Array.isArray(previous.enum)) {
		const currentEnum = Array.isArray(current.enum) ? current.enum : [];
		if (
			previous.enum.some(
				(value) => !currentEnum.some((entry) => sameValue(entry, value)),
			)
		) {
			changes.push(`narrowed ${path} enum`);
		}
	}

	const increasingMinimums = [
		"minLength",
		"minItems",
		"minProperties",
		"minimum",
	];
	for (const keyword of increasingMinimums) {
		if (
			typeof current[keyword] === "number" &&
			current[keyword] > (previous[keyword] ?? Number.NEGATIVE_INFINITY)
		) {
			changes.push(`narrowed ${path} ${keyword}`);
		}
	}
	const decreasingMaximums = [
		"maxLength",
		"maxItems",
		"maxProperties",
		"maximum",
	];
	for (const keyword of decreasingMaximums) {
		if (
			typeof current[keyword] === "number" &&
			current[keyword] < (previous[keyword] ?? Number.POSITIVE_INFINITY)
		) {
			changes.push(`narrowed ${path} ${keyword}`);
		}
	}
	for (const keyword of ["pattern", "format"]) {
		if (
			current[keyword] !== undefined &&
			current[keyword] !== previous[keyword]
		) {
			changes.push(`narrowed ${path} ${keyword}`);
		}
	}

	const previousRequired = new Set(previous.required ?? []);
	for (const name of current.required ?? []) {
		if (!previousRequired.has(name))
			changes.push(`narrowed ${path}.${name} required`);
	}
	if (
		previous.additionalProperties !== false &&
		current.additionalProperties === false
	) {
		changes.push(`narrowed ${path} additionalProperties`);
	}

	for (const [name, schema] of Object.entries(previous.properties ?? {})) {
		const currentSchema = current.properties?.[name];
		if (!currentSchema) {
			changes.push(`removed ${path}.${name}`);
			continue;
		}
		compareSchema(schema, currentSchema, `${path}.${name}`, changes);
	}
	if (previous.items && current.items) {
		compareSchema(previous.items, current.items, `${path}[]`, changes);
	} else if (previous.items && !current.items) {
		changes.push(`removed ${path}[]`);
	}
}

function findBreakingChanges(previous, current) {
	// ponytail: #179 publishes component schemas only; extend this seam for
	// paths and parameters when #180 adds browser and internal HTTP operations.
	const changes = [];
	const previousSchemas = previous.$defs ?? previous.components?.schemas ?? {};
	const currentSchemas = current.$defs ?? current.components?.schemas ?? {};
	for (const [name, schema] of Object.entries(previousSchemas)) {
		const currentSchema = currentSchemas[name];
		if (!currentSchema) {
			changes.push(`removed schema $defs.${name}`);
			continue;
		}
		compareSchema(schema, currentSchema, `$defs.${name}`, changes);
	}
	return changes.sort();
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function readMergeBaseArtifact(artifactRelativePath) {
	const baseRef = process.env.GITHUB_BASE_REF
		? `origin/${process.env.GITHUB_BASE_REF}`
		: "origin/main";
	const mergeBase = execFileSync("git", ["merge-base", "HEAD", baseRef], {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim();
	const result = spawnSync(
		"git",
		["show", `${mergeBase}:${artifactRelativePath}`],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	if (result.status !== 0) return undefined;
	return JSON.parse(result.stdout);
}

const arguments_ = parseArguments(process.argv.slice(2));
const comparisons = arguments_.previous
	? [
			{
				label: "fixture",
				previous: await readJson(resolve(arguments_.previous)),
				current: await readJson(resolve(arguments_.current)),
			},
		]
	: await Promise.all(
			artifactRelativePaths.map(async (artifactRelativePath) => ({
				label: artifactRelativePath,
				previous: readMergeBaseArtifact(artifactRelativePath),
				current: await readJson(resolve(repositoryRoot, artifactRelativePath)),
			})),
		);
const failures = comparisons.flatMap(({ label, previous, current }) =>
	previous
		? findBreakingChanges(previous, current).map(
				(change) => `${label}: ${change}`,
			)
		: [],
);
if (failures.length > 0) {
	process.stderr.write(
		`Contract compatibility check failed:\n${failures.map((change) => `- ${change}`).join("\n")}\n`,
	);
	process.exitCode = 1;
}
