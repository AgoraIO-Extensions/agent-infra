import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const artifactRelativePaths = [
	"packages/contracts/artifacts/json-schema/common.v1.schema.json",
	"packages/contracts/artifacts/json-schema/pilot-delegated.v1.schema.json",
	"packages/contracts/artifacts/json-schema/pilot-sse.v1.schema.json",
	"packages/contracts/artifacts/openapi/common.v1.openapi.json",
	"packages/contracts/artifacts/openapi/pilot-browser.v1.openapi.json",
	"packages/contracts/artifacts/openapi/pilot-delegated.v1.openapi.json",
];
const unsupportedConstraintKeywords = [
	"dependentSchemas",
	"if",
	"then",
	"else",
	"unevaluatedProperties",
	"unevaluatedItems",
];
const usage = "Usage: compatibility.mjs [--previous path --current path]";

function parseArguments(arguments_) {
	const values = {};
	for (let index = 0; index < arguments_.length; index += 2) {
		const option = arguments_[index];
		const value = arguments_[index + 1];
		if (!value || (option !== "--previous" && option !== "--current")) {
			throw new Error(usage);
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

function unmatchedOptions(options, baseline) {
	const remaining = [...baseline];
	return options.filter((option) => {
		const match = remaining.findIndex((entry) => sameValue(entry, option));
		if (match === -1) return true;
		remaining.splice(match, 1);
		return false;
	});
}

function literalValues(schema) {
	if (!schema || typeof schema !== "object") return undefined;
	if (schema.const !== undefined) return [schema.const];
	return Array.isArray(schema.enum) ? schema.enum : undefined;
}

function literalSchemasAreDisjoint(left, right) {
	const leftValues = literalValues(left);
	const rightValues = literalValues(right);
	return (
		leftValues !== undefined &&
		rightValues !== undefined &&
		leftValues.every(
			(leftValue) =>
				!rightValues.some((rightValue) => sameValue(leftValue, rightValue)),
		)
	);
}

function hasSchemaConstraints(value) {
	return (
		value === false ||
		(typeof value === "object" &&
			value !== null &&
			Object.keys(value).length > 0)
	);
}

function compareSubschemaConstraint(previous, current, path, keyword, changes) {
	const previousSchema = previous ?? true;
	const currentSchema = current ?? true;
	if (previousSchema === true) {
		if (hasSchemaConstraints(currentSchema)) {
			changes.push(`narrowed ${path} ${keyword}`);
		}
		return;
	}
	if (previousSchema === false || currentSchema === true) return;
	if (currentSchema === false) {
		changes.push(`narrowed ${path} ${keyword}`);
	} else if (typeof currentSchema === "object" && currentSchema !== null) {
		compareSchema(previousSchema, currentSchema, `${path} ${keyword}`, changes);
	}
}

function schemaIsWidening(previous, current) {
	const changes = [];
	compareSchema(previous, current, "$option", changes);
	return changes.length === 0;
}

function compareSchema(previous, current, path, changes) {
	if (previous === false || current === true) return;
	if (current === false) {
		changes.push(`narrowed ${path} schema`);
		return;
	}
	if (previous === true) {
		if (hasSchemaConstraints(current)) {
			changes.push(`narrowed ${path} schema`);
		}
		return;
	}

	const previousTypes = valueSet(previous.type);
	const currentTypes = valueSet(current.type);
	if (previousTypes.length === 0 && currentTypes.length > 0) {
		changes.push(`narrowed ${path} type`);
	} else if (
		currentTypes.length > 0 &&
		previousTypes.some(
			(type) =>
				!currentTypes.includes(type) &&
				!(type === "integer" && currentTypes.includes("number")),
		)
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
		if (
			previous.const === undefined ||
			!current.enum.some((entry) => sameValue(entry, previous.const))
		) {
			changes.push(`narrowed ${path} enum`);
		}
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
			Array.isArray(currentOptions)
		) {
			const removedOptions = unmatchedOptions(previousOptions, currentOptions);
			const addedOptions = unmatchedOptions(currentOptions, previousOptions);
			const matchedAdditions = new Set();
			for (let index = removedOptions.length - 1; index >= 0; index -= 1) {
				const previousOption = removedOptions[index];
				const match = addedOptions.findIndex((currentOption) => {
					if (!schemaIsWidening(previousOption, currentOption)) return false;
					if (keyword !== "oneOf" || currentOptions.length === 1) return true;
					const currentIndex = currentOptions.indexOf(currentOption);
					return currentOptions.every(
						(other, otherIndex) =>
							otherIndex === currentIndex ||
							literalSchemasAreDisjoint(currentOption, other),
					);
				});
				if (match !== -1) {
					removedOptions.splice(index, 1);
					matchedAdditions.add(match);
				}
			}
			for (const index of [...matchedAdditions].sort(
				(left, right) => right - left,
			)) {
				addedOptions.splice(index, 1);
			}
			const disjointAdditions = addedOptions.every(
				(option, index) =>
					previousOptions.every((previousOption) =>
						literalSchemasAreDisjoint(option, previousOption),
					) &&
					addedOptions.every(
						(other, otherIndex) =>
							index === otherIndex || literalSchemasAreDisjoint(option, other),
					),
			);
			if (
				removedOptions.length > 0 ||
				(keyword === "oneOf" && !disjointAdditions)
			) {
				changes.push(`narrowed ${path} ${keyword}`);
			}
		}
	}
	const previousAllOf = previous.allOf;
	const currentAllOf = current.allOf;
	if (
		Array.isArray(currentAllOf) &&
		(!Array.isArray(previousAllOf) ||
			currentAllOf.some(
				(option) => !previousAllOf.some((entry) => sameValue(entry, option)),
			))
	) {
		changes.push(`narrowed ${path} allOf`);
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
	if (
		current.not !== undefined &&
		(previous.not === undefined || !sameValue(previous.not, current.not))
	) {
		changes.push(`narrowed ${path} not`);
	}
	for (const keyword of unsupportedConstraintKeywords) {
		if (
			current[keyword] !== undefined &&
			!sameValue(previous[keyword], current[keyword])
		) {
			changes.push(`narrowed ${path} unsupported ${keyword}`);
		}
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
	for (const [property, currentDependencies] of Object.entries(
		current.dependentRequired ?? {},
	)) {
		const previousDependencies = new Set(
			previous.dependentRequired?.[property] ?? [],
		);
		for (const dependency of currentDependencies) {
			if (!previousDependencies.has(dependency)) {
				changes.push(
					`narrowed ${path}.${property} dependentRequired ${dependency}`,
				);
			}
		}
	}
	compareSubschemaConstraint(
		previous.additionalProperties,
		current.additionalProperties,
		path,
		"additionalProperties",
		changes,
	);
	compareSubschemaConstraint(
		previous.propertyNames,
		current.propertyNames,
		path,
		"propertyNames",
		changes,
	);

	for (const [name, schema] of Object.entries(previous.properties ?? {})) {
		const currentSchema = current.properties?.[name];
		if (currentSchema === undefined) {
			const matchingPatterns = Object.entries(
				current.patternProperties ?? {},
			).filter(([pattern]) => new RegExp(pattern).test(name));
			if (matchingPatterns.length > 0) {
				for (const [pattern, patternSchema] of matchingPatterns) {
					compareSubschemaConstraint(
						schema,
						patternSchema,
						`${path}.${name}`,
						`patternProperties ${pattern}`,
						changes,
					);
				}
			} else {
				compareSubschemaConstraint(
					schema,
					current.additionalProperties,
					`${path}.${name}`,
					"property",
					changes,
				);
			}
			continue;
		}
		compareSchema(schema, currentSchema, `${path}.${name}`, changes);
	}
	for (const [name, schema] of Object.entries(current.properties ?? {})) {
		if (previous.properties?.[name] !== undefined) continue;
		const matchingPatterns = Object.entries(
			previous.patternProperties ?? {},
		).filter(([pattern]) => new RegExp(pattern).test(name));
		if (matchingPatterns.length > 0) {
			for (const [pattern, patternSchema] of matchingPatterns) {
				compareSubschemaConstraint(
					patternSchema,
					schema,
					`${path}.${name}`,
					`property ${pattern}`,
					changes,
				);
			}
		} else {
			compareSubschemaConstraint(
				previous.additionalProperties,
				schema,
				`${path}.${name}`,
				"property",
				changes,
			);
		}
	}
	for (const [pattern, schema] of Object.entries(
		current.patternProperties ?? {},
	)) {
		const previousPatternSchema = previous.patternProperties?.[pattern];
		compareSubschemaConstraint(
			previousPatternSchema ?? previous.additionalProperties,
			schema,
			`${path}.${pattern}`,
			"patternProperties",
			changes,
		);
		if (previousPatternSchema === undefined) {
			const expression = new RegExp(pattern);
			for (const [name, propertySchema] of Object.entries(
				previous.properties ?? {},
			)) {
				if (!expression.test(name)) continue;
				compareSubschemaConstraint(
					propertySchema,
					schema,
					`${path}.${name}`,
					`patternProperties ${pattern}`,
					changes,
				);
			}
		}
	}
	for (const [pattern, schema] of Object.entries(
		previous.patternProperties ?? {},
	)) {
		if (current.patternProperties?.[pattern] !== undefined) continue;
		compareSubschemaConstraint(
			schema,
			current.additionalProperties,
			`${path}.${pattern}`,
			"patternProperties",
			changes,
		);
	}
	compareSubschemaConstraint(
		previous.items,
		current.items,
		`${path}[]`,
		"items",
		changes,
	);
	const previousPrefixItems = Array.isArray(previous.prefixItems)
		? previous.prefixItems
		: [];
	const currentPrefixItems = Array.isArray(current.prefixItems)
		? current.prefixItems
		: [];
	for (const [index, currentPrefixItem] of currentPrefixItems.entries()) {
		compareSubschemaConstraint(
			previousPrefixItems[index] ?? previous.items,
			currentPrefixItem,
			`${path}[${index}]`,
			"prefixItems",
			changes,
		);
	}
	for (
		let index = currentPrefixItems.length;
		index < previousPrefixItems.length;
		index += 1
	) {
		compareSubschemaConstraint(
			previousPrefixItems[index],
			current.items,
			`${path}[${index}]`,
			"prefixItems",
			changes,
		);
	}
	const previousContains = previous.contains;
	const currentContains = current.contains;
	if (currentContains !== undefined) {
		compareSubschemaConstraint(
			previousContains,
			currentContains,
			path,
			"contains",
			changes,
		);
		const previousMinContains =
			previousContains === undefined ? 0 : (previous.minContains ?? 1);
		const currentMinContains = current.minContains ?? 1;
		if (currentMinContains > previousMinContains) {
			changes.push(`narrowed ${path} minContains`);
		}
		const previousMaxContains =
			previousContains === undefined
				? Number.POSITIVE_INFINITY
				: (previous.maxContains ?? Number.POSITIVE_INFINITY);
		const currentMaxContains = current.maxContains ?? Number.POSITIVE_INFINITY;
		if (currentMaxContains < previousMaxContains) {
			changes.push(`narrowed ${path} maxContains`);
		}
	}
	for (const [name, schema] of Object.entries(previous.$defs ?? {})) {
		const currentSchema = current.$defs?.[name];
		if (currentSchema !== undefined) {
			compareSchema(schema, currentSchema, `${path}.$defs.${name}`, changes);
		} else {
			changes.push(`removed ${path}.$defs.${name}`);
		}
	}
}

const httpMethods = [
	"delete",
	"get",
	"head",
	"options",
	"patch",
	"post",
	"put",
	"trace",
];

function compareOpenApiContent(previous, current, path, changes) {
	for (const [mediaType, media] of Object.entries(previous ?? {})) {
		const currentMedia = current?.[mediaType];
		if (currentMedia === undefined) {
			changes.push(`removed ${path} content ${mediaType}`);
			continue;
		}
		if (media.schema !== undefined) {
			if (currentMedia.schema === undefined) {
				changes.push(`removed ${path} content ${mediaType} schema`);
			} else {
				compareSchema(
					media.schema,
					currentMedia.schema,
					`${path} content ${mediaType}`,
					changes,
				);
			}
		}
	}
}

function compareOpenApiParameters(previous, current, path, changes) {
	const previousParameters = previous ?? [];
	const currentParameterList = current ?? [];
	const currentParameters = new Map(
		currentParameterList.map((parameter) => [
			`${parameter.in}:${parameter.name}`,
			parameter,
		]),
	);
	const previousKeys = new Set();
	for (const parameter of previousParameters) {
		if (parameter.$ref !== undefined) {
			changes.push(`unsupported ${path} parameter $ref`);
			continue;
		}
		const key = `${parameter.in}:${parameter.name}`;
		previousKeys.add(key);
		const currentParameter = currentParameters.get(key);
		if (currentParameter === undefined) {
			changes.push(`removed ${path} parameter ${key}`);
			continue;
		}
		if (currentParameter.$ref !== undefined) {
			changes.push(`unsupported ${path} parameter ${key} $ref`);
			continue;
		}
		if (parameter.required !== true && currentParameter.required === true) {
			changes.push(`narrowed ${path} parameter ${key} required`);
		}
		if (parameter.schema !== undefined) {
			if (currentParameter.schema === undefined) {
				changes.push(`removed ${path} parameter ${key} schema`);
			} else {
				compareSchema(
					parameter.schema,
					currentParameter.schema,
					`${path} parameter ${key}`,
					changes,
				);
			}
		}
	}
	for (const parameter of currentParameterList) {
		const key = `${parameter.in}:${parameter.name}`;
		if (
			parameter.$ref === undefined &&
			parameter.required === true &&
			!previousKeys.has(key)
		) {
			changes.push(`added required ${path} parameter ${key}`);
		}
	}
}

function compareOpenApiOperation(previous, current, path, changes) {
	if (
		previous.operationId !== undefined &&
		previous.operationId !== current.operationId
	) {
		changes.push(`changed ${path} operationId`);
	}
	for (const keyword of ["callbacks", "security", "servers"]) {
		if (previous[keyword] !== undefined || current[keyword] !== undefined) {
			changes.push(`unsupported ${path} ${keyword}`);
		}
	}
	compareOpenApiParameters(
		previous.parameters,
		current.parameters,
		path,
		changes,
	);
	if (previous.requestBody !== undefined) {
		if (current.requestBody === undefined) {
			changes.push(`removed ${path} requestBody`);
		} else {
			if (
				previous.requestBody.required !== true &&
				current.requestBody.required
			) {
				changes.push(`narrowed ${path} requestBody required`);
			}
			compareOpenApiContent(
				previous.requestBody.content,
				current.requestBody.content,
				`${path} requestBody`,
				changes,
			);
		}
	}
	for (const [status, response] of Object.entries(previous.responses ?? {})) {
		const currentResponse = current.responses?.[status];
		if (currentResponse === undefined) {
			changes.push(`removed ${path} response ${status}`);
			continue;
		}
		compareOpenApiContent(
			response.content,
			currentResponse.content,
			`${path} response ${status}`,
			changes,
		);
	}
}

function compareOpenApiPaths(previous, current, changes) {
	for (const [path, pathItem] of Object.entries(previous.paths ?? {})) {
		const currentPathItem = current.paths?.[path];
		if (currentPathItem === undefined) {
			changes.push(`removed OpenAPI path ${path}`);
			continue;
		}
		if (
			pathItem.parameters !== undefined ||
			currentPathItem.parameters !== undefined
		) {
			changes.push(`unsupported OpenAPI path ${path} parameters`);
		}
		for (const method of httpMethods) {
			const operation = pathItem[method];
			if (operation === undefined) continue;
			const currentOperation = currentPathItem[method];
			if (currentOperation === undefined) {
				changes.push(
					`removed OpenAPI operation ${method.toUpperCase()} ${path}`,
				);
				continue;
			}
			compareOpenApiOperation(
				operation,
				currentOperation,
				`OpenAPI ${method.toUpperCase()} ${path}`,
				changes,
			);
		}
	}
}

function findBreakingChanges(previous, current) {
	const changes = [];
	const previousSchemas = previous.$defs ?? previous.components?.schemas ?? {};
	const currentSchemas = current.$defs ?? current.components?.schemas ?? {};
	for (const [name, schema] of Object.entries(previousSchemas)) {
		const currentSchema = currentSchemas[name];
		if (currentSchema === undefined) {
			changes.push(`removed schema $defs.${name}`);
			continue;
		}
		compareSchema(schema, currentSchema, `$defs.${name}`, changes);
	}
	if (previous.openapi !== undefined) {
		compareOpenApiPaths(previous, current, changes);
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
if (
	(arguments_.previous === undefined) !==
	(arguments_.current === undefined)
) {
	throw new Error(usage);
}
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
