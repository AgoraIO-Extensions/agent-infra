import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const artifactRelativePaths = [
	"packages/contracts/artifacts/openapi/enterprise-directory.v1.openapi.json",
	"packages/contracts/artifacts/json-schema/files.v1.schema.json",
	"packages/contracts/artifacts/openapi/files.v1.openapi.json",
	"packages/contracts/artifacts/json-schema/common.v1.schema.json",
	"packages/contracts/artifacts/json-schema/kubernetes-workload.v1.schema.json",
	"packages/contracts/artifacts/json-schema/pilot-delegated.v1.schema.json",
	"packages/contracts/artifacts/json-schema/pilot-sse.v1.schema.json",
	"packages/contracts/artifacts/json-schema/pilot-sse.v2.schema.json",
	"packages/contracts/artifacts/json-schema/registry-manifest.v1.schema.json",
	"packages/contracts/artifacts/json-schema/secret-lifecycle.v1.schema.json",
	"packages/contracts/artifacts/json-schema/worker-result.v1.schema.json",
	"packages/contracts/artifacts/json-schema/runtime.v1.schema.json",
	"packages/contracts/artifacts/json-schema/runtime.v2.schema.json",
	"packages/contracts/artifacts/json-schema/runtime.v3.schema.json",
	"packages/contracts/artifacts/json-schema/runtime-readiness.v1.schema.json",
	"packages/contracts/artifacts/openapi/common.v1.openapi.json",
	"packages/contracts/artifacts/openapi/pilot-browser.v1.openapi.json",
	"packages/contracts/artifacts/openapi/pilot-browser.v2.openapi.json",
	"packages/contracts/artifacts/openapi/platform-auth.v1.openapi.json",
	"packages/contracts/artifacts/openapi/pilot-delegated.v1.openapi.json",
	"packages/contracts/artifacts/openapi/runtime-host.v1.openapi.json",
	"packages/contracts/artifacts/openapi/runtime-host.v2.openapi.json",
	"packages/contracts/artifacts/openapi/runtime-host.v3.openapi.json",
	"packages/contracts/artifacts/openapi/runtime-readiness.v1.openapi.json",
	"packages/contracts/artifacts/openapi/standard-template-release.v1.openapi.json",
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
	if (leftValues !== undefined || rightValues !== undefined) {
		return (
			leftValues !== undefined &&
			rightValues !== undefined &&
			leftValues.every(
				(leftValue) =>
					!rightValues.some((rightValue) => sameValue(leftValue, rightValue)),
			)
		);
	}
	if (
		!left ||
		!right ||
		typeof left !== "object" ||
		typeof right !== "object" ||
		!sameValue(valueSet(left.type), ["object"]) ||
		!sameValue(valueSet(right.type), ["object"])
	) {
		return false;
	}
	const leftRequired = new Set(left.required ?? []);
	const rightRequired = new Set(right.required ?? []);
	return Object.entries(left.properties ?? {}).some(([name, leftProperty]) => {
		if (!leftRequired.has(name) || !rightRequired.has(name)) return false;
		const rightProperty = right.properties?.[name];
		const leftPropertyValues = literalValues(leftProperty);
		const rightPropertyValues = literalValues(rightProperty);
		return (
			leftPropertyValues !== undefined &&
			rightPropertyValues !== undefined &&
			leftPropertyValues.every(
				(leftValue) =>
					!rightPropertyValues.some((rightValue) =>
						sameValue(leftValue, rightValue),
					),
			)
		);
	});
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

function hasExactObjectKeys(value, keys) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		sameValue(Object.keys(value).sort(), [...keys].sort())
	);
}

function isModelSelectionFallbackOpenApiAddition(previous, current) {
	const componentName = "ModelSelectionFallbackEventV1";
	const persistedName = "PersistedConversationEventV1";
	const fallbackRef = {
		$ref: "#/components/schemas/ModelSelectionFallbackEventV1",
	};
	const previousSchemas = previous.components?.schemas ?? {};
	const currentSchemas = current.components?.schemas ?? {};
	if (
		Object.hasOwn(previousSchemas, componentName) ||
		!Object.hasOwn(currentSchemas, componentName) ||
		!sameValue(
			Object.keys(currentSchemas)
				.filter((name) => !Object.hasOwn(previousSchemas, name))
				.sort(),
			[componentName],
		)
	) {
		return false;
	}

	const previousOptions = previousSchemas[persistedName]?.oneOf;
	const currentOptions = currentSchemas[persistedName]?.oneOf;
	if (!Array.isArray(previousOptions) || !Array.isArray(currentOptions)) {
		return false;
	}
	const addedOptions = unmatchedOptions(currentOptions, previousOptions);
	if (
		unmatchedOptions(previousOptions, currentOptions).length !== 0 ||
		addedOptions.length !== 1 ||
		!sameValue(addedOptions[0], fallbackRef)
	) {
		return false;
	}

	const fallback = currentSchemas[componentName];
	const payload = fallback?.properties?.payload;
	const payloadFields = ["modelOptionId", "reasoningLevel", "reason"];
	if (
		fallback?.type !== "object" ||
		fallback.additionalProperties !== false ||
		!hasExactObjectKeys(payload, [
			"additionalProperties",
			"properties",
			"required",
			"type",
		]) ||
		payload.type !== "object" ||
		payload.additionalProperties !== false ||
		!hasExactObjectKeys(payload.properties, payloadFields) ||
		!Array.isArray(payload.required) ||
		!sameValue([...payload.required].sort(), [...payloadFields].sort()) ||
		!sameValue(payload.properties.modelOptionId, {
			minLength: 1,
			type: "string",
		}) ||
		!sameValue(payload.properties.reasoningLevel, {
			minLength: 1,
			type: "string",
		}) ||
		!sameValue(payload.properties.reason, {
			const: "selection_unavailable",
			type: "string",
		}) ||
		!sameValue(fallback.properties.type, {
			const: "model.selection.fell_back",
			type: "string",
		}) ||
		!previousOptions.every((option) =>
			literalSchemasAreDisjoint(fallback, option),
		)
	) {
		return false;
	}

	const envelopeTemplate = previousOptions[0];
	if (!envelopeTemplate?.properties) return false;
	const normalizedFallback = structuredClone(fallback);
	normalizedFallback.properties.type = envelopeTemplate.properties.type;
	normalizedFallback.properties.payload = envelopeTemplate.properties.payload;
	if (!sameValue(normalizedFallback, envelopeTemplate)) return false;

	const normalized = structuredClone(current);
	delete normalized.components.schemas[componentName];
	const normalizedOptions = normalized.components.schemas[persistedName].oneOf;
	const fallbackIndex = normalizedOptions.findIndex((option) =>
		sameValue(option, fallbackRef),
	);
	if (fallbackIndex === -1) return false;
	normalizedOptions.splice(fallbackIndex, 1);
	return sameValue(previous, normalized);
}

