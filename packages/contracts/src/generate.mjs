import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { createDocument } from "zod-openapi";

import {
	IdempotencyKeyV1Schema,
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	ProtocolErrorV1Schema,
	RequestIdV1Schema,
	RetryableV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
	TraceIdV1Schema,
} from "./index.ts";
import {
	RuntimeCapabilitiesRequestV1Schema,
	RuntimeCapabilitiesResponseV1Schema,
	RuntimeDriverV1SchemaDefinitions,
	RuntimeEventV1Schema,
	RuntimeEventV1SchemaDefinitions,
	RuntimeGenerationCancelRequestV1Schema,
	RuntimeHostV1SchemaDefinitions,
	RuntimeOperationResponseV1Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStatusRequestV1Schema,
	RuntimeStatusResponseV1Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSupplementRequestV1Schema,
} from "./runtime/index.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
const rootOption = process.argv.indexOf("--root");
const artifactRoot =
	rootOption === -1
		? resolve(packageRoot, "artifacts")
		: resolve(process.argv[rootOption + 1] ?? "");
if (rootOption !== -1 && !process.argv[rootOption + 1]) {
	throw new Error("--root requires a directory");
}
const artifactPaths = {
	jsonSchema: resolve(artifactRoot, "json-schema/common.v1.schema.json"),
	openapi: resolve(artifactRoot, "openapi/common.v1.openapi.json"),
	runtimeJsonSchema: resolve(
		artifactRoot,
		"json-schema/runtime.v1.schema.json",
	),
	runtimeOpenapi: resolve(artifactRoot, "openapi/runtime-host.v1.openapi.json"),
};
const schemas = {
	IdempotencyKeyV1: IdempotencyKeyV1Schema,
	OpaqueCursorV1: OpaqueCursorV1Schema,
	OpaqueIdV1: OpaqueIdV1Schema,
	ProtocolErrorV1: ProtocolErrorV1Schema,
	RequestIdV1: RequestIdV1Schema,
	RetryableV1: RetryableV1Schema,
	Rfc3339TimestampV1: Rfc3339TimestampV1Schema,
	SchemaVersionV1: SchemaVersionV1Schema,
	TraceIdV1: TraceIdV1Schema,
};

function withoutSchemaDialect(schema) {
	const { $schema: _schema, ...definition } = schema;
	return definition;
}

function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => [key, sortKeys(entry)]),
	);
}

function serialize(value) {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function jsonSchemaDocument({ id, title, definitions }) {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: id,
		title,
		$defs: Object.fromEntries(
			Object.entries(definitions).map(([name, schema]) => [
				name,
				withoutSchemaDialect(
					z.toJSONSchema(schema, {
						target: "draft-2020-12",
						unrepresentable: "throw",
					}),
				),
			]),
		),
	};
}

function protocolErrorResponse(description) {
	return {
		description,
		content: { "application/json": { schema: ProtocolErrorV1Schema } },
	};
}

const runtimeErrorResponses = {
	400: protocolErrorResponse("Invalid RuntimeHost request"),
	401: protocolErrorResponse("RuntimeHost authentication required"),
	403: protocolErrorResponse("Execution Grant is not authorized"),
	404: protocolErrorResponse("Runtime session or operation is unavailable"),
	409: protocolErrorResponse("Generation, fence, or operation conflict"),
	500: protocolErrorResponse("RuntimeHost operation failed"),
	503: protocolErrorResponse("Runtime or Driver is unavailable"),
};

function postOperation(operationId, requestSchema, responseSchema, mediaType) {
	return {
		operationId,
		requestBody: {
			required: true,
			content: { "application/json": { schema: requestSchema } },
		},
		responses: {
			200: {
				description: "RuntimeHost response",
				content: { [mediaType]: { schema: responseSchema } },
			},
			...runtimeErrorResponses,
		},
	};
}

