import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const artifactRelativePaths = [
	"packages/contracts/artifacts/json-schema/browser-capability.v1.schema.json",
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
	"packages/contracts/artifacts/openapi/browser-capability.v1.openapi.json",
	"packages/contracts/artifacts/openapi/pilot-browser.v1.openapi.json",
	"packages/contracts/artifacts/openapi/pilot-browser.v2.openapi.json",
	"packages/contracts/artifacts/openapi/platform-auth.v1.openapi.json",
	"packages/contracts/artifacts/openapi/pilot-delegated.v1.openapi.json",
	"packages/contracts/artifacts/openapi/runtime-host.v1.openapi.json",
	"packages/contracts/artifacts/openapi/runtime-host.v2.openapi.json",
	"packages/contracts/artifacts/openapi/runtime-host.v3.openapi.json",
	"packages/contracts/artifacts/openapi/runtime-readiness.v1.openapi.json",
	"packages/contracts/artifacts/openapi/standard-template-release.v1.openapi.json",
	"packages/contracts/artifacts/openapi/standard-template-release.v2.openapi.json",
];
const gitArtifactMaxBufferBytes = 16 * 1024 * 1024;

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

// #1266 admits the Runtime-owned model directory and the Platform model
// projection. The additions are versioned and must be removable without
// changing any previously published operation or schema.
function isCustomAgentModelSelectionOpenApiAddition(previous, current) {
	const commandSchema = "ExecutionGrantCommandV1";
	const command = "model-directory.read";
	const runtimeSchemas = [
		"RuntimeModelDirectoryRequestV1",
		"RuntimeModelDirectoryDispatchRequestV1",
		"RuntimeModelDirectoryResponseV1",
	];
	const runtimeHasSchemas = runtimeSchemas.some(
		(name) => previous.components?.schemas?.[name] !== undefined,
	);
	const currentHasSchemas = runtimeSchemas.every(
		(name) => current.components?.schemas?.[name] !== undefined,
	);
	const previousHasPublishedDirectory =
		previous.components?.schemas?.RuntimeModelDirectoryRequestV1 !==
			undefined &&
		previous.components?.schemas?.RuntimeModelDirectoryResponseV1 !== undefined;
	if (
		previousHasPublishedDirectory &&
		previous.components?.schemas?.RuntimeModelDirectoryDispatchRequestV1 ===
			undefined &&
		current.components?.schemas?.RuntimeModelDirectoryDispatchRequestV1 !==
			undefined
	) {
		const normalized = structuredClone(current);
		delete normalized.components.schemas.RuntimeModelDirectoryDispatchRequestV1;
		return findBreakingChanges(previous, normalized).length === 0;
	}
	if (runtimeHasSchemas) return false;
	const previousCommands = previous.components?.schemas?.[commandSchema]?.enum;
	const currentCommands = current.components?.schemas?.[commandSchema]?.enum;
	const addition = {
		command,
		schemas: currentHasSchemas
			? Object.fromEntries(
					runtimeSchemas.map((name) => [
						name,
						current.components.schemas[name],
					]),
				)
			: {},
	};
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(addition))
		.digest("hex");
	if (
		!currentHasSchemas &&
		fingerprint !==
			"a4f9bbd58f3540591efb5f55bb5c6a296f1711a03e0c1fcbfb3eee47d11ded89"
	)
		return false;
	if (
		currentHasSchemas &&
		fingerprint !==
			"86876308c8233f9c95306b421e6bd622c60e974f6213e47e95830e14d14f9ba6"
	)
		return false;
	if (
		!Array.isArray(previousCommands) ||
		!Array.isArray(currentCommands) ||
		previousCommands.includes(command) ||
		!currentCommands.includes(command) ||
		currentCommands.length !== previousCommands.length + 1 ||
		!currentCommands.every(
			(value) => value === command || previousCommands.includes(value),
		) ||
		(runtimeHasSchemas && !currentHasSchemas) ||
		(!runtimeHasSchemas &&
			currentHasSchemas &&
			previous.components?.schemas?.RuntimeModelDirectoryRequestV1 !==
				undefined)
	)
		return false;
	const normalized = structuredClone(current);
	normalized.components.schemas[commandSchema].enum = currentCommands.filter(
		(value) => value !== command,
	);
	if (currentHasSchemas) {
		for (const name of runtimeSchemas)
			delete normalized.components.schemas[name];
	}
	return findBreakingChanges(previous, normalized).length === 0;
}

// #851 persists the non-sensitive JSON-RPC identity for Host-owned ACP tool
// facts. The fields are optional and only widen the existing tool branch.
function isRuntimeOperationIdentityOpenApiAddition(previous, current) {
	const previousFact = previous.components?.schemas?.RuntimeOperationFactV2;
	const currentFact = current.components?.schemas?.RuntimeOperationFactV2;
	if (
		!previousFact ||
		!currentFact ||
		!Array.isArray(previousFact.oneOf) ||
		!Array.isArray(currentFact.oneOf) ||
		previousFact.oneOf.length !== currentFact.oneOf.length
	)
		return isDeepStrictEqual(previous, stripRuntimeOperationIdentity(current));
	const previousTool = previousFact.oneOf.find(
		(option) => option.properties?.kind?.const === "tool",
	);
	const currentTool = currentFact.oneOf.find(
		(option) => option.properties?.kind?.const === "tool",
	);
	if (!previousTool || !currentTool) return false;
	if (
		previousTool.properties?.rpcRequestId !== undefined ||
		previousTool.properties?.requestDigest !== undefined ||
		currentTool.properties?.rpcRequestId === undefined ||
		currentTool.properties?.requestDigest === undefined
	)
		return false;
	const normalized = structuredClone(current);
	const normalizedTool =
		normalized.components.schemas.RuntimeOperationFactV2.oneOf.find(
			(option) => option.properties?.kind?.const === "tool",
		);
	if (!normalizedTool) return false;
	delete normalizedTool.properties.rpcRequestId;
	delete normalizedTool.properties.requestDigest;
	return isDeepStrictEqual(previous, normalized);
}

// Browser handoff is an additive, authenticated V3 control route. Its request
// and response schemas are new components; the existing Runtime routes remain
// byte-compatible.
function isRuntimeBrowserHandoffOpenApiAddition(previous, current) {
	const path = "/internal/runtime/v3/browser/handoff";
	if (
		previous.paths?.[path] !== undefined ||
		current.paths?.[path] === undefined
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	const previousSchemas = previous.components?.schemas ?? {};
	for (const name of [
		"RuntimeBrowserHandoffRequestV3",
		"RuntimeBrowserHandoffResponseV3",
	]) {
		if (previousSchemas[name] !== undefined) return false;
		delete normalized.components.schemas[name];
	}
	for (const [name, addition] of [
		["RuntimeControlCommandV2", "browser.handoff"],
		["RuntimeControlReasonV2", "browser_handoff"],
	]) {
		const previousEnum = previousSchemas[name]?.enum;
		const currentEnum = normalized.components?.schemas?.[name]?.enum;
		if (!Array.isArray(previousEnum) || !Array.isArray(currentEnum))
			return false;
		if (previousEnum.includes(addition)) return false;
		normalized.components.schemas[name].enum = currentEnum.filter(
			(value) => value !== addition,
		);
	}
	return isDeepStrictEqual(previous, normalized);
}

function stripRuntimeOperationIdentity(value) {
	if (Array.isArray(value)) return value.map(stripRuntimeOperationIdentity);
	if (!value || typeof value !== "object") return value;
	const copy = Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			stripRuntimeOperationIdentity(child),
		]),
	);
	if (
		copy.properties?.kind?.const === "tool" &&
		copy.properties.requestDigest !== undefined &&
		copy.properties.rpcRequestId !== undefined
	) {
		delete copy.properties.requestDigest;
		delete copy.properties.rpcRequestId;
	}
	return copy;
}

// #1266 admits the GET side of the existing model-selection route and its
// projection schema. The PUT route and all prior components remain exact.
// #2028 adds the compatibility result to each standard-template fan-out target.
function isStandardTemplateReleaseCompatibilityOpenApiAddition(
	previous,
	current,
) {
	const path = "/internal/ops/standard-template-releases/{releaseId}/apply-all";
	const statuses = ["202", "207"];
	const previousOperation = previous.paths?.[path]?.post;
	const currentOperation = current.paths?.[path]?.post;
	if (previousOperation === undefined || currentOperation === undefined)
		return false;
	const previousItems = statuses.map(
		(status) =>
			previousOperation.responses?.[status]?.content?.["application/json"]
				?.schema?.properties?.targets?.items,
	);
	const currentItems = statuses.map(
		(status) =>
			currentOperation.responses?.[status]?.content?.["application/json"]
				?.schema?.properties?.targets?.items,
	);
	if (
		previousItems.some((item) => item === undefined) ||
		currentItems.some((item) => item === undefined) ||
		previousItems.some(
			(item) => item.properties?.compatibility !== undefined,
		) ||
		currentItems.some((item) => item.properties?.compatibility === undefined) ||
		!sameValue(
			currentItems[0].properties.compatibility,
			currentItems[1].properties.compatibility,
		) ||
		currentItems.some(
			(item) =>
				!item.required?.includes("compatibility") ||
				item.required.filter((name) => name === "compatibility").length !== 1,
		)
	)
		return false;
	const normalized = structuredClone(current);
	for (const status of statuses) {
		const item =
			normalized.paths[path].post.responses[status].content["application/json"]
				.schema.properties.targets.items;
		delete item.properties.compatibility;
		item.required = item.required.filter((name) => name !== "compatibility");
	}
	return findBreakingChanges(previous, normalized).length === 0;
}

