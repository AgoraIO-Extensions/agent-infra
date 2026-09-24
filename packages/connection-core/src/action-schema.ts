import { canonicalJson } from "./calls.js";

export type ActionSchema = Record<string, unknown>;

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equal(left: unknown, right: unknown): boolean {
	try {
		return canonicalJson(left) === canonicalJson(right);
	} catch {
		return false;
	}
}

function matchesType(type: unknown, value: unknown): boolean {
	const types = typeof type === "string" ? [type] : type;
	if (type === undefined) return true;
	if (!Array.isArray(types) || !types.every((item) => typeof item === "string"))
		return false;
	return types.some((item) => {
		switch (item) {
			case "null":
				return value === null;
			case "boolean":
				return typeof value === "boolean";
			case "object":
				return object(value);
			case "array":
				return Array.isArray(value);
			case "string":
				return typeof value === "string";
			case "number":
				return typeof value === "number" && Number.isFinite(value);
			case "integer":
				return typeof value === "number" && Number.isSafeInteger(value);
			default:
				return false;
		}
	});
}

function valid(schema: unknown, value: unknown): boolean {
	if (schema === true) return true;
	if (schema === false || !object(schema)) return false;
	if ("$ref" in schema || "$dynamicRef" in schema) return false;
	if (!matchesType(schema.type, value)) return false;
	if ("const" in schema && !equal(value, schema.const)) return false;
	if (
		Array.isArray(schema.enum) &&
		!schema.enum.some((item) => equal(value, item))
	)
		return false;
	if (
		Array.isArray(schema.allOf) &&
		!schema.allOf.every((item) => valid(item, value))
	)
		return false;
	if (
		Array.isArray(schema.anyOf) &&
		!schema.anyOf.some((item) => valid(item, value))
	)
		return false;
	if (
		Array.isArray(schema.oneOf) &&
		schema.oneOf.filter((item) => valid(item, value)).length !== 1
	)
		return false;

	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength)
			return false;
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
			return false;
		if (typeof schema.pattern === "string") {
			try {
				if (!new RegExp(schema.pattern).test(value)) return false;
			} catch {
				return false;
			}
		}
	}
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum)
			return false;
		if (typeof schema.maximum === "number" && value > schema.maximum)
			return false;
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems)
			return false;
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
			return false;
		if (
			schema.uniqueItems === true &&
			value.some((item, index) =>
				value.slice(0, index).some((previous) => equal(item, previous)),
			)
		)
			return false;
		if (
			schema.items !== undefined &&
			!value.every((item) => valid(schema.items, item))
		)
			return false;
	}
	if (object(value)) {
		const properties = object(schema.properties) ? schema.properties : {};
		if (Array.isArray(schema.required)) {
			if (!schema.required.every((key) => typeof key === "string"))
				return false;
			if (!schema.required.every((key) => key in value)) return false;
		}
		for (const [key, property] of Object.entries(properties))
			if (key in value && !valid(property, value[key])) return false;
		for (const [key, entry] of Object.entries(value)) {
			if (key in properties) continue;
			if (schema.additionalProperties === false) return false;
			if (
				schema.additionalProperties !== undefined &&
				!valid(schema.additionalProperties, entry)
			)
				return false;
		}
	}
	return true;
}

/** Validate MCP arguments against the Connection-owned Action Schema. */
export function validateActionArguments(
	schema: ActionSchema,
	argumentsValue: unknown,
): boolean {
	return valid(schema, argumentsValue);
}