function buildArtifacts() {
	const openapi = createDocument({
		openapi: "3.1.0",
		info: {
			title: "Agent Infra Common Contracts",
			version: "1.0.0",
		},
		paths: {},
		components: { schemas },
	});
	const jsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/common.v1.schema.json",
		title: "Agent Infra Common Contracts V1",
		definitions: schemas,
	});
	const runtimeDefinitions = {
		...RuntimeHostV1SchemaDefinitions,
		...RuntimeEventV1SchemaDefinitions,
		...RuntimeDriverV1SchemaDefinitions,
	};
	const runtimeOpenApiDefinitions = {
		ProtocolErrorV1: ProtocolErrorV1Schema,
		...RuntimeHostV1SchemaDefinitions,
		...RuntimeEventV1SchemaDefinitions,
	};
	const runtimeJsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/runtime.v1.schema.json",
		title: "Agent Infra Runtime Contracts V1",
		definitions: runtimeDefinitions,
	});
	const runtimeOpenapi = createDocument({
		openapi: "3.1.0",
		info: {
			title: "Agent Infra RuntimeHost Contract",
			version: "1.0.0",
		},
		paths: {
			"/internal/runtime/v1/turns": {
				post: postOperation(
					"submitRuntimeTurnV1",
					RuntimeSubmitTurnRequestV1Schema,
					RuntimeOperationResponseV1Schema,
					"application/json",
				),
			},
			"/internal/runtime/v1/instructions": {
				post: postOperation(
					"supplementRuntimeTurnV1",
					RuntimeSupplementRequestV1Schema,
					RuntimeOperationResponseV1Schema,
					"application/json",
				),
			},
			"/internal/runtime/v1/stops": {
				post: postOperation(
					"stopRuntimeTurnV1",
					RuntimeStopRequestV1Schema,
					RuntimeOperationResponseV1Schema,
					"application/json",
				),
			},
			"/internal/runtime/v1/status": {
				post: postOperation(
					"readRuntimeStatusV1",
					RuntimeStatusRequestV1Schema,
					RuntimeStatusResponseV1Schema,
					"application/json",
				),
			},
			"/internal/runtime/v1/capabilities": {
				post: postOperation(
					"readRuntimeCapabilitiesV1",
					RuntimeCapabilitiesRequestV1Schema,
					RuntimeCapabilitiesResponseV1Schema,
					"application/json",
				),
			},
			"/internal/runtime/v1/events/replay": {
				post: postOperation(
					"replayRuntimeEventsV1",
					RuntimeReplayRequestV1Schema,
					RuntimeEventV1Schema,
					"text/event-stream",
				),
			},
			"/internal/runtime/v1/events/stream": {
				post: postOperation(
					"streamRuntimeEventsV1",
					RuntimeReplayRequestV1Schema,
					RuntimeEventV1Schema,
					"text/event-stream",
				),
			},
			"/internal/runtime/v1/generations/cancel": {
				post: postOperation(
					"cancelRuntimeGenerationV1",
					RuntimeGenerationCancelRequestV1Schema,
					RuntimeOperationResponseV1Schema,
					"application/json",
				),
			},
		},
		components: { schemas: runtimeOpenApiDefinitions },
	});
	return { jsonSchema, openapi, runtimeJsonSchema, runtimeOpenapi };
}

async function writeArtifacts(artifacts) {
	for (const [kind, path] of Object.entries(artifactPaths)) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, serialize(artifacts[kind]), "utf8");
	}
}

async function checkArtifacts(artifacts) {
	const drift = [];
	for (const [kind, path] of Object.entries(artifactPaths)) {
		const expected = serialize(artifacts[kind]);
		const actual = await readFile(path, "utf8").catch(() => undefined);
		if (actual !== expected) drift.push(path);
	}
	if (drift.length > 0) {
		throw new Error(
			`Generated contract artifacts are stale: ${drift.join(", ")}`,
		);
	}
}

const artifacts = buildArtifacts();

if (command === "--stdout") {
	process.stdout.write(serialize(artifacts));
} else if (command === "--write") {
	await writeArtifacts(artifacts);
} else if (command === "--check") {
	await checkArtifacts(artifacts);
} else {
	throw new Error(
		"Usage: generate.mjs (--stdout | --write | --check) [--root directory]",
	);
}
