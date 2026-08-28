import { execFileSync } from "node:child_process";
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
	if (previousTypes.length === 0 && currentTypes.length > 0) {
		changes.push(`narrowed ${path} type`);
	} else if (
		currentTypes.length > 0 &&
		previousTypes.some((type) => !currentTypes.includes(type))
	) {
		changes.push(
			`retyped ${path} from ${previousTypes.join("|")} to ${currentTypes.join("|")}`,
		);
		return;
	}

	if (previous.const === undefined && current.const !== undefined) {
		changes.push(`narrowed ${path} const`);
	} else if (
		previous.const !== undefined &&
		current.const !== undefined &&
		!sameValue(previous.const, current.const)
	) {
		changes.push(`narrowed ${path} const`);
	}
	if (!Array.isArray(previous.enum) && Array.isArray(current.enum)) {
		changes.push(`narrowed ${path} enum`);
	} else if (Array.isArray(previous.enum) && Array.isArray(current.enum)) {
		const currentEnum = current.enum;
		if (
			previous.enum.some(
				(value) => !currentEnum.some((entry) => sameValue(entry, value)),
			)
		) {
			changes.push(`narrowed ${path} enum`);
		}
	}
	for (const keyword of ["oneOf", "anyOf"]) {
		const previousOptions = previous[keyword];
		const currentOptions = current[keyword];
		if (!Array.isArray(previousOptions) && Array.isArray(currentOptions)) {
			changes.push(`narrowed ${path} ${keyword}`);
		} else if (
			Array.isArray(previousOptions) &&
			Array.isArray(currentOptions) &&
			previousOptions.some(
				(option) => !currentOptions.some((entry) => sameValue(entry, option)),
			)
		) {
			changes.push(`narrowed ${path} ${keyword}`);
		}
	}
	if (previous.$ref === undefined && current.$ref !== undefined) {
		changes.push(`narrowed ${path} $ref`);
	} else if (
		previous.$ref !== undefined &&
		current.$ref !== undefined &&
		previous.$ref !== current.$ref
	) {
		changes.push(`retyped ${path} $ref`);
	}

	const increasingMinimums = ["minLength", "minItems", "minProperties"];
	for (const keyword of increasingMinimums) {
		if (
			typeof current[keyword] === "number" &&
			current[keyword] > (previous[keyword] ?? Number.NEGATIVE_INFINITY)
		) {
			changes.push(`narrowed ${path} ${keyword}`);
		}
	}
	const decreasingMaximums = ["maxLength", "maxItems", "maxProperties"];
	for (const keyword of decreasingMaximums) {
		if (
			typeof current[keyword] === "number" &&
			current[keyword] < (previous[keyword] ?? Number.POSITIVE_INFINITY)
		) {
			changes.push(`narrowed ${path} ${keyword}`);
		}
	}
	const previousMinimum = Math.max(
		previous.minimum ?? Number.NEGATIVE_INFINITY,
		previous.exclusiveMinimum ?? Number.NEGATIVE_INFINITY,
	);
	const currentMinimum = Math.max(
		current.minimum ?? Number.NEGATIVE_INFINITY,
		current.exclusiveMinimum ?? Number.NEGATIVE_INFINITY,
	);
	const previousMinimumExclusive =
		previous.exclusiveMinimum === previousMinimum;
	const currentMinimumExclusive = current.exclusiveMinimum === currentMinimum;
	if (
		currentMinimum > previousMinimum ||
		(currentMinimum === previousMinimum &&
			currentMinimumExclusive &&
			!previousMinimumExclusive)
	) {
		changes.push(
			`narrowed ${path} ${currentMinimumExclusive ? "exclusiveMinimum" : "minimum"}`,
		);
	}
	const previousMaximum = Math.min(
		previous.maximum ?? Number.POSITIVE_INFINITY,
		previous.exclusiveMaximum ?? Number.POSITIVE_INFINITY,
	);
	const currentMaximum = Math.min(
		current.maximum ?? Number.POSITIVE_INFINITY,
		current.exclusiveMaximum ?? Number.POSITIVE_INFINITY,
	);
	const previousMaximumExclusive =
		previous.exclusiveMaximum === previousMaximum;
	const currentMaximumExclusive = current.exclusiveMaximum === currentMaximum;
	if (
		currentMaximum < previousMaximum ||
		(currentMaximum === previousMaximum &&
			currentMaximumExclusive &&
			!previousMaximumExclusive)
	) {
		changes.push(
			`narrowed ${path} ${currentMaximumExclusive ? "exclusiveMaximum" : "maximum"}`,
		);
	}
	if (typeof current.multipleOf === "number") {
		const previousMultiple = previous.multipleOf;
		const ratio = previousMultiple / current.multipleOf;
		const ratioError = Math.abs(ratio - Math.round(ratio));
		if (
			typeof previousMultiple !== "number" ||
			ratioError > Number.EPSILON * Math.max(1, Math.abs(ratio)) * 4
		) {
			changes.push(`narrowed ${path} multipleOf`);
		}
	}
	if (current.uniqueItems === true && previous.uniqueItems !== true) {
		changes.push(`narrowed ${path} uniqueItems`);
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
	const previousAdditional = previous.additionalProperties ?? true;
	const currentAdditional = current.additionalProperties ?? true;
	if (previousAdditional === true) {
		if (
			currentAdditional === false ||
			(typeof currentAdditional === "object" &&
				currentAdditional !== null &&
				Object.keys(currentAdditional).length > 0)
		) {
			changes.push(`narrowed ${path} additionalProperties`);
		}
	} else if (previousAdditional !== false) {
		if (currentAdditional === false) {
			changes.push(`narrowed ${path} additionalProperties`);
		} else if (
			currentAdditional !== true &&
			typeof currentAdditional === "object" &&
			currentAdditional !== null
		) {
			compareSchema(
				previousAdditional,
				currentAdditional,
				`${path}.*`,
				changes,
			);
		}
	}

	for (const [name, schema] of Object.entries(previous.properties ?? {})) {
		const currentSchema = current.properties?.[name];
		if (!currentSchema) {
			changes.push(`removed ${path}.${name}`);
			continue;
		}
		compareSchema(schema, currentSchema, `${path}.${name}`, changes);
	}
	const previousItems = previous.items;
	const currentItems = current.items;
	if (
		(previousItems === undefined || previousItems === true) &&
		currentItems !== undefined &&
		currentItems !== true
	) {
		changes.push(`narrowed ${path}[] items`);
	} else if (
		previousItems !== undefined &&
		previousItems !== true &&
		currentItems !== undefined &&
		currentItems !== true
	) {
		if (currentItems === false) {
			if (previousItems !== false) changes.push(`narrowed ${path}[] items`);
		} else if (previousItems !== false) {
			compareSchema(previousItems, currentItems, `${path}[]`, changes);
		}
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
	const matchingPath = execFileSync(
		"git",
		["ls-tree", "-r", "--name-only", mergeBase, "--", artifactRelativePath],
		{ cwd: repositoryRoot, encoding: "utf8" },
	).trim();
	if (!matchingPath) return undefined;
	return JSON.parse(
		execFileSync("git", ["show", `${mergeBase}:${artifactRelativePath}`], {
			cwd: repositoryRoot,
			encoding: "utf8",
		}),
	);
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