function isCustomAgentModelProjectionOpenApiAddition(previous, current) {
	const path = "/api/v1/conversations/{conversationId}/model-selection";
	const schema = "ConversationModelSelectionProjectionV1";
	if (
		previous.paths?.[path]?.get !== undefined ||
		previous.components?.schemas?.[schema] !== undefined ||
		current.paths?.[path]?.get === undefined ||
		current.components?.schemas?.[schema] === undefined
	)
		return false;
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				get: current.paths[path].get,
				schema: current.components.schemas[schema],
			}),
		)
		.digest("hex");
	if (
		fingerprint !==
		"1e2db2356ab7527e287133ff308dfb93ae0560a6cca67ca2ba15e2559926259a"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path].get;
	delete normalized.components.schemas[schema];
	return findBreakingChanges(previous, normalized).length === 0;
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

// #2097 adds an optional durable busy outcome to the V3 recovery projection.
function isRuntimeStatusBusyOutcomeOpenApiAddition(previous, current) {
	const responseName = "RuntimeStatusResponseV3";
	if (
		previous.components?.schemas?.[responseName] === undefined ||
		current.components?.schemas?.[responseName] === undefined
	)
		return false;
	const normalized = structuredClone(current);
	const response = normalized.components.schemas[responseName];
	const found = response.oneOf?.find(
		(option) => option?.properties?.outcome?.const === "found",
	);
	if (
		!sameValue(found?.properties?.operationOutcome, {
			const: "busy",
			type: "string",
		})
	)
		return false;
	delete found.properties.operationOutcome;
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

// Browser operation binding is an additive optional field on existing operation facts.
function stripRuntimeBrowserOperationFacts(value) {
	const normalized = normalizeRuntimeConnectionAssociationOpenApiAddition(
		structuredClone(value),
	);
	const visit = (node) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach((entry) => {
				visit(entry);
			});
			return;
		}
		if (
			node.properties?.kind?.const === "tool" &&
			node.properties?.operationRef !== undefined &&
			node.properties?.attemptRef !== undefined &&
			node.properties?.phase !== undefined &&
			node.properties?.toolId !== undefined
		)
			delete node.properties.browser;
		Object.values(node).forEach((entry) => {
			visit(entry);
		});
	};
	const schemas = normalized.components?.schemas ?? normalized.schemas ?? {};
	for (const name of [
		"RuntimeOperationFactV2",
		"ExecutionOperationEventV2",
		"ScopedPlatformAuditProjectionV1",
		"TaskSseMessageV1",
		"TaskProjectionV1",
		"PersistedConversationEventV2",
	])
		visit(schemas[name]);
	return normalized;
}

// #1862 adds only optional Browser binding metadata to existing operation
// facts; old Runtime/API consumers can ignore the absent property.
function isRuntimeBrowserOperationFactOpenApiAddition(previous, current) {
	const normalized = stripRuntimeBrowserOperationFacts(current);
	const currentBinding =
		normalized.components?.schemas?.RuntimeBrowserActionBindingV1;
	const previousBinding =
		previous.components?.schemas?.RuntimeBrowserActionBindingV1;
	if (currentBinding !== undefined && previousBinding === undefined)
		delete normalized.components.schemas.RuntimeBrowserActionBindingV1;
	if (sameValue(previous, current)) return false;
	return sameValue(previous, normalized);
}

// #2199 permits only the exact optional identity fields added to an existing
// Browser action binding. Existing fields and unrelated schemas stay strict.
function isRuntimeBrowserWorkloadIdentityOpenApiAddition(previous, current) {
	const normalized = structuredClone(current);
	const fields = {
		workloadRevision: {
			exclusiveMinimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
			type: "integer",
		},
		imageDigest: {
			pattern: "^(?:[^@\\s]+@)?sha256:[0-9a-f]{64}$",
			type: "string",
		},
	};
	const visit = (before, after) => {
		if (
			!before ||
			!after ||
			typeof before !== "object" ||
			typeof after !== "object"
		)
			return;
		const oldProperties = before.properties;
		const newProperties = after.properties;
		if (
			[
				"actionId",
				"capabilityVersion",
				"pageRevision",
				"sessionGeneration",
				"resourceFence",
				"sideEffect",
			].every(
				(field) =>
					oldProperties?.[field] !== undefined &&
					newProperties?.[field] !== undefined,
			)
		) {
			for (const [field, schema] of Object.entries(fields)) {
				if (
					oldProperties[field] === undefined &&
					sameValue(newProperties[field], schema) &&
					!after.required?.includes(field)
				)
					delete newProperties[field];
			}
		}
		for (const [key, value] of Object.entries(before)) visit(value, after[key]);
	};
	visit(previous, normalized);
	return !sameValue(previous, current) && sameValue(previous, normalized);
}

// #482 C admits only the frozen three Task HTTP paths and six closed schemas.
function isTaskHttpV1OpenApiAddition(previous, current) {
	const paths = [
		"/api/v1/agents/{agentId}/tasks",
		"/api/v1/conversations/{conversationId}/tasks/{executionId}",
		"/api/v1/conversations/{conversationId}/tasks/{executionId}/cancel",
	];
	const schemas = [
		"SubmitTaskRequestV1",
		"TaskAcceptedV1",
		"TaskProjectionV1",
		"TaskStatusEventV1",
		"CancelTaskRequestV1",
		"TaskCancellationV1",
	];
	if (
		paths.some((path) => previous.paths?.[path] !== undefined) ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const addition = stripRuntimeOperationIdentity(
		stripRuntimeBrowserOperationFacts({
			paths: Object.fromEntries(
				paths.map((path) => [path, current.paths?.[path]]),
			),
			schemas: Object.fromEntries(
				schemas.map((name) => [name, current.components?.schemas?.[name]]),
			),
			security: {
				platformApiCredential:
					current.components?.securitySchemes?.platformApiCredential,
			},
		}),
	);
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"062938f470294f68ec205f6e2007fa01a6306c40e3a59fe2195b8cad9e580a48"
	)
		return false;
	const normalized = stripRuntimeOperationIdentity(
		stripRuntimeBrowserOperationFacts(current),
	);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	if (
		previous.components?.securitySchemes?.platformApiCredential === undefined
	) {
		delete normalized.components.securitySchemes.platformApiCredential;
		if (
			Object.keys(normalized.components.securitySchemes).length === 0 &&
			previous.components?.securitySchemes === undefined
		)
			delete normalized.components.securitySchemes;
	}
	return sameValue(
		stripRuntimeOperationIdentity(stripRuntimeBrowserOperationFacts(previous)),
		normalized,
	);
}

// #482 follow-up permits only the execution-scoped Task SSE path/schema.
function isTaskHttpV1SseOpenApiAddition(previous, current) {
	const path =
		"/api/v1/conversations/{conversationId}/tasks/{executionId}/events";
	const schema = "TaskSseMessageV1";
	if (
		previous.paths?.[path] !== undefined ||
		previous.components?.schemas?.[schema] !== undefined
	)
		return false;
	const addition = stripRuntimeOperationIdentity(
		stripRuntimeBrowserOperationFacts({
			paths: { [path]: current.paths?.[path] },
			schemas: { [schema]: current.components?.schemas?.[schema] },
		}),
	);
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"6326d5f83b123da8233ac85fb694a1362d64ee5c4747618b37acba8759721167"
	)
		return false;
	const normalized = stripRuntimeOperationIdentity(
		stripRuntimeBrowserOperationFacts(current),
	);
	delete normalized.paths[path];
	delete normalized.components.schemas[schema];
	return (
		findBreakingChanges(
			stripRuntimeOperationIdentity(
				stripRuntimeBrowserOperationFacts(previous),
			),
			normalized,
		).length === 0
	);
}

