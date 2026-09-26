import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const artifactRelativePaths = [
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
		"cd5b8fc76501e7f9e3dafaa0e1d6b4282d5222c86b8a4d5269a0c11d0fa4af1e"
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

function findBreakingChanges(previous, current) {
	const changes = [];
	if (previous.openapi !== undefined) {
		if (
			!sameValue(previous, current) &&
			!isModelSelectionFallbackOpenApiAddition(previous, current) &&
			!isAgentSummaryOpenApiAddition(previous, current) &&
			!isRuntimeStatusRecoveryOpenApiAddition(previous, current) &&
			!isAgentLifecycleV2OpenApiAddition(previous, current) &&
			!isDeploymentConfigurationV2OpenApiAddition(previous, current) &&
			!isAgentOwnerScopeOpenApiAddition(previous, current) &&
			!isConversationFactsV2OpenApiAddition(previous, current) &&
			!isWecomReceiptOpenApiAddition(previous, current) &&
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