function isAgentSummaryOpenApiAddition(previous, current) {
	const componentName = "ExecutionProcessSummaryV1";
	const previousOptions = previous.components?.schemas?.[componentName]?.oneOf;
	const currentOptions = current.components?.schemas?.[componentName]?.oneOf;
	if (!Array.isArray(previousOptions) || !Array.isArray(currentOptions)) {
		return false;
	}
	const addedOptions = unmatchedOptions(currentOptions, previousOptions);
	if (
		unmatchedOptions(previousOptions, currentOptions).length !== 0 ||
		addedOptions.length !== 1
	) {
		return false;
	}

	const summary = addedOptions[0];
	const template = previousOptions[0];
	const fields = ["callId", "category", "kind", "occurredAt", "summary"];
	if (
		summary?.type !== "object" ||
		summary.additionalProperties !== false ||
		!hasExactObjectKeys(summary, [
			"additionalProperties",
			"properties",
			"required",
			"type",
		]) ||
		!hasExactObjectKeys(summary.properties, fields) ||
		!sameValue(summary.required, [
			"occurredAt",
			"kind",
			"category",
			"summary",
		]) ||
		!sameValue(summary.properties.kind, {
			const: "agent_summary",
			type: "string",
		}) ||
		!sameValue(summary.properties.category, {
			enum: ["status", "model_call", "connection_call"],
			type: "string",
		}) ||
		!sameValue(summary.properties.callId, {
			minLength: 1,
			type: "string",
		}) ||
		!sameValue(
			summary.properties.occurredAt,
			template?.properties?.occurredAt,
		) ||
		!sameValue(summary.properties.summary, template?.properties?.summary) ||
		!previousOptions.every((option) =>
			literalSchemasAreDisjoint(summary, option),
		)
	) {
		return false;
	}

	const normalized = structuredClone(current);
	const normalizedOptions = normalized.components.schemas[componentName].oneOf;
	const summaryIndex = normalizedOptions.findIndex((option) =>
		sameValue(option, summary),
	);
	if (summaryIndex === -1) return false;
	normalizedOptions.splice(summaryIndex, 1);
	return sameValue(previous, normalized);
}