// #1277 permits only the reviewed issuer operation; all previous contracts remain exact.
function isApplicationCredentialIssuerV2OpenApiAddition(previous, current) {
	const path = "/api/v2/applications/{applicationId}/credentials";
	if (previous.paths?.[path] !== undefined) return false;
	if (
		createHash("sha256")
			.update(JSON.stringify(current.paths?.[path] ?? null))
			.digest("hex") !==
		"6051aa1324b7504c92636d95c5d0d3bdfd1103560a502d5f81289cf959826ab4"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
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

// #1765 adds the reviewed V4 Worker/File Authority request schema without
// changing any previously published file path or schema.
function isRuntimeFileExchangeOpenApiAddition(previous, current) {
	const name = "RuntimeFileExchangeRequestV1";
	const path = "/internal/v1/files/runtime-exchange";
	const schemaAdded =
		previous.components?.schemas?.[name] === undefined &&
		current.components?.schemas?.[name] !== undefined;
	const pathAdded =
		previous.paths?.[path] === undefined && current.paths?.[path] !== undefined;
	if (
		(!schemaAdded && !pathAdded) ||
		(current.components?.schemas?.[name] === undefined && pathAdded)
	)
		return false;
	const addition = {
		...(pathAdded ? { paths: { [path]: current.paths[path] } } : {}),
		...(schemaAdded
			? { schemas: { [name]: current.components.schemas[name] } }
			: {}),
	};
	const expectedHash =
		schemaAdded && pathAdded
			? "738d5a4d3d62fafdd3ee8ef4f3a01d176549493b6911efa6bf95840187dd9c07"
			: schemaAdded
				? "fddfd2571c71fbf998f3da7edbd75b5d021f9d57e02028e5ab48e8f7e3e94168"
				: "03fadb80928e35acc47d14df7ae75b2a3423f8d9b3df79085935d629b0029d42";
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		expectedHash
	)
		return false;
	const normalized = structuredClone(current);
	if (pathAdded) delete normalized.paths[path];
	if (schemaAdded) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
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
	const addition = stripRuntimeOperationIdentity(
		stripRuntimeBrowserOperationFacts({
			paths: Object.fromEntries(
				paths.map((path) => [path, current.paths?.[path]]),
			),
			schemas: Object.fromEntries(
				schemas.map((name) => [name, current.components?.schemas?.[name]]),
			),
		}),
	);
	// The bounded event window is a later additive field on this V2 detail;
	// keep the original #508 publication digest stable when checking the
	// historical operation-read addition.
	const detailAddition = addition.schemas.ConversationDetailProjectionV2;
	if (detailAddition?.properties?.eventWindow !== undefined) {
		const properties = { ...detailAddition.properties };
		delete properties.eventWindow;
		addition.schemas.ConversationDetailProjectionV2 = {
			...detailAddition,
			properties,
		};
	}
	const detailPath = addition.paths["/api/v2/conversations/{conversationId}"];
	if (detailPath?.get?.parameters) {
		detailPath.get.parameters = detailPath.get.parameters.filter(
			(parameter) =>
				!(parameter.in === "query" && parameter.name === "beforeCursor"),
		);
	}
	const detailResponse = detailPath?.get?.responses?.["200"];
	if (
		detailResponse?.description ===
		"Conversation messages and a bounded mixed-version event window"
	) {
		detailResponse.description =
			"Conversation messages and complete mixed-version event history";
	}
	// #1534 later added the optional Session availability; the pinned digest
	// covers the original publication. #1523 later added "updating".
	const detail = addition.schemas.ConversationDetailProjectionV2;
	if (
		isSessionAvailabilityProperty(detail?.properties?.sessionAvailability) &&
		!detail.required?.includes("sessionAvailability")
	) {
		const properties = { ...detail.properties };
		delete properties.sessionAvailability;
		addition.schemas.ConversationDetailProjectionV2 = { ...detail, properties };
	}
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"097d6b3631a284fd8faf916f2c35a70d7c721c8bc832f3b97a96389fecfc541f"
	)
		return false;
	const normalized = stripRuntimeOperationIdentity(
		stripRuntimeBrowserOperationFacts(current),
	);
	const normalizedDetailPath =
		normalized.paths["/api/v2/conversations/{conversationId}"];
	if (
		normalizedDetailPath?.get?.responses?.["200"]?.description ===
		"Conversation messages and a bounded mixed-version event window"
	)
		normalizedDetailPath.get.responses["200"].description =
			"Conversation messages and complete mixed-version event history";
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	delete normalized.components.schemas.ConversationEventWindowV1;
	const normalizedPrevious = stripRuntimeOperationIdentity(
		stripRuntimeBrowserOperationFacts(previous),
	);
	delete normalizedPrevious.components.schemas.ConversationEventWindowV1;
	return (
		sameValue(normalizedPrevious, normalized) ||
		isAgentLifecycleV2OpenApiAddition(normalizedPrevious, normalized)
	);
}

// #1812 adds only the optional bounded V2 detail window and its backward cursor.
function isConversationEventWindowOpenApiAddition(previous, current) {
	const path = "/api/v2/conversations/{conversationId}";
	const name = "ConversationDetailProjectionV2";
	const previousDetail = previous.components?.schemas?.[name];
	const currentDetail = current.components?.schemas?.[name];
	const previousParameters = previous.paths?.[path]?.get?.parameters ?? [];
	const currentParameters = current.paths?.[path]?.get?.parameters ?? [];
	const beforeCursor = currentParameters.find(
		(parameter) =>
			parameter.in === "query" && parameter.name === "beforeCursor",
	);
	if (
		previousDetail?.properties?.eventWindow !== undefined ||
		previous.components?.schemas?.ConversationEventWindowV1 !== undefined ||
		previousParameters.some(
			(parameter) =>
				parameter.in === "query" && parameter.name === "beforeCursor",
		) ||
		!currentDetail?.properties?.eventWindow ||
		currentDetail.required?.includes("eventWindow") ||
		!current.components?.schemas?.ConversationEventWindowV1 ||
		!beforeCursor
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.components.schemas.ConversationEventWindowV1;
	delete normalized.components.schemas[name].properties.eventWindow;
	if (
		normalized.paths[path].get.responses?.["200"]?.description ===
		"Conversation messages and a bounded mixed-version event window"
	)
		normalized.paths[path].get.responses["200"].description =
			"Conversation messages and complete mixed-version event history";
	normalized.paths[path].get.parameters = normalized.paths[
		path
	].get.parameters.filter(
		(parameter) =>
			!(parameter.in === "query" && parameter.name === "beforeCursor"),
	);
	return sameValue(previous, normalized);
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

const preparingSessionAvailability = {
	enum: ["preparing", "ready", "unavailable"],
	type: "string",
};
const updatingSessionAvailability = {
	enum: ["preparing", "ready", "unavailable", "updating"],
	type: "string",
};

/** Exactly the #1534 Session availability or its #1523 "updating" extension. */
function isSessionAvailabilityProperty(value) {
	return (
		sameValue(value, preparingSessionAvailability) ||
		sameValue(value, updatingSessionAvailability)
	);
}

// #1534 adds the optional Session availability to the Web Conversation detail.
function isConversationSessionAvailabilityOpenApiAddition(previous, current) {
	const name = "ConversationDetailProjectionV2";
	const previousDetail = previous.components?.schemas?.[name];
	const currentDetail = current.components?.schemas?.[name];
	if (
		!previousDetail?.properties ||
		Object.hasOwn(previousDetail.properties, "sessionAvailability") ||
		!isSessionAvailabilityProperty(
			currentDetail?.properties?.sessionAvailability,
		) ||
		currentDetail.required?.includes("sessionAvailability")
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.components.schemas[name].properties.sessionAvailability;
	return sameValue(previous, normalized);
}

// #1523 adds only the "updating" value while a Session Sandbox upgrades.
function isConversationSessionUpdatingOpenApiAddition(previous, current) {
	const name = "ConversationDetailProjectionV2";
	const previousDetail = previous.components?.schemas?.[name];
	const currentDetail = current.components?.schemas?.[name];
	if (
		!sameValue(
			previousDetail?.properties?.sessionAvailability,
			preparingSessionAvailability,
		) ||
		!sameValue(
			currentDetail?.properties?.sessionAvailability,
			updatingSessionAvailability,
		) ||
		currentDetail.required?.includes("sessionAvailability")
	)
		return false;
	const normalized = structuredClone(current);
	normalized.components.schemas[name].properties.sessionAvailability =
		structuredClone(preparingSessionAvailability);
	return sameValue(previous, normalized);
}

// #1707 adds only the approved session-authenticated Skill metadata reads.
function isSkillHubReadOpenApiAddition(previous, current) {
	const paths = ["/api/v2/skills", "/api/v2/skills/versions/{skillVersionId}"];
	const schemas = ["SkillHubVersionMetadataV1", "SkillHubDirectoryPageV1"];
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
		"055b0d8a2b70e16a0c8aab3dd44218bb7f0115f1712047226fec9f270fffa79f"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #2000 publishes only the existing Skill installation route contract.
function isSkillHubInstallationOpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/skills/installations",
		"/api/v2/skills/installations/{installationId}",
	];
	const schemas = [
		"SkillHubInstallationCommandV1",
		"SkillHubInstallationResponseV1",
		"SkillHubInstallationV1",
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
		"28386c2c315dc339d8148d9bd298f7d5de36a9bc18cbba1ca195ca469e99c824"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #2189 publishes the Skill version publication/review/revoke API additively.
function isSkillHubPublicationOpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/skills/versions",
		"/api/v2/skills/versions/{skillVersionId}/review",
		"/api/v2/skills/versions/{skillVersionId}/revoke",
	];
	const schemas = [
		"SkillHubPublicationRequestV1",
		"SkillHubPublicationVersionV1",
		"SkillHubPublicationResponseV1",
		"SkillHubReviewRequestV1",
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
		"3e30138413e708c3e3ec985fa263efacff806263d63ff1f9bbefcdfd11596fe5"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #2270 publishes the existing authenticated native metadata read route and
// projection as an additive Browser v2 consumer contract.
function isNativeMetadataOpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/conversations/{conversationId}/executions/{executionId}/native-metadata",
	];
	const schemas = ["NativeMetadataProjectionV1"];
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
		"154f4a712813f51a57ced4781f98a1f12a04777c632288a14c908135866070db"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #2206 publishes the Agent version Skill binding and status API additively.
function isSkillHubAgentBindingOpenApiAddition(previous, current) {
	const paths = ["/api/v2/agents/{agentId}/versions/{agentVersion}/skills"];
	const schemas = [
		"SkillHubAgentBindingRequestV1",
		"SkillHubAgentBindingCommandV1",
		"SkillHubAgentBindingResultV1",
		"SkillHubAgentBindingStatusV1",
		"SkillHubAgentBindingStatusResponseV1",
	];
	if (
		paths.some((path) => previous.paths?.[path] !== undefined) ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #2214 adds the controlled Provider import entry point. The request contains
// only server-resolved candidate selectors; archive, trust and storage facts
// remain deployment-owned.
function isSkillHubImportOpenApiAddition(previous, current) {
	const paths = ["/api/v2/skills/imports"];
	const schemas = [
		"SkillHubProviderImportRequestV1",
		"SkillHubProviderImportResponseV1",
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
		"cd83cfd612b5226914c5ba26fd89d8278fa55c2cfa8a53ffe7088472c05e5cdc"
	)
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #2207 publishes the authenticated Skill project management API additively.
function isSkillHubProjectOpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/skills/projects",
		"/api/v2/skills/projects/{projectId}",
	];
	const schemas = [
		"SkillHubProjectCreateV1",
		"SkillHubProjectUpdateV1",
		"SkillHubProjectV1",
		"SkillHubProjectPageV1",
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
	if (Object.values(addition.paths).some((path) => path === undefined))
		return false;
	if (Object.values(addition.schemas).some((schema) => schema === undefined))
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

function isSkillHubProjectAndImportOpenApiAddition(previous, current) {
	const paths = [
		"/api/v2/skills/projects",
		"/api/v2/skills/projects/{projectId}",
		"/api/v2/skills/imports",
	];
	const schemas = [
		"SkillHubProjectCreateV1",
		"SkillHubProjectUpdateV1",
		"SkillHubProjectV1",
		"SkillHubProjectPageV1",
		"SkillHubProviderImportRequestV1",
		"SkillHubProviderImportResponseV1",
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
	if (Object.values(addition.paths).some((path) => path === undefined))
		return false;
	if (Object.values(addition.schemas).some((schema) => schema === undefined))
		return false;
	const normalized = structuredClone(current);
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
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
// Keep both hashes: the first is the historical #440 shape before #1935's QR
// branch, while the second is the exact current route set after that addition.
const wecomReceiptOpenApiAdditionHashes = new Set([
	"f5331d7d488eca753adaf413088b91f6050fc07def829902db17494ef7aa49f1",
	"a0d685b8aa834f369ed1e561d2acc5660a644d8f7fb8c113a089670321ef6045",
]);

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
		!wecomReceiptOpenApiAdditionHashes.has(
			createHash("sha256").update(JSON.stringify(addition)).digest("hex"),
		)
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

// #1935 adds an optional deployment-approved QR branch to the existing bot setup response.
const wecomLegacyAuthorizationBranchSha256 =
	"b23fbc27698cf8cb1a1af39993346877a8f113a9c24a90c4b5738f1f6b5b2acd";
const wecomQrAuthorizationBranchSha256 =
	"da0cac344f9a9383e5851073f97bf9f6ca0fbf04128e50c5d6f7214e8d9c03eb";

function isWecomQrAuthorizationOpenApiAddition(previous, current) {
	const path = "/api/v1/agents/{agentId}/wecom-setup";
	const previousSchema =
		previous.paths?.[path]?.post?.responses?.["200"]?.content?.[
			"application/json"
		]?.schema;
	const currentSchema =
		current.paths?.[path]?.post?.responses?.["200"]?.content?.[
			"application/json"
		]?.schema;
	if (
		!previousSchema ||
		!currentSchema ||
		currentSchema.type !== "object" ||
		!Array.isArray(currentSchema.oneOf) ||
		currentSchema.oneOf.length !== 2 ||
		createHash("sha256")
			.update(JSON.stringify(previousSchema))
			.digest("hex") !== wecomLegacyAuthorizationBranchSha256 ||
		!isDeepStrictEqual(currentSchema.oneOf[0], previousSchema) ||
		createHash("sha256")
			.update(JSON.stringify(currentSchema.oneOf[1]))
			.digest("hex") !== wecomQrAuthorizationBranchSha256 ||
		!sameValue(Object.keys(currentSchema).sort(), ["oneOf", "type"])
	)
		return false;
	const normalized = structuredClone(current);
	normalized.paths[path].post.responses["200"].content[
		"application/json"
	].schema = previousSchema;
	return sameValue(previous, normalized);
}

// The #481 creation producer already persists these actions. #1572 admits only
// the missing public enum entries; all scope, fields and paths stay identical.
function isAgentCreationAuditActionOpenApiAddition(previous, current) {
	const additions = [
		"api.agent.create.accepted",
		"api.agent.create.replayed",
		"api.agent.create.refused",
		"relay_key.agent_default.replace",
	];
	const before = previous.components?.schemas?.ScopedPlatformAuditActionV1;
	const after = current.components?.schemas?.ScopedPlatformAuditActionV1;
	if (
		!Array.isArray(before?.enum) ||
		!Array.isArray(after?.enum) ||
		additions.some((action) => before.enum.includes(action)) ||
		!sameValue(after.enum, [...before.enum, ...additions])
	)
		return false;
	const normalized = structuredClone(current);
	normalized.components.schemas.ScopedPlatformAuditActionV1.enum =
		structuredClone(before.enum);
	return isDeepStrictEqual(previous, normalized);
}

function isSkillHubAuditActionOpenApiAddition(previous, current) {
	const additions = [
		"skill.version.register",
		"skill.version.review",
		"skill.version.revoke",
		"skill.version.read",
		"skill.version.refused",
	];
	const before = previous.components?.schemas?.ScopedPlatformAuditActionV1;
	const after = current.components?.schemas?.ScopedPlatformAuditActionV1;
	if (
		!Array.isArray(before?.enum) ||
		!Array.isArray(after?.enum) ||
		!sameValue(after.enum, [...additions, ...before.enum])
	)
		return false;
	const normalized = structuredClone(current);
	normalized.components.schemas.ScopedPlatformAuditActionV1.enum =
		structuredClone(before.enum);
	return isDeepStrictEqual(previous, normalized);
}

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

// #1260/#1259 compose the reviewed A-lane OpenAPI additions on current main.
function isA2ParallelModelConfigurationOpenApiAddition(previous, current) {
	const directName = "AgentApiCreationRequestV1";
	const directKey =
		current.components?.schemas?.[directName]?.anyOf?.[0]?.properties
			?.defaultRelayKey;
	const directAdded =
		previous.components?.schemas?.[directName]?.anyOf?.[0]?.properties
			?.defaultRelayKey === undefined &&
		isDeepStrictEqual(directKey, {
			minLength: 1,
			type: "string",
			writeOnly: true,
		});
	const applicationName = "AgentApplicationCreateRequestV2";
	const applicationKey =
		current.components?.schemas?.[applicationName]?.properties?.defaultRelayKey;
	const applicationAdded =
		previous.components?.schemas?.[applicationName]?.properties
			?.defaultRelayKey === undefined &&
		isDeepStrictEqual(applicationKey, {
			minLength: 1,
			type: "string",
			writeOnly: true,
		});
	const readiness =
		current.components?.schemas?.DeploymentTemplateProjectionV2?.properties
			?.readiness;
	const createRevision =
		current.components?.schemas?.AgentApplicationCreateRequestV2?.properties
			?.source?.anyOf?.[0]?.properties?.templateRevision;
	const updateRevision =
		current.components?.schemas?.AgentApplicationUpdateRequestV2?.properties
			?.source?.anyOf?.[0]?.properties?.templateRevision;
	const readinessAddition = { readiness, createRevision, updateRevision };
	const readinessAdded =
		previous.components?.schemas?.DeploymentTemplateProjectionV2?.properties
			?.readiness === undefined &&
		previous.components?.schemas?.AgentApplicationCreateRequestV2?.properties
			?.source?.anyOf?.[0]?.properties?.templateRevision === undefined &&
		previous.components?.schemas?.AgentApplicationUpdateRequestV2?.properties
			?.source?.anyOf?.[0]?.properties?.templateRevision === undefined &&
		createHash("sha256")
			.update(JSON.stringify(readinessAddition))
			.digest("hex") ===
			"4a1caabb7b8190f3cf6362aa915c81048146767d58bd96fdbdda4fe375ad8b16";
	const relayPaths = [
		"/api/v2/agents/{agentId}/default-relay-key",
		"/api/v2/agents/{agentId}/default-relay-key/candidates",
	];
	const relayAddition = Object.fromEntries(
		relayPaths.map((path) => [path, current.paths?.[path]]),
	);
	const relayAdded =
		relayPaths.every((path) => previous.paths?.[path] === undefined) &&
		createHash("sha256").update(JSON.stringify(relayAddition)).digest("hex") ===
			"cb5d42ff2f8ad50c3c85325e38e6f5ff40fdef88e65744033406a2016929f310";
	if (!directAdded && !applicationAdded && !readinessAdded && !relayAdded)
		return false;
	const normalized = structuredClone(current);
	if (directAdded) {
		delete normalized.components.schemas[directName].anyOf[0].properties
			.defaultRelayKey;
	}
	if (applicationAdded) {
		delete normalized.components.schemas[applicationName].properties
			.defaultRelayKey;
	}
	if (readinessAdded) {
		delete normalized.components.schemas.DeploymentTemplateProjectionV2
			.properties.readiness;
		for (const name of [
			"AgentApplicationCreateRequestV2",
			"AgentApplicationUpdateRequestV2",
		])
			delete normalized.components.schemas[name].properties.source.anyOf[0]
				.properties.templateRevision;
	}
	if (relayAdded) {
		for (const path of relayPaths) delete normalized.paths[path];
	}
	return sameValue(previous, normalized);
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
	return sameValue(previous, normalized);
}

// #2421 admits only the three optional fields that let a keyless Agent replace its
// model set together with a re-submitted default Key (configuration update and
// application revision requests).
function isKeylessModelReplacementOpenApiAddition(previous, current) {
	const names = [
		"AgentApplicationUpdateRequestV2",
		"AgentConfigurationUpdateRequestV2",
	];
	const integer = {
		exclusiveMinimum: 0,
		maximum: Number.MAX_SAFE_INTEGER,
		type: "integer",
	};
	const added = {
		defaultRelayKey: {
			maxLength: 8192,
			minLength: 16,
			pattern: "^[\\x21-\\x7e]+$",
			type: "string",
			writeOnly: true,
		},
		expectedConfigurationRevision: integer,
		expectedKeyVersion: { anyOf: [integer, { type: "null" }] },
	};
	const normalized = structuredClone(current);
	for (const name of names) {
		const previousProperties = previous.components?.schemas?.[name]?.properties;
		const currentSchema = current.components?.schemas?.[name];
		if (!previousProperties || !currentSchema?.properties) return false;
		for (const [property, definition] of Object.entries(added)) {
			if (
				previousProperties[property] !== undefined ||
				currentSchema.required?.includes(property) ||
				!isDeepStrictEqual(currentSchema.properties[property], definition)
			)
				return false;
			delete normalized.components.schemas[name].properties[property];
		}
	}
	return sameValue(previous, normalized);
}

// #1260 adds the same write-only key input to direct Agent creation custom requests.
function isAgentDefaultRelayKeyInputOpenApiAddition(previous, current) {
	const name = "AgentApiCreationRequestV1";
	const previousSchema = previous.components?.schemas?.[name];
	const currentSchema = current.components?.schemas?.[name];
	const previousInput = previousSchema?.anyOf?.[0]?.properties?.defaultRelayKey;
	const currentInput = currentSchema?.anyOf?.[0]?.properties?.defaultRelayKey;
	if (
		previousInput !== undefined ||
		!isDeepStrictEqual(currentInput, {
			minLength: 1,
			type: "string",
			writeOnly: true,
		})
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.components.schemas[name].anyOf[0].properties
		.defaultRelayKey;
	return sameValue(previous, normalized);
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
	return sameValue(previous, normalized);
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

// #481 use authority is an exact additive path and four bounded audit actions.
function isAgentApplicationUseGrantOpenApiAddition(previous, current) {
	const actions = [
		"api.agent.use.granted",
		"api.agent.use.revoked",
		"api.agent.use.replayed",
		"api.agent.use.refused",
	];
	const path =
		"/api/v2/agents/{agentId}/application-use-grants/{applicationId}";
	const normalized = structuredClone(current);
	const oldActions =
		previous.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	const newActions =
		normalized.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	let changed = false;
	if (
		Array.isArray(oldActions) &&
		Array.isArray(newActions) &&
		actions.every(
			(action) => !oldActions.includes(action) && newActions.includes(action),
		)
	) {
		normalized.components.schemas.ScopedPlatformAuditActionV1.enum =
			newActions.filter((action) => !actions.includes(action));
		changed = true;
	}
	if (
		previous.paths?.[path] === undefined &&
		current.paths?.[path] !== undefined
	) {
		if (
			createHash("sha256")
				.update(JSON.stringify(current.paths[path]))
				.digest("hex") !==
			"db2b2515a54f13a66a7fb6b615a7f653f08b5cb2c632a2e3e0cfdeb377f178da"
		)
			return false;
		delete normalized.paths[path];
		changed = true;
	}
	return changed && findBreakingChanges(previous, normalized).length === 0;
}

// #1111 admits only the browser Owner user-use revoke operation and its schemas.
function isAgentUserUseRevokeOpenApiAddition(previous, current) {
	const path = "/api/v2/agents/{agentId}/api-use-grants/{userId}";
	const schemas = [
		"AgentUserUseRevokeRequestV1",
		"AgentUserUseRevokeResponseV1",
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
		"dbd33b71470eeac957b6ae9436effe45fc68c8b822b03edd3097dd10b8541d83"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #1084 admits only the additive Owner user-use grant method and its schemas.
function isAgentUserUseGrantOpenApiAddition(previous, current) {
	const path = "/api/v2/agents/{agentId}/api-use-grants/{userId}";
	const schemas = ["AgentUserUseGrantRequestV1", "AgentUserUseGrantResponseV1"];
	if (
		previous.paths?.[path]?.put !== undefined ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const addition = {
		paths: { [path]: { put: current.paths?.[path]?.put } },
		schemas: Object.fromEntries(
			schemas.map((name) => [name, current.components?.schemas?.[name]]),
		),
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"f46a4f608dc9ab4c58aa71df467542f5bc02ead2d1c60061bfcb259fe7ede9bb"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.paths[path].put;
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

// #481 admits only this exact machine/personal lifecycle contract and its audit variants.
function isAgentApiManagementOpenApiAddition(previous, current) {
	const actions = [
		"api.agent.state.read",
		"api.agent.manager.granted",
		"api.agent.manager.revoked",
		"api.agent.manager.replayed",
		"api.agent.lifecycle.refused",
		"api.agent.manager.refused",
		"api.agent.state.refused",
	];
	const paths = [
		"/api/v2/agents/{agentId}/state",
		"/api/v2/agents/{agentId}/commands",
		"/api/v2/agents/{agentId}/application-managers/{applicationId}",
	];
	const names = [
		"AgentApiLifecycleRequestV1",
		"AgentApiLifecycleResponseV1",
		"AgentApiStateResponseV1",
		"AgentApplicationManagerRequestV1",
		"AgentApplicationManagerResponseV1",
		"PlatformAuditProjectionV2",
	];
	const normalized = structuredClone(current);
	const oldActions =
		previous.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	const newActions =
		normalized.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	let changed = false;
	if (
		Array.isArray(oldActions) &&
		Array.isArray(newActions) &&
		actions.every(
			(action) => !oldActions.includes(action) && newActions.includes(action),
		)
	) {
		normalized.components.schemas.ScopedPlatformAuditActionV1.enum =
			newActions.filter((action) => !actions.includes(action));
		changed = true;
	}
	if (
		paths.every(
			(path) =>
				previous.paths?.[path] === undefined &&
				current.paths?.[path] !== undefined,
		)
	) {
		const addition = {
			paths: Object.fromEntries(
				paths.map((path) => [path, current.paths[path]]),
			),
			schemas: Object.fromEntries(
				names.map((name) => [name, current.components?.schemas?.[name]]),
			),
		};
		if (
			createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
			"80e3f923b7ae47b750d14dd895c2be132d76c2dcc65ed8f9bb9e586698b0beb8"
		)
			return false;
		for (const path of paths) delete normalized.paths[path];
		for (const name of names.slice(0, -1)) {
			if (previous.components?.schemas?.[name] !== undefined) return false;
			delete normalized.components.schemas[name];
		}
		const audit = normalized.components.schemas.PlatformAuditProjectionV2;
		audit.properties.actor.anyOf = audit.properties.actor.anyOf.filter(
			(actor) =>
				!["application", "unknown"].includes(actor.properties?.kind?.const),
		);
		audit.properties.subjectType.enum =
			audit.properties.subjectType.enum.filter((kind) => kind !== "unknown");
		changed = true;
	}
	return changed && sameValue(previous, normalized);
}

// #1259 adds only optional readiness metadata and the displayed selection revision.
function isTemplateReadinessV2OpenApiAddition(previous, current) {
	const schemas = current.components?.schemas;
	const addition = {
		readiness: schemas?.DeploymentTemplateProjectionV2?.properties?.readiness,
		createRevision:
			schemas?.AgentApplicationCreateRequestV2?.properties?.source?.anyOf?.[0]
				?.properties?.templateRevision,
		updateRevision:
			schemas?.AgentApplicationUpdateRequestV2?.properties?.source?.anyOf?.[0]
				?.properties?.templateRevision,
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"4a1caabb7b8190f3cf6362aa915c81048146767d58bd96fdbdda4fe375ad8b16"
	)
		return false;
	const normalized = structuredClone(current);
	delete normalized.components.schemas.DeploymentTemplateProjectionV2.properties
		.readiness;
	for (const name of [
		"AgentApplicationCreateRequestV2",
		"AgentApplicationUpdateRequestV2",
	])
		delete normalized.components.schemas[name].properties.source.anyOf[0]
			.properties.templateRevision;
	return sameValue(previous, normalized);
}

// #481 adds the credential-authenticated direct Agent creation contract beside
// the existing browser Agent list path.
function isAgentApiCreationOpenApiAddition(previous, current) {
	const path = "/api/v2/agents";
	const names = ["AgentApiCreationRequestV1", "AgentApiCreationResponseV1"];
	if (
		previous.paths?.[path]?.post !== undefined ||
		current.paths?.[path]?.post === undefined ||
		names.some(
			(name) =>
				previous.components?.schemas?.[name] !== undefined ||
				current.components?.schemas?.[name] === undefined,
		)
	)
		return false;
	const normalized = structuredClone(current);
	const directSchema = normalized.components.schemas.AgentApiCreationRequestV1;
	const defaultRelayKey = directSchema.anyOf?.[0]?.properties?.defaultRelayKey;
	if (
		defaultRelayKey !== undefined &&
		!isDeepStrictEqual(defaultRelayKey, {
			minLength: 1,
			type: "string",
			writeOnly: true,
		})
	)
		return false;
	if (
		previous.components?.schemas?.AgentApiCreationRequestV1?.anyOf?.[0]
			?.properties?.defaultRelayKey !== undefined &&
		!isDeepStrictEqual(
			previous.components.schemas.AgentApiCreationRequestV1.anyOf[0].properties
				.defaultRelayKey,
			defaultRelayKey,
		)
	)
		return false;
	if (defaultRelayKey !== undefined)
		delete directSchema.anyOf[0].properties.defaultRelayKey;
	const addition = {
		path: { post: normalized.paths[path].post },
		schemas: Object.fromEntries(
			names.map((name) => [name, normalized.components.schemas[name]]),
		),
	};
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		"5605586625e0634b7344bbceb4bae9b41b48e56bb5a38457dc2d5b003e136a86"
	)
		return false;
	delete normalized.paths[path].post;
	for (const name of names) delete normalized.components.schemas[name];
	return findBreakingChanges(previous, normalized).length === 0;
}

// #1494 adds optional verified Skill metadata to Runtime capabilities.
function isRuntimeSkillCapabilityOpenApiAddition(previous, current) {
	const previousSchemas = previous.components?.schemas;
	if (previousSchemas?.RuntimeSkillCapabilityV1 !== undefined) return false;
	const currentSchemas = current.components?.schemas;
	const isHost = currentSchemas?.RuntimeCapabilitiesV1 !== undefined;
	const projectionName = currentSchemas?.AgentProjectionV1
		? "AgentProjectionV1"
		: currentSchemas?.AgentProjectionV2
			? "AgentProjectionV2"
			: undefined;
	const oldCapabilities = isHost
		? previousSchemas?.RuntimeCapabilitiesV1
		: projectionName !== undefined
			? previousSchemas?.[projectionName]?.properties?.capabilities
			: previousSchemas?.WorkloadReadinessResponseV1?.properties?.capabilities;
	const newCapabilities = isHost
		? currentSchemas.RuntimeCapabilitiesV1
		: projectionName !== undefined
			? currentSchemas[projectionName]?.properties?.capabilities
			: currentSchemas?.WorkloadReadinessResponseV1?.properties?.capabilities;
	if (
		oldCapabilities === undefined ||
		oldCapabilities.properties?.skills !== undefined ||
		newCapabilities?.properties?.skills === undefined
	)
		return false;
	const addition = {
		skills: newCapabilities.properties.skills,
		...(isHost ? { definition: currentSchemas.RuntimeSkillCapabilityV1 } : {}),
	};
	const expectedDigest = isHost
		? "3e354b1142891161f39da6b1668873acd62f36b6f56a81f2c1ba440734976ee0"
		: "f677042fd2ebf9e3969365c59461a698e76ce511e764a6ffff743edfa1fb76ff";
	if (
		createHash("sha256").update(JSON.stringify(addition)).digest("hex") !==
		expectedDigest
	)
		return false;
	const normalized = structuredClone(current);
	const normalizedSchemas = normalized.components.schemas;
	const capabilities = normalizedSchemas.RuntimeCapabilitiesV1;
	const readiness = normalizedSchemas.WorkloadReadinessResponseV1;
	const projection =
		normalizedSchemas.AgentProjectionV1 ?? normalizedSchemas.AgentProjectionV2;
	const capabilitySchema =
		capabilities ??
		readiness?.properties?.capabilities ??
		projection?.properties?.capabilities;
	const skillContainer = capabilitySchema?.properties;
	if (skillContainer?.skills === undefined) return false;
	delete skillContainer.skills;
	delete normalized.components.schemas.RuntimeSkillCapabilityV1;
	return sameValue(previous, normalized);
}

// #2036 adds the RuntimeHost consumer for the mounted Skill directory. The
// grant command, two read-only operations and their strict schemas are a
// single versioned addition; removing them must reproduce the prior artifact.
function isRuntimeSkillHostReadOpenApiAddition(previous, current) {
	const commandSchema = "ExecutionGrantCommandV1";
	const command = "skills.read";
	const paths = [
		"/internal/runtime/v1/skills",
		"/internal/runtime/v1/skills/resources",
	];
	const schemas = [
		"RuntimeSkillDirectoryRequestV1",
		"RuntimeSkillDirectoryEntryV1",
		"RuntimeSkillDirectoryResponseV1",
		"RuntimeSkillResourceReadRequestV1",
		"RuntimeSkillResourceReadResponseV1",
	];
	if (
		previous.paths?.[paths[0]] !== undefined &&
		previous.paths?.[paths[1]] !== undefined &&
		schemas.every((name) => previous.components?.schemas?.[name] !== undefined)
	) {
		const normalized = structuredClone(current);
		const request =
			normalized.components.schemas.RuntimeSkillResourceReadRequestV1;
		const response =
			normalized.components.schemas.RuntimeSkillResourceReadResponseV1;
		delete request.properties?.generationId;
		request.required = request.required?.filter(
			(key) => key !== "generationId",
		);
		delete response.properties?.generationId;
		response.required = response.required?.filter(
			(key) => key !== "generationId",
		);
		return sameValue(previous, normalized);
	}
	if (
		previous.paths?.[paths[0]] !== undefined ||
		previous.paths?.[paths[1]] !== undefined ||
		schemas.some((name) => previous.components?.schemas?.[name] !== undefined)
	)
		return false;
	const previousCommands = previous.components?.schemas?.[commandSchema]?.enum;
	const currentCommands = current.components?.schemas?.[commandSchema]?.enum;
	if (
		!Array.isArray(previousCommands) ||
		!Array.isArray(currentCommands) ||
		currentCommands.length !== previousCommands.length + 1 ||
		!currentCommands.includes(command) ||
		currentCommands.filter((value) => value !== command).join("\n") !==
			previousCommands.join("\n")
	)
		return false;
	const addition = {
		command,
		paths: Object.fromEntries(
			paths.map((path) => [path, current.paths?.[path]]),
		),
		schemas: Object.fromEntries(
			schemas.map((name) => [name, current.components?.schemas?.[name]]),
		),
	};
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(addition))
		.digest("hex");
	if (
		fingerprint !==
		"de287f89e1061b77f7ff91bcba16ce559d8748a97f261095eca9f82f8f069aac"
	)
		return false;
	const normalized = structuredClone(current);
	normalized.components.schemas[commandSchema].enum = previousCommands;
	for (const path of paths) delete normalized.paths[path];
	for (const name of schemas) delete normalized.components.schemas[name];
	return sameValue(previous, normalized);
}

function isRuntimeSkillReadGrantCommandOpenApiAddition(previous, current) {
	const previousCommands =
		previous.components?.schemas?.ExecutionGrantCommandV1?.enum;
	const currentCommands =
		current.components?.schemas?.ExecutionGrantCommandV1?.enum;
	if (
		!Array.isArray(previousCommands) ||
		!Array.isArray(currentCommands) ||
		currentCommands.length !== previousCommands.length + 1 ||
		!currentCommands.includes("skills.read") ||
		currentCommands.filter((value) => value !== "skills.read").join("\n") !==
			previousCommands.join("\n")
	)
		return false;
	const normalized = structuredClone(current);
	normalized.components.schemas.ExecutionGrantCommandV1.enum = previousCommands;
	return sameValue(previous, normalized);
}

// #1717 delivers the optional, signed Browser declaration/probe facts through
// the existing readiness and Runtime capability contracts. The fields are
// additive and remain optional when Browser is absent; no existing operation,
// response or required field changes.
function isRuntimeBrowserEvidenceOpenApiAddition(previous, current) {
	const normalized = structuredClone(current);
	let changed = false;
	const host = normalized.components?.schemas?.RuntimeCapabilitiesV1;
	const previousHost = previous.components?.schemas?.RuntimeCapabilitiesV1;
	if (
		host?.properties?.browser !== undefined &&
		previousHost?.properties?.browser === undefined &&
		normalized.components?.schemas?.RuntimeBrowserCapabilityProbeEvidenceV1
	) {
		delete host.properties.browser;
		delete normalized.components.schemas
			.RuntimeBrowserCapabilityProbeEvidenceV1;
		delete normalized.components.schemas.BrowserCapabilityBindingV1;
		changed = true;
	}
	for (const name of [
		"RuntimeBrowserCapabilityProbeEvidenceV1",
		"BrowserCapabilityBindingV1",
	]) {
		if (
			normalized.components?.schemas?.[name] !== undefined &&
			previous.components?.schemas?.[name] === undefined
		) {
			delete normalized.components.schemas[name];
			changed = true;
		}
	}
	const readinessNames = [
		"WorkloadReadinessGrantClaimsV1",
		"WorkloadReadinessRequestV1",
		"WorkloadReadinessResponseV1",
	];
	if (
		readinessNames.every(
			(name) => normalized.components?.schemas?.[name] !== undefined,
		)
	) {
		for (const name of readinessNames) {
			const schema = normalized.components.schemas[name];
			if (schema.properties?.browserDeclaration !== undefined) {
				if (
					previous.components?.schemas?.[name]?.properties
						?.browserDeclaration !== undefined
				)
					return false;
				delete schema.properties.browserDeclaration;
				changed = true;
			}
			if (schema.properties?.browserBinding !== undefined) {
				if (
					previous.components?.schemas?.[name]?.properties?.browserBinding !==
					undefined
				)
					return false;
				delete schema.properties.browserBinding;
				changed = true;
			}
		}
		const response = normalized.components.schemas.WorkloadReadinessResponseV1;
		const previousResponse =
			previous.components?.schemas?.WorkloadReadinessResponseV1;
		if (
			response.properties?.capabilities?.properties?.browser !== undefined &&
			previousResponse?.properties?.capabilities?.properties?.browser ===
				undefined
		) {
			delete response.properties.capabilities.properties.browser;
			changed = true;
		}
	}
	return changed && sameValue(previous, normalized);
}

// #1541 corrects only the approved opaque S3 VersionId inside fixed Skill package references.
// Normalize this exact difference before the ordinary comparison; no other field is exempt.
function normalizeSkillPackageObjectVersions(previous, current, changes) {
	const oldVersion = {
		pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
		type: "string",
	};
	const newVersion = {
		maxLength: 1024,
		minLength: 1,
		pattern: "^(?!null(?![\\s\\S]))[\\s\\S]+$",
		type: "string",
	};
	const normalized = structuredClone(current);
	const visit = (oldValue, newValue) => {
		if (
			!oldValue ||
			!newValue ||
			typeof oldValue !== "object" ||
			typeof newValue !== "object"
		)
			return;
		const oldProperties = oldValue.properties;
		const newProperties = newValue.properties;
		if (
			[
				"skillId",
				"skillVersionId",
				"packageDigest",
				"manifestDigest",
				"signatureDigest",
			].every((field) => oldProperties?.[field] && newProperties?.[field]) &&
			sameValue(oldProperties.packageObjectVersion, oldVersion) &&
			!sameValue(
				oldProperties.packageObjectVersion,
				newProperties.packageObjectVersion,
			)
		) {
			if (sameValue(newProperties.packageObjectVersion, newVersion))
				newProperties.packageObjectVersion = structuredClone(
					oldProperties.packageObjectVersion,
				);
			else
				changes.push(
					"changed fixed Skill packageObjectVersion outside approved correction",
				);
		}
		for (const [key, value] of Object.entries(oldValue))
			if (newValue[key] !== undefined) visit(value, newValue[key]);
	};
	for (const name of [
		"AgentWorkloadDesiredV1",
		"KubernetesReconcileResultV1",
		"WorkerWorkloadExpectedRevisionV1",
		"WorkerWorkloadResultV1",
	])
		visit(previous.$defs?.[name], normalized.$defs?.[name]);
	return normalized;
}

// #1608 adds only these two audited Platform confirmation actions and the pinned
// employee installation paths. Unchanged actions may be removed from both sides
// when comparing historical exceptions whose hashes predate this addition.
const installationAuditActions = [
	"connection.installation.begin",
	"connection.installation.confirm",
];
function isConnectionInstallationOpenApiAddition(previous, current) {
	const normalized = structuredClone(current);
	const before =
		previous.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	const after = current.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	let changed = false;
	if (
		Array.isArray(before) &&
		Array.isArray(after) &&
		installationAuditActions.every(
			(action) => !before.includes(action) && after.includes(action),
		)
	) {
		const expected = before.flatMap((action) =>
			action === "skill.version.refused"
				? [action, ...installationAuditActions]
				: [action],
		);
		if (!sameValue(after, expected)) return false;
		normalized.components.schemas.ScopedPlatformAuditActionV1.enum =
			structuredClone(before);
		changed = true;
	}
	const paths = [
		"/api/connection-installations",
		"/api/connection-installations/{authorizationId}",
		"/api/connection-installations/{authorizationId}/confirm",
	];
	const added = paths.filter(
		(path) =>
			previous.paths?.[path] === undefined &&
			current.paths?.[path] !== undefined,
	);
	if (added.length !== 0 && added.length !== 3) return false;
	if (added.length === 3) {
		const value = Object.fromEntries(
			paths.map((path) => [path, current.paths[path]]),
		);
		if (
			createHash("sha256").update(JSON.stringify(value)).digest("hex") !==
			"a2072cebeabe24c44b0d062db60f6caa86874f5bd9ef65df382169e41346a75f"
		)
			return false;
		for (const path of paths) delete normalized.paths[path];
		changed = true;
	}
	return changed && findBreakingChanges(previous, normalized).length === 0;
}

// #1756 adds the administrator employee disable/reenable operation, its
// status/result schemas, and the two bounded user governance audit actions.
function isPlatformUserDisableOpenApiAddition(previous, current) {
	const path = "/api/v2/admin/users/{userId}/disable";
	const schemas = [
		"PlatformUserDisableCommandV1",
		"PlatformUserDisableStatusV1",
		"PlatformUserDisableResultV1",
	];
	const actions = ["platform.user.disabled", "platform.user.reenabled"];
	const oldActions =
		previous.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	const newActions =
		current.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	const subjectTypeNames = [
		"PlatformAuditProjectionV1",
		"PlatformAuditProjectionV2",
	];
	const hasGovernance = (document) =>
		document.paths?.[path] !== undefined ||
		schemas.some(
			(schema) => document.components?.schemas?.[schema] !== undefined,
		) ||
		actions.some((action) =>
			document.components?.schemas?.ScopedPlatformAuditActionV1?.enum?.includes(
				action,
			),
		) ||
		subjectTypeNames.some((name) =>
			document.components?.schemas?.[
				name
			]?.properties?.subjectType?.enum?.includes("user"),
		);
	const removeGovernance = (document) => {
		if (document.paths?.[path] !== undefined) delete document.paths[path];
		for (const schema of schemas) {
			if (document.components?.schemas?.[schema] !== undefined)
				delete document.components.schemas[schema];
		}
		const auditActions =
			document.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
		if (Array.isArray(auditActions))
			document.components.schemas.ScopedPlatformAuditActionV1.enum =
				auditActions.filter((action) => !actions.includes(action));
		for (const name of subjectTypeNames) {
			const subjectType =
				document.components?.schemas?.[name]?.properties?.subjectType?.enum;
			if (Array.isArray(subjectType))
				document.components.schemas[name].properties.subjectType.enum =
					subjectType.filter((kind) => kind !== "user");
		}
		return document;
	};
	if (hasGovernance(previous)) {
		if (!hasGovernance(current)) return false;
		for (const schema of schemas) {
			if (
				previous.components?.schemas?.[schema] !== undefined &&
				!sameValue(
					previous.components.schemas[schema],
					current.components?.schemas?.[schema],
				)
			)
				return false;
		}
		if (
			previous.paths?.[path] !== undefined &&
			!sameValue(previous.paths[path], current.paths?.[path])
		)
			return false;
		const previousGovernanceActions =
			previous.components?.schemas?.ScopedPlatformAuditActionV1?.enum?.filter(
				(action) => actions.includes(action),
			);
		const currentGovernanceActions =
			current.components?.schemas?.ScopedPlatformAuditActionV1?.enum?.filter(
				(action) => actions.includes(action),
			);
		if (!sameValue(previousGovernanceActions, currentGovernanceActions))
			return false;
		for (const name of subjectTypeNames) {
			const previousGovernanceSubjects = previous.components?.schemas?.[
				name
			]?.properties?.subjectType?.enum?.filter((kind) => kind === "user");
			const currentGovernanceSubjects = current.components?.schemas?.[
				name
			]?.properties?.subjectType?.enum?.filter((kind) => kind === "user");
			if (!sameValue(previousGovernanceSubjects, currentGovernanceSubjects))
				return false;
		}
		return (
			findBreakingChanges(
				removeGovernance(structuredClone(previous)),
				removeGovernance(structuredClone(current)),
			).length === 0
		);
	}
	const pathValue = current.paths?.[path];
	const currentSchemas = schemas.filter(
		(schema) => current.components?.schemas?.[schema] !== undefined,
	);
	const hasPrimaryAddition =
		pathValue !== undefined || currentSchemas.length > 0;
	if (
		hasPrimaryAddition &&
		(pathValue === undefined || currentSchemas.length !== schemas.length)
	)
		return false;
	if (Array.isArray(oldActions) || Array.isArray(newActions)) {
		if (
			!Array.isArray(oldActions) ||
			!Array.isArray(newActions) ||
			newActions.filter((action) => actions.includes(action)).length !==
				actions.length ||
			!sameValue(
				newActions.filter((action) => !actions.includes(action)),
				oldActions,
			)
		)
			return false;
	}
	const subjectTypes = {};
	for (const name of subjectTypeNames) {
		const before =
			previous.components?.schemas?.[name]?.properties?.subjectType?.enum;
		const after =
			current.components?.schemas?.[name]?.properties?.subjectType?.enum;
		if (after === undefined) continue;
		if (
			!Array.isArray(before) ||
			!Array.isArray(after) ||
			before.includes("user") ||
			after.filter((kind) => kind === "user").length !== 1 ||
			!sameValue(
				after.filter((kind) => kind !== "user"),
				before,
			)
		)
			return false;
		subjectTypes[name] = after;
	}
	const addition = {
		path,
		pathValue,
		schemas: Object.fromEntries(
			currentSchemas.map((schema) => [
				schema,
				current.components.schemas[schema],
			]),
		),
		auditActions: actions,
		subjectTypes,
	};
	const additionHash = createHash("sha256")
		.update(JSON.stringify(addition))
		.digest("hex");
	if (
		![
			"7d6b294b1fceccc25951e3a151230a1a814107d894e374074d64e6f7171b4d2a",
			"b59e8320af07f35f0d8a5c59577f1ce00dbcb77ba2f89fead71e95e4fa249e8b",
		].includes(additionHash)
	)
		return false;
	const normalized = removeGovernance(structuredClone(current));
	return findBreakingChanges(previous, normalized).length === 0;
}
function isConnectionInstallationAuthorizationUrlAddition(previous, current) {
	const normalized = structuredClone(current);
	const paths = [
		["/api/connection-installations", "post", "202"],
		["/api/connection-installations/{authorizationId}", "post", "200"],
		["/api/connection-installations/{authorizationId}/confirm", "post", "202"],
	];
	let changed = false;
	for (const [path, method, status] of paths) {
		const before =
			previous.paths?.[path]?.[method]?.responses?.[status]?.content?.[
				"application/json"
			]?.schema?.properties?.authorizationUrl;
		const after =
			normalized.paths?.[path]?.[method]?.responses?.[status]?.content?.[
				"application/json"
			]?.schema?.properties?.authorizationUrl;
		if (before !== undefined || after === undefined) return false;
		delete normalized.paths[path][method].responses[status].content[
			"application/json"
		].schema.properties.authorizationUrl;
		changed = true;
	}
	return changed && findBreakingChanges(previous, normalized).length === 0;
}

// #1760 and #2305 add optional verified runtime capabilities to Agent API
// projections. Browser/native-metadata-absent consumers keep the historical
// response shape.
function isPilotBrowserProjectionOpenApiAddition(previous, current) {
	const normalized = structuredClone(current);
	let changed = false;
	for (const name of ["AgentProjectionV1", "AgentProjectionV2"]) {
		const currentCapabilities =
			normalized.components?.schemas?.[name]?.properties?.capabilities;
		const previousCapabilities =
			previous.components?.schemas?.[name]?.properties?.capabilities;
		if (
			currentCapabilities?.properties?.browser !== undefined &&
			previousCapabilities?.properties?.browser === undefined
		) {
			delete currentCapabilities.properties.browser;
			changed = true;
		}
		if (
			currentCapabilities?.properties?.nativeMetadata !== undefined &&
			previousCapabilities?.properties?.nativeMetadata === undefined
		) {
			delete currentCapabilities.properties.nativeMetadata;
			changed = true;
		}
	}
	return changed && findBreakingChanges(previous, normalized).length === 0;
}

// Runtime operation facts may add optional, non-secret Connection consumer
// references without invalidating existing event readers.
function normalizeRuntimeConnectionAssociationOpenApiAddition(current) {
	const normalized = structuredClone(current);
	const fields = ["consumerId", "instanceRef", "credentialRevision"];
	const visit = (value) => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		if (
			value.properties &&
			typeof value.properties === "object" &&
			value.properties.serviceRef &&
			value.properties.verification
		) {
			for (const field of fields) {
				const schema = value.properties[field];
				if (schema === undefined || value.required?.includes(field)) continue;
				if (
					schema === null ||
					typeof schema !== "object" ||
					Array.isArray(schema) ||
					schema.type !== "string" ||
					schema.pattern !== "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" ||
					Object.keys(schema).some((key) => key !== "type" && key !== "pattern")
				)
					continue;
				delete value.properties[field];
			}
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(normalized);
	return normalized;
}

// #2181 binds mounted Skill resources to the directory generation. Treat the
// additive generation field as a reviewed compatibility extension for the
// already published Runtime V1 host read contract.
function normalizeRuntimeSkillHostReadJsonSchemaAddition(previous, current) {
	const normalized = structuredClone(current);
	const previousSchemas = previous.$defs ?? previous.components?.schemas;
	const names = [
		"RuntimeSkillResourceReadRequestV1",
		"RuntimeSkillResourceReadResponseV1",
	];
	if (
		names.some(
			(name) => previousSchemas?.[name]?.properties?.generationId !== undefined,
		)
	)
		return normalized;
	const schemas = normalized.$defs ?? normalized.components?.schemas;
	for (const name of names) {
		const schema = schemas?.[name];
		if (!schema) continue;
		delete schema.properties?.generationId;
		if (Array.isArray(schema.required))
			schema.required = schema.required.filter((key) => key !== "generationId");
	}
	return normalized;
}
function findBreakingChanges(previousValue, currentValue) {
	let previous = previousValue;
	let current = currentValue;
	const before =
		previous.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	const after = current.components?.schemas?.ScopedPlatformAuditActionV1?.enum;
	if (
		Array.isArray(before) &&
		Array.isArray(after) &&
		installationAuditActions.every(
			(action) => before.includes(action) && after.includes(action),
		)
	) {
		previous = structuredClone(previous);
		current = structuredClone(current);
		previous.components.schemas.ScopedPlatformAuditActionV1.enum =
			before.filter((action) => !installationAuditActions.includes(action));
		current.components.schemas.ScopedPlatformAuditActionV1.enum = after.filter(
			(action) => !installationAuditActions.includes(action),
		);
	}
	const changes = [];
	if (previous.openapi !== undefined) {
		previous = normalizeRuntimeConnectionAssociationOpenApiAddition(previous);
		current = normalizeRuntimeConnectionAssociationOpenApiAddition(current);
		if (isA2ParallelModelConfigurationOpenApiAddition(previous, current))
			return changes;
		if (
			!sameValue(previous, current) &&
			!isAgentApplicationUseGrantOpenApiAddition(previous, current) &&
			!isAgentUserUseRevokeOpenApiAddition(previous, current) &&
			!isAgentUserUseGrantOpenApiAddition(previous, current) &&
			!isAgentApiManagementOpenApiAddition(previous, current) &&
			!isAgentApiCreationOpenApiAddition(previous, current) &&
			!isConnectionCapabilityOpenApiAddition(previous, current) &&
			!isKnownCredentialAuditSubjectAddition(previous, current) &&
			!isPersonalCredentialNarrowOpenApiAddition(previous, current) &&
			!isPersonalCredentialListOpenApiAddition(previous, current) &&
			!isModelSelectionFallbackOpenApiAddition(previous, current) &&
			!isAgentSummaryOpenApiAddition(previous, current) &&
			!isRuntimeStatusRecoveryOpenApiAddition(previous, current) &&
			!isRuntimeStatusBusyOutcomeOpenApiAddition(previous, current) &&
			!isRuntimeSkillCapabilityOpenApiAddition(previous, current) &&
			!isRuntimeSkillHostReadOpenApiAddition(previous, current) &&
			!isRuntimeSkillReadGrantCommandOpenApiAddition(previous, current) &&
			!isRuntimeBrowserEvidenceOpenApiAddition(previous, current) &&
			!isRuntimeBrowserOperationFactOpenApiAddition(previous, current) &&
			!isRuntimeBrowserWorkloadIdentityOpenApiAddition(previous, current) &&
			!isPilotBrowserProjectionOpenApiAddition(previous, current) &&
			!isRuntimeOriginalBindingV3OpenApiAddition(previous, current) &&
			!isApplicationRegistrationV2OpenApiAddition(previous, current) &&
			!isOwnApplicationMetadataV2OpenApiAddition(previous, current) &&
			!isApplicationMaterialGrantV2OpenApiAddition(previous, current) &&
			!isApplicationCredentialIssuerV2OpenApiAddition(previous, current) &&
			!isOwnApplicationDisableV2OpenApiAddition(previous, current) &&
			!isAgentLifecycleV2OpenApiAddition(previous, current) &&
			!isDeploymentConfigurationV2OpenApiAddition(previous, current) &&
			!isTemplateReadinessV2OpenApiAddition(previous, current) &&
			!isAgentOwnerScopeOpenApiAddition(previous, current) &&
			!isAdministratorAgentReadV2OpenApiAddition(previous, current) &&
			!isPersonalApiCredentialV2OpenApiAddition(previous, current) &&
			!isPersonalApiAgentReadV2OpenApiAddition(previous, current) &&
			!isPersonalApiAgentReadAuditOpenApiAddition(previous, current) &&
			!isPersonalRelayKeyAuditOpenApiAddition(previous, current) &&
			!isPersonalRelayKeyV2OpenApiAddition(previous, current) &&
			!isAgentDefaultRelayKeyV2OpenApiAddition(previous, current) &&
			!isApplicationDefaultRelayKeyV2OpenApiAddition(previous, current) &&
			!isKeylessModelReplacementOpenApiAddition(previous, current) &&
			!isAgentDefaultRelayKeyInputOpenApiAddition(previous, current) &&
			!isTaskHttpV1OpenApiAddition(previous, current) &&
			!isTaskHttpV1SseOpenApiAddition(previous, current) &&
			!isConversationFactsV2OpenApiAddition(previous, current) &&
			!isConversationEventWindowOpenApiAddition(previous, current) &&
			!isConversationSseV2NotFoundAddition(previous, current) &&
			!isConversationSessionAvailabilityOpenApiAddition(previous, current) &&
			!isConversationSessionUpdatingOpenApiAddition(previous, current) &&
			!isRecentPersonalConversationsV2OpenApiAddition(previous, current) &&
			!isSkillHubReadOpenApiAddition(previous, current) &&
			!isSkillHubInstallationOpenApiAddition(previous, current) &&
			!isSkillHubPublicationOpenApiAddition(previous, current) &&
			!isSkillHubProjectAndImportOpenApiAddition(previous, current) &&
			!isSkillHubProjectOpenApiAddition(previous, current) &&
			!isSkillHubImportOpenApiAddition(previous, current) &&
			!isSkillHubAgentBindingOpenApiAddition(previous, current) &&
			!isNativeMetadataOpenApiAddition(previous, current) &&
			!isWecomReceiptOpenApiAddition(previous, current) &&
			!isWecomQrAuthorizationOpenApiAddition(previous, current) &&
			!isWecomApplicationOpenApiAddition(previous, current) &&
			!isScopedAuditOpenApiAddition(previous, current) &&
			!isSkillHubAuditActionOpenApiAddition(previous, current) &&
			!isConnectionInstallationOpenApiAddition(previous, current) &&
			!isPlatformUserDisableOpenApiAddition(previous, current) &&
			!isConnectionInstallationAuthorizationUrlAddition(previous, current) &&
			!isAgentCreationAuditActionOpenApiAddition(previous, current) &&
			!isScopedAuditCredentialSecurityAddition(previous, current) &&
			!isRuntimeFileExchangeOpenApiAddition(previous, current) &&
			!isFileAuthorityOpenApiAddition(previous, current) &&
			!isCustomAgentModelSelectionOpenApiAddition(previous, current) &&
			!isRuntimeOperationIdentityOpenApiAddition(previous, current) &&
			!isRuntimeBrowserHandoffOpenApiAddition(previous, current) &&
			!isCustomAgentModelProjectionOpenApiAddition(previous, current) &&
			!isStandardTemplateReleaseCompatibilityOpenApiAddition(previous, current)
		) {
			changes.push("changed OpenAPI contract");
		}
		return changes.sort();
	}
	const previousSchemas = previous.$defs ?? previous.components?.schemas ?? {};
	const normalized = normalizeRuntimeSkillHostReadJsonSchemaAddition(
		previous,
		normalizeSkillPackageObjectVersions(previous, current, changes),
	);
	const currentSchemas =
		normalized.$defs ?? normalized.components?.schemas ?? {};
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
			maxBuffer: gitArtifactMaxBufferBytes,
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