// #508 exposes only the original accepted V4 binding through a V3 control read.
function isRuntimeOriginalBindingV3OpenApiAddition(previous, current) {
	const path = "/internal/runtime/v3/original-binding";
	const responseName = "RuntimeOriginalBindingResponseV3";
	if (
		previous.paths?.[path] !== undefined ||
		previous.components?.schemas?.[responseName] !== undefined
	)
		return false;
	const addition = {
		path: current.paths?.[path],
		response: current.components?.schemas?.[responseName],
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"1347a9c19999f2a62f397fa830faa1d12308c6590dc89f0ce20f668373073325"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	delete normalized.components.schemas[responseName];
	return sameValue(previous, normalized);
}

function isRuntimeStatusRecoveryOpenApiAddition(previous, current) {
	const path = "/internal/runtime/v2/status";
	const requestName = "RuntimeStatusRequestV2";
	const responseName = "RuntimeStatusResponseV2";
	const previousSchemas = previous.components?.schemas;
	const currentSchemas = current.components?.schemas;
	const addedPath = current.paths?.[path];
	const request = currentSchemas?.[requestName];
	const response = currentSchemas?.[responseName];
	const additionDigest = createHash("sha256")
		.update(JSON.stringify({ path: addedPath, request, response }))
		.digest("hex");
	if (
		previous.paths?.[path] !== undefined ||
		previousSchemas?.[requestName] !== undefined ||
		previousSchemas?.[responseName] !== undefined ||
		additionDigest !==
			"510b6dba362d2775a80c93fa454014f1fc0bdf2a2651f4aa1e7d15d84f6c9ddf"
	) {
		return false;
	}
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	delete normalized.components.schemas[requestName];
	delete normalized.components.schemas[responseName];
	return sameValue(previous, normalized);
}

// #504 adds versioned management routes. Preserve the published audit contract
// exactly and admit only this immutable addition, as for Runtime recovery above.
function withoutAgentOwnerScope(operation) {
	const normalized = structuredClone(operation);
	if (Array.isArray(normalized?.parameters)) {
		normalized.parameters = normalized.parameters.filter(
			(parameter) =>
				!(parameter?.in === "query" && parameter?.name === "scope"),
		);
	}
	return normalized;
}

// The owner projection is an optional, server-authorized narrowing of the
// existing Agent list. It does not change the default visible-Agent contract.
function isAgentOwnerScopeOpenApiAddition(previous, current) {
	const path = "/api/v2/agents";
	const previousOperation = previous.paths?.[path]?.get;
	const currentOperation = current.paths?.[path]?.get;
	if (!previousOperation || !currentOperation) return false;
	const addedParameters = (currentOperation.parameters ?? []).filter(
		(parameter) =>
			!(previousOperation.parameters ?? []).some((previousParameter) =>
				sameValue(previousParameter, parameter),
			),
	);
	if (
		addedParameters.length !== 1 ||
		!sameValue(addedParameters[0], {
			in: "query",
			name: "scope",
			schema: { const: "owner", type: "string" },
		})
	)
		return false;
	const normalized = structuredClone(current);
	normalized.paths[path].get = withoutAgentOwnerScope(currentOperation);
	return sameValue(previous, normalized);
}

// #1023 adds one browser administrator read; all prior guards still apply.
function isAdministratorAgentReadV2OpenApiAddition(previous, current) {
	const path = "/api/v2/admin/agents";
	if (
		previous.paths?.[path] !== undefined ||
		createHash("sha256")
			.update(JSON.stringify(current.paths?.[path] ?? null))
			.digest("hex") !==
			"eaf53701db321fee9e8323d85d6b77d68043e95d12c6f1f36fe3c10dd0c7bfb8"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	return findBreakingChanges(previous, normalized).length === 0;
}

// #1059 admits only browser personal issuance/revocation. Preserve all old bytes.
function isPersonalApiCredentialV2OpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/me/api-credentials",
		"/api/v2/me/api-credentials/{credentialId}",
	];
	const schemas = [
		"PersonalApiCredentialIssueRequestV1",
		"PersonalApiCredentialIssueResponseV1",
		"PersonalApiCredentialMetadataV1",
		"PersonalApiCredentialRevokeResponseV1",
	];
	if (
		paths.some((path) => previous.paths?.[path] !== undefined) ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const security = {
		PlatformSession: current.components?.securitySchemes?.PlatformSession,
	};
	for (const [name, definition] of Object.entries(security)) {
		const existing = previous.components?.securitySchemes?.[name];
		if (existing !== undefined && !sameValue(existing, definition))
			return false;
	}
	const addition = {
		paths: Object.fromEntries(
			paths.map((path) => [path, current.paths?.[path]]),
		),
		schemas: Object.fromEntries(
			schemas.map((name) => [name, current.components?.schemas?.[name]]),
		),
		security,
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"fb689d0afa1624783e81bbb18aa1d48d4c8ab4045787f6cb101801e9cefed2c7"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	for (const name of Object.keys(security)) {
		if (previous.components?.securitySchemes?.[name] === undefined) {
			delete normalized.components.securitySchemes[name];
		}
	}
	if (
		Object.keys(normalized.components.securitySchemes).length === 0 &&
		previous.components?.securitySchemes === undefined
	) {
		delete normalized.components.securitySchemes;
	}
	return sameValue(previous, normalized);
}

// #1167 admits only the reviewed self-registration POST and metadata schemas.
function isApplicationRegistrationV2OpenApiAddition(previous, current) {
	const path = "/api/v2/applications";
	const schemas = [
		"ApplicationMetadataV1",
		"ApplicationRegistrationRequestV1",
		"ApplicationRegistrationResponseV1",
	];
	if (
		previous.paths?.[path] !== undefined ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const addition = {
		path: current.paths?.[path],
		schemas: Object.fromEntries(
			schemas.map((name) => [name, current.components?.schemas?.[name]]),
		),
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"b691f8eaca8307dda272c5bc772f4614dae62b54f16dcc3e08b661a98db5b720"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #1219 admits the exact disable command while preserving every prior contract.
function isOwnApplicationDisableV2OpenApiAddition(previous, current) {
	const path = "/api/v2/applications/{applicationId}";
	const schema = "ApplicationDisableRequestV1";
	if (
		!previous.paths?.[path] ||
		previous.paths[path].patch !== undefined ||
		previous.components?.schemas?.[schema] !== undefined
	)
		return false;
	const addition = {
		patch: current.paths?.[path]?.patch,
		schema: current.components?.schemas?.[schema],
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"6ef266859d48ccbac5c7ef73c943f8d95bf3e9dea4c58c99922fbc173d17a5ca"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path].patch;
	delete normalized.components.schemas[schema];
	return sameValue(previous, normalized);
}

// #1166 admits only the reviewed own-application metadata GET.
function isOwnApplicationMetadataV2OpenApiAddition(previous, current) {
	const path = "/api/v2/applications/{applicationId}";
	if (previous.paths?.[path] !== undefined) return false;
	if (
		createHash("sha256")
			.update(JSON.stringify(current.paths?.[path] ?? null))
			.digest("hex") !==
		"a555914e670700aad94d9ad8b2c3263a9cd8abe14f342dc93a0a74bf21107275"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	return sameValue(previous, normalized);
}

// #1233 admits only the application credential material grant metadata routes.
function isApplicationMaterialGrantV2OpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/applications/{applicationId}/material-grant",
		"/api/v2/applications/{applicationId}/material-grant/{principalType}/{principalId}",
	];
	if (paths.some((path) => previous.paths?.[path] !== undefined)) return false;
	const addition = {
		paths: Object.fromEntries(
			paths.map((path) => [path, current.paths?.[path]]),
		),
	};
	if (
		![
			"6bf8b1cd3ef226b56b1669dd3b2cc359a8e2384c5fe30aa67f9cc06d91d81aae",
			"acdf227e2129f2fc1d8d862d8101cc79825d1a8bf87638e4cdae7196b77be70d",
		].includes(
			createHash("sha256").update(JSON.stringify(addition)).digest("hex"),
		)
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	return findBreakingChanges(previous, normalized).length === 0;
}

function isAgentLifecycleV2OpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/admin/agent-applications",
		"/api/v2/admin/agent-applications/{applicationId}/decision",
		"/api/v2/agent-applications",
		"/api/v2/agent-applications/{applicationId}",
		"/api/v2/agent-applications/{applicationId}/withdraw",
		"/api/v2/agents",
		"/api/v2/agents/{agentId}",
		"/api/v2/agents/{agentId}/configuration",
		"/api/v2/agents/{agentId}/lifecycle",
	];
	const schemas = [
		"AgentApplicationCreateRequestV2",
		"AgentApplicationProjectionV2",
		"AgentApplicationUpdateRequestV2",
		"AgentConfigurationProjectionV2",
		"AgentConfigurationUpdateRequestV2",
		"AgentLifecycleCommandRequestV1",
		"AgentProjectionV2",
		"ApprovalDecisionRequestV1",
	];
	if (
		paths.some((path) => previous.paths?.[path] !== undefined) ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const normalizedAgentsPath = withoutAgentOwnerScope(
		current.paths["/api/v2/agents"]?.get,
	);
	const addition = {
		paths: Object.fromEntries(
			paths.map((path) => [
				path,
				path === "/api/v2/agents"
					? { ...current.paths?.[path], get: normalizedAgentsPath }
					: current.paths?.[path],
			]),
		),
		schemas: Object.fromEntries(
			schemas.map((name) => [name, current.components?.schemas?.[name]]),
		),
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"75bcba81cd9d5ab09407ea0ad48f23bc086bb9d9545f25796a0e1fce737a8a58"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #796 exposes deployment-owned, credential-free choices to the Web client.
function isDeploymentConfigurationV2OpenApiAddition(previous, current) {
	const path = "/api/v2/deployment/configuration";
	const schemas = [
		"DeploymentConfigurationProjectionV2",
		"DeploymentConfigurationStatusV2",
		"DeploymentModelCatalogProjectionV2",
		"DeploymentModelEndpointProjectionV2",
		"DeploymentModelProjectionV2",
		"DeploymentTemplateProjectionV2",
	];
	if (
		previous.paths?.[path] !== undefined ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const addition = {
		paths: { [path]: current.paths?.[path] },
		schemas: Object.fromEntries(
			schemas.map((name) => [name, current.components?.schemas?.[name]]),
		),
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"488d119343f8fec88d022b85688e1661619dc4bf9e74839bf171d8b6de817f20"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return (
		sameValue(previous, normalized) ||
		isAgentLifecycleV2OpenApiAddition(previous, normalized)
	);
}

// Only the reviewed #442 additive file surface may differ; every old contract remains exact.
function isFileAuthorityOpenApiAddition(previous, current) {
	const paths = [
		"/api/v1/conversations/{conversationId}/files",
		"/api/v1/conversations/{conversationId}/files/limits",
		"/api/v1/conversations/{conversationId}/files/{fileId}/access",
		"/api/v1/conversations/{conversationId}/files/{fileId}/complete",
		"/api/v1/conversations/{conversationId}/files/{fileId}/content",
	];
	const names = [
		"FileAccessClaimsV1",
		"FileAccessGrantV1",
		"FileAccessRequestV1",
		"FileAccessResponseV1",
		"FileCompleteRequestV1",
		"FileDescriptorV1",
		"FileExchangeRequestV1",
		"FileIntentRequestV1",
		"FileLimitsV1",
		"FileProjectionV1",
	];
	const schemas = current.components?.schemas;
	const message = schemas?.MessageCommandRequestV1;
	if (
		!message ||
		previous.components?.schemas?.MessageCommandRequestV1?.properties
			?.attachments !== undefined ||
		paths.some((path) => previous.paths?.[path] !== undefined) ||
		names.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const addition = {
		paths: Object.fromEntries(
			paths.map((path) => [path, current.paths?.[path]]),
		),
		schemas: Object.fromEntries(names.map((name) => [name, schemas[name]])),
		attachments: message.properties?.attachments,
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"95fd628301e1454552aeb6e42dbe7e0fb2bde941f781707025147af7b758f724"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of names) delete normalized.components.schemas[name];
	delete normalized.components.schemas.MessageCommandRequestV1.properties
		.attachments;
	return sameValue(previous, normalized);
}

// #508 adds V2 operation history/SSE without altering published management/audit.
function isConversationFactsV2OpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/conversations/{conversationId}",
		"/api/v2/conversations/{conversationId}/events",
		"/api/v2/conversations/{conversationId}/executions/{executionId}",
	];
	const schemas = [
		"AuthorizationRevokedSignalV1",
		"ConversationDetailProjectionV2",
		"ConversationSseMessageV1",
		"ConversationSseMessageV2",
		"ExecutionDetailProjectionV2",
		"ExecutionOperationEventV2",
		"HeartbeatSignalV1",
		"ModelSelectionFallbackEventV1",
		"PersistedConversationEventV1",
		"PersistedConversationEventV2",
		"RuntimeConnectionAssociationV1",
		"RuntimeOperationFactV2",
		"RuntimeOperationFailureV2",
		"SseEventIdV1",
		"TimelineReloadSignalV1",
	];
	if (
		paths.some((path) => previous.paths?.[path] !== undefined) ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const addition = {
		paths: Object.fromEntries(
			paths.map((path) => [path, current.paths?.[path]]),
		),
		schemas: Object.fromEntries(
			schemas.map((name) => [name, current.components?.schemas?.[name]]),
		),
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"097d6b3631a284fd8faf916f2c35a70d7c721c8bc832f3b97a96389fecfc541f"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return (
		sameValue(previous, normalized) ||
		isAgentLifecycleV2OpenApiAddition(previous, normalized)
	);
}

// #1010 publishes the existing resource-unavailable error for V2 SSE reads.
function isConversationSseV2NotFoundAddition(previous, current) {
	const path = "/api/v2/conversations/{conversationId}/events";
	const previousResponses = previous.paths?.[path]?.get?.responses;
	const currentResponses = current.paths?.[path]?.get?.responses;
	const expected =
		previous.paths?.["/api/v2/conversations/{conversationId}"]?.get
			?.responses?.["404"];
	if (
		!previousResponses ||
		previousResponses["404"] !== undefined ||
		expected === undefined ||
		!sameValue(currentResponses?.["404"], expected)
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path].get.responses["404"];
	return sameValue(previous, normalized);
}

// #1052 publishes the exact #1027 recent read; every prior document field stays exact.
function isRecentPersonalConversationsV2OpenApiAddition(previous, current) {
	const path = "/api/v2/me/conversations/recent";
	const scheme = current.components?.securitySchemes?.PlatformSession;
	const addition = { path: current.paths?.[path], securityScheme: scheme };
	if (
		previous.paths?.[path] !== undefined ||
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
			"4d30e31df6c7267739b9ebc4b224f07cb384e3147ad2181a9aeba4cdabc75006"
	)
		return false;
	const previousScheme = previous.components?.securitySchemes?.PlatformSession;
	if (previousScheme !== undefined && !sameValue(previousScheme, scheme))
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	if (previousScheme === undefined) {
		delete normalized.components.securitySchemes.PlatformSession;
		if (
			previous.components?.securitySchemes === undefined &&
			Object.keys(normalized.components.securitySchemes).length === 0
		)
			delete normalized.components.securitySchemes;
	}
	return sameValue(previous, normalized);
}

// #440 adds bounded receipt management and Owner-scoped bot setup.
function isWecomReceiptOpenApiAddition(previous, current) {
	const paths = [
		"/api/v1/wecom/receipts",
		"/api/v1/wecom/receipts/{receiptId}",
		"/api/v1/wecom/receipts/{receiptId}/abandon",
		"/api/v1/agents/{agentId}/wecom-bot",
		"/api/v1/agents/{agentId}/wecom-setup",
		"/api/v1/agents/{agentId}/wecom-setup/{sessionId}",
		"/api/v1/agents/{agentId}/wecom-setup/{sessionId}/cancel",
		"/api/v1/agents/{agentId}/wecom-setup/{sessionId}/credentials",
	];
	if (paths.some((path) => previous.paths?.[path] !== undefined)) return false;
	const addition = Object.fromEntries(
		paths.map((path) => [path, current.paths?.[path]]),
	);
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"f5331d7d488eca753adaf413088b91f6050fc07def829902db17494ef7aa49f1"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	return sameValue(previous, normalized);
}

// #440 publishes Owner-managed application setup on the existing browser API.
function isWecomApplicationOpenApiAddition(previous, current) {
	const paths = [
		"/api/v1/agents/{agentId}/wecom-app",
		"/api/v1/agents/{agentId}/wecom-app-setup",
		"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}",
		"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}/credentials",
		"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}/cancel",
	];
	if (paths.some((path) => previous.paths?.[path] !== undefined)) return false;
	const addition = Object.fromEntries(
		paths.map((path) => [path, current.paths?.[path]]),
	);
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"d06bab756ce486299973d81c082e0b88ea18962fba541d10479ed5e428c1b0ef"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	return findBreakingChanges(previous, normalized).length === 0;
}

// #481 publishes the scoped Platform audit surface and its bounded action set.
function isScopedAuditOpenApiAddition(previous, current) {
	const paths = [
		"/api/v1/audit",
		"/api/v1/audit/{auditId}",
		"/api/v3/admin/audit",
		"/api/v3/admin/audit/{auditId}",
	];
	const schemas = [
		"ScopedPlatformAuditActionV1",
		"ScopedPlatformAuditPageV1",
		"ScopedPlatformAuditProjectionV1",
		"ScopedPlatformAuditResultV1",
	];
	if (
		paths.some((path) => previous.paths?.[path] !== undefined) ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const addition = {
		paths: Object.fromEntries(
			paths.map((path) => [path, current.paths?.[path]]),
		),
		schemas: Object.fromEntries(
			schemas.map((name) => [name, current.components?.schemas?.[name]]),
		),
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"bf0c18ff1e607bd2049d2b2e764a88aeb01416bb15da8dbd635feac02ad33d42"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return findBreakingChanges(previous, normalized).length === 0;
}

// #481 documents the actual scoped audit cookie/Bearer entry points only.
function isScopedAuditCredentialSecurityAddition(previous, current) {
	const paths = [
		"/api/v1/audit",
		"/api/v1/audit/{auditId}",
		"/api/v3/admin/audit",
		"/api/v3/admin/audit/{auditId}",
	];
	const schemes = {
		platformApiCredential: { type: "http", scheme: "bearer" },
		PlatformSession: {
			type: "apiKey",
			in: "cookie",
			name: "__Host-platform-session",
		},
	};
	const normalized = structuredClone(current);
	for (const [name, scheme] of Object.entries(schemes)) {
		if (!isDeepStrictEqual(current.components?.securitySchemes?.[name], scheme))
			return false;
		const oldScheme = previous.components?.securitySchemes?.[name];
		if (oldScheme !== undefined && !isDeepStrictEqual(oldScheme, scheme))
			return false;
		if (oldScheme === undefined)
			delete normalized.components.securitySchemes[name];
	}
	if (
		previous.components?.securitySchemes === undefined &&
		Object.keys(normalized.components.securitySchemes).length === 0
	)
		delete normalized.components.securitySchemes;
	for (const path of paths) {
		const own = path.startsWith("/api/v1/");
		const expected = own
			? [{ PlatformSession: [] }, { platformApiCredential: [] }]
			: [{ PlatformSession: [] }];
		const legacy = own ? [{}] : [];
		if (!sameValue(current.paths?.[path]?.get?.security, expected))
			return false;
		const old = previous.paths?.[path]?.get?.security;
		if (previous.paths?.[path] !== undefined && !sameValue(old, legacy))
			return false;
		normalized.paths[path].get.security = legacy;
	}
	return findBreakingChanges(previous, normalized).length === 0;
}

// #1060 extends only the canonical audit action at its existing schema locations.
function withoutPersonalApiAgentReadAudit(previous, current) {
	const normalized = structuredClone(current);
	let additions = 0;
	const digest = (value) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	function normalize(oldValue, newValue) {
		if (
			!oldValue ||
			!newValue ||
			typeof oldValue !== "object" ||
			typeof newValue !== "object"
		)
			return;
		if (
			Array.isArray(oldValue.enum) &&
			Array.isArray(newValue.enum) &&
			digest(oldValue.enum) ===
				"a6aecc0649885bcee5c2a40342a9b6a4adff5c4f66e7022e5d6f2233bed8dc85" &&
			digest(newValue.enum) ===
				"f5a1dca74b127815a080d4c3f30e16fd897ad6be5b31fae6f811353778081b5e"
		) {
			newValue.enum = structuredClone(oldValue.enum);
			additions += 1;
		}
		for (const key of Object.keys(oldValue))
			normalize(oldValue[key], newValue[key]);
	}
	normalize(previous, normalized);
	return additions > 0 ? normalized : undefined;
}

function isPersonalApiAgentReadAuditOpenApiAddition(previous, current) {
	const normalized = withoutPersonalApiAgentReadAudit(previous, current);
	return normalized !== undefined && sameValue(previous, normalized);
}

// Preserve the #1059 guard and compose its exact addition with this read slice.
function isPersonalApiAgentReadV2OpenApiAddition(previous, current) {
	const path = "/api/v2/agents";
	const previousRead = previous.paths?.[path]?.get;
	const currentRead = current.paths?.[path]?.get;
	if (
		!previousRead ||
		!currentRead ||
		previousRead.security !== undefined ||
		previousRead.description !== undefined ||
		previous.components?.securitySchemes?.platformApiCredential !== undefined
	)
		return false;
	const addition = {
		security: current.components?.securitySchemes?.platformApiCredential,
		agentRead: {
			security: currentRead.security,
			description: currentRead.description,
		},
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"32fc47a11f0ef7eabc2b68b4c50d2c8965ac10d7e674b681fb0ecc8f1df17954"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path].get.security;
	delete normalized.paths[path].get.description;
	delete normalized.components.securitySchemes.platformApiCredential;
	const baseline =
		withoutPersonalApiAgentReadAudit(previous, normalized) ?? normalized;
	return (
		sameValue(previous, baseline) ||
		isPersonalApiCredentialV2OpenApiAddition(previous, baseline)
	);
}

// #1089 extends only the existing canonical V1 audit enum.
function isPersonalRelayKeyAuditOpenApiAddition(previous, current) {
	const oldAction = previous.components?.schemas?.ScopedPlatformAuditActionV1;
	const newAction = current.components?.schemas?.ScopedPlatformAuditActionV1;
	const digest = (value) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	if (
		!Array.isArray(oldAction?.enum) ||
		!Array.isArray(newAction?.enum) ||
		![
			"a6aecc0649885bcee5c2a40342a9b6a4adff5c4f66e7022e5d6f2233bed8dc85",
			"f5a1dca74b127815a080d4c3f30e16fd897ad6be5b31fae6f811353778081b5e",
		].includes(digest(oldAction.enum)) ||
		digest(newAction.enum) !==
			"d946b62e4f34078c1f3569524d09a09ce7a68e108cbeda06d255527e47e71ac9"
	)
		return false;
	const normalized = structuredClone(current);
	normalized.components.schemas.ScopedPlatformAuditActionV1.enum =
		newAction.enum.filter(
			(action) =>
				![
					"relay_key.personal.read",
					"relay_key.personal.replace",
					"relay_key.personal.revoke",
				].includes(action),
		);
	// The remaining #1060 addition must still pass its original exact guard.
	return findBreakingChanges(previous, normalized).length === 0;
}

// #1260 adds one write-only create input; every other request and route stays exact.
function isApplicationDefaultRelayKeyV2OpenApiAddition(previous, current) {
	const name = "AgentApplicationCreateRequestV2";
	const previousSchema = previous.components?.schemas?.[name];
	const currentSchema = current.components?.schemas?.[name];
	if (
		previousSchema?.properties?.defaultRelayKey !== undefined ||
		!isDeepStrictEqual(currentSchema?.properties?.defaultRelayKey, {
			minLength: 1,
			type: "string",
			writeOnly: true,
		}) ||
		currentSchema?.required?.includes("defaultRelayKey")
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.components.schemas[name].properties.defaultRelayKey;
	return findBreakingChanges(previous, normalized).length === 0;
}

// #1260 admits only these exact session-bound default Key operations.
function isAgentDefaultRelayKeyV2OpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/agents/{agentId}/default-relay-key",
		"/api/v2/agents/{agentId}/default-relay-key/candidates",
	];
	if (paths.some((path) => previous.paths?.[path] !== undefined)) return false;
	const addition = Object.fromEntries(
		paths.map((path) => [path, current.paths?.[path]]),
	);
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"cb5d42ff2f8ad50c3c85325e38e6f5ff40fdef88e65744033406a2016929f310"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	return findBreakingChanges(previous, normalized).length === 0;
}

// #1089 admits exactly the browser-owned Key path, three closed schemas and session scheme.
function isPersonalRelayKeyV2OpenApiAddition(previous, current) {
	const path = "/api/v2/me/relay-key";
	const names = [
		"PersonalRelayKeyStateV1",
		"PersonalRelayKeyReplaceRequestV1",
		"PersonalRelayKeyRevokeRequestV1",
	];
	if (
		previous.paths?.[path] !== undefined ||
		names.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const security = {
		PlatformSession: current.components?.securitySchemes?.PlatformSession,
	};
	const previousSession = previous.components?.securitySchemes?.PlatformSession;
	if (
		previousSession !== undefined &&
		!sameValue(previousSession, security.PlatformSession)
	)
		return false;
	const addition = {
		paths: { [path]: current.paths?.[path] },
		schemas: Object.fromEntries(
			names.map((name) => [name, current.components?.schemas?.[name]]),
		),
		security,
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"f7c4d58dc9cfdd02792216bb617e4522ca0a8a8fe85ab2f4d2398a25887d6c95"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	for (const name of names) delete normalized.components.schemas[name];
	// Keep the session scheme: only existing pinned admissions may introduce it.
	return findBreakingChanges(previous, normalized).length === 0;
}

// #1037 GET slice: only the exact metadata read, two schemas and read audit action.
function isPersonalCredentialListOpenApiAddition(previous, current) {
	const path = "/api/v2/me/api-credentials";
	const names = [
		"PersonalApiCredentialListQueryV1",
		"PersonalApiCredentialPageV1",
	];
	if (
		previous.paths?.[path]?.get !== undefined ||
		names.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const addition = {
		get: current.paths?.[path]?.get,
		schemas: Object.fromEntries(
			names
				.filter((name) => current.components?.schemas?.[name] !== undefined)
				.map((name) => [name, current.components.schemas[name]]),
		),
		audit: current.components?.schemas?.ScopedPlatformAuditActionV1,
	};
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(addition))
		.digest("hex");
	if (
		![
			"a0900c9a7aea8b1a7142081b2d733cca4e92030f66d93bf81c76993096503131",
			"5d170cf871a434be99dff5f43a54c362ab26e25b2d87714041e506c1429d5962",
		].includes(fingerprint)
	)
		return false;
	const normalized = structuredClone(current);
	if (normalized.paths?.[path]) delete normalized.paths[path].get;
	for (const name of names) delete normalized.components.schemas[name];
	const actions = normalized.components.schemas.ScopedPlatformAuditActionV1;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) => action !== "api.credential.metadata.read",
		);
	return findBreakingChanges(previous, normalized).length === 0;
}

// #1037 PATCH slice: only exact narrowing, two schemas and the narrowed audit action.
function isPersonalCredentialNarrowOpenApiAddition(previous, current) {
	const path = "/api/v2/me/api-credentials/{credentialId}";
	const names = [
		"PersonalApiCredentialNarrowRequestV1",
		"PersonalApiCredentialNarrowResponseV1",
	];
	if (
		previous.paths?.[path]?.patch !== undefined ||
		names.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const addition = {
		patch: current.paths?.[path]?.patch,
		schemas: Object.fromEntries(
			names
				.filter((name) => current.components?.schemas?.[name] !== undefined)
				.map((name) => [name, current.components.schemas[name]]),
		),
		audit: current.components?.schemas?.ScopedPlatformAuditActionV1,
	};
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(addition))
		.digest("hex");
	if (
		![
			"857ae40bc4d5554d93a19ca415ebfda2a8f458ef0f2be854376536809bcc0cf5",
			"bf36bbcb1a655389800b6629fe243efee02a9aaca6cf46db5be7c8fb9753b195",
		].includes(fingerprint)
	)
		return false;
	const normalized = structuredClone(current);
	if (normalized.paths?.[path]) delete normalized.paths[path].patch;
	for (const name of names) delete normalized.components.schemas[name];
	const actions = normalized.components.schemas.ScopedPlatformAuditActionV1;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) => action !== "api.credential.narrowed",
		);
	return findBreakingChanges(previous, normalized).length === 0;
}

// #484 names the known credential object; every other contract field stays exact.
function isKnownCredentialAuditSubjectAddition(previous, current) {
	const kinds = [
		"agent_application",
		"agent",
		"secret",
		"secret_key",
		"grant",
		"unknown",
		"conversation",
		"execution",
		"configuration",
	];
	const subject = (document) =>
		document.components?.schemas?.ScopedPlatformAuditProjectionV1?.properties
			?.subject?.properties?.kind;
	const oldKind = subject(previous);
	if (
		(oldKind !== undefined && !sameValue(oldKind.enum, kinds)) ||
		!sameValue(subject(current)?.enum, [...kinds, "api_credential"])
	)
		return false;
	const normalized = structuredClone(current);
	subject(normalized).enum = kinds;
	return findBreakingChanges(previous, normalized).length === 0;
}

// #1270 admits only the pinned server-resolved capability; old contracts stay exact.
function isConnectionCapabilityOpenApiAddition(previous, current) {
	const path = "/api/v1/connection/capability";
	const name = "ConnectionCapabilityProjectionV1";
	if (
		previous.paths?.[path] !== undefined ||
		previous.components?.schemas?.[name] !== undefined
	)
		return false;
	const addition = {
		path: current.paths?.[path],
		schema: current.components?.schemas?.[name],
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"e1e46d38ed8749051748bbb54abfdd6674051907aa237dd38eae022ff63e9326"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	delete normalized.components.schemas[name];
	return findBreakingChanges(previous, normalized).length === 0;
}

function findBreakingChanges(previous, current) {
	const changes = [];
	if (previous.openapi !== undefined) {
		if (
			!sameValue(previous, current) &&
			!isConnectionCapabilityOpenApiAddition(previous, current) &&
			!isKnownCredentialAuditSubjectAddition(previous, current) &&
			!isPersonalCredentialNarrowOpenApiAddition(previous, current) &&
			!isPersonalCredentialListOpenApiAddition(previous, current) &&
			!isModelSelectionFallbackOpenApiAddition(previous, current) &&
			!isAgentSummaryOpenApiAddition(previous, current) &&
			!isRuntimeStatusRecoveryOpenApiAddition(previous, current) &&
			!isRuntimeOriginalBindingV3OpenApiAddition(previous, current) &&
			!isApplicationRegistrationV2OpenApiAddition(previous, current) &&
			!isOwnApplicationMetadataV2OpenApiAddition(previous, current) &&
			!isApplicationMaterialGrantV2OpenApiAddition(previous, current) &&
			!isOwnApplicationDisableV2OpenApiAddition(previous, current) &&
			!isAgentLifecycleV2OpenApiAddition(previous, current) &&
			!isDeploymentConfigurationV2OpenApiAddition(previous, current) &&
			!isAgentOwnerScopeOpenApiAddition(previous, current) &&
			!isAdministratorAgentReadV2OpenApiAddition(previous, current) &&
			!isPersonalApiCredentialV2OpenApiAddition(previous, current) &&
			!isPersonalApiAgentReadV2OpenApiAddition(previous, current) &&
			!isPersonalApiAgentReadAuditOpenApiAddition(previous, current) &&
			!isPersonalRelayKeyAuditOpenApiAddition(previous, current) &&
			!isPersonalRelayKeyV2OpenApiAddition(previous, current) &&
			!isAgentDefaultRelayKeyV2OpenApiAddition(previous, current) &&
			!isApplicationDefaultRelayKeyV2OpenApiAddition(previous, current) &&
			!isConversationFactsV2OpenApiAddition(previous, current) &&
			!isConversationSseV2NotFoundAddition(previous, current) &&
			!isRecentPersonalConversationsV2OpenApiAddition(previous, current) &&
			!isWecomReceiptOpenApiAddition(previous, current) &&
			!isWecomApplicationOpenApiAddition(previous, current) &&
			!isScopedAuditOpenApiAddition(previous, current) &&
			!isScopedAuditCredentialSecurityAddition(previous, current) &&
			!isFileAuthorityOpenApiAddition(previous, current)
		) {
			changes.push("changed OpenAPI contract");
		}
		return changes.sort();
	}
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
