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
	connectionBrowserOpenApiPathsV1,
	connectionBrowserSchemasV1,
	connectionCatalogOpenApiPathsV1,
	connectionCatalogSchemasV1,
	connectionSchemasV1,
	pilotBrowserOpenApiPathsV1,
	pilotBrowserOpenApiPathsV2,
	pilotBrowserSchemasV1,
	pilotBrowserSchemasV2,
	pilotBrowserSseOpenApiPathsV1,
	pilotDelegatedOpenApiPathsV1,
	pilotDelegatedOpenApiPathsV2,
	pilotDelegatedSchemasV1,
	pilotDelegatedSchemasV2,
	pilotSseSchemasV1,
} from "./pilot/index.ts";
import {
	RuntimeCapabilitiesRequestV1Schema,
	RuntimeCapabilitiesResponseV1Schema,
	RuntimeDriverV1SchemaDefinitions,
	RuntimeDriverV2SchemaDefinitions,
	RuntimeEventV1Schema,
	RuntimeEventV1SchemaDefinitions,
	RuntimeGenerationCancelRequestV1Schema,
	RuntimeHostV1SchemaDefinitions,
	RuntimeHostV2SchemaDefinitions,
	RuntimeOperationResponseV1Schema,
	RuntimeOperationResponseV2Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStatusRequestV1Schema,
	RuntimeStatusRequestV2Schema,
	RuntimeStatusResponseV1Schema,
	RuntimeStatusResponseV2Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSubmitTurnRequestV2Schema,
	RuntimeSupplementRequestV1Schema,
} from "./runtime/index.ts";
import {
	kubernetesWorkloadSchemasV1,
	registryManifestSchemasV1,
	secretLifecycleSchemasV1,
	workerResultSchemasV1,
} from "./workload/index.ts";

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
	connectionJsonSchema: resolve(
		artifactRoot,
		"json-schema/connection.v1.schema.json",
	),
	connectionBrowserOpenapi: resolve(
		artifactRoot,
		"openapi/connection-browser.v1.openapi.json",
	),
	connectionCatalogOpenapi: resolve(
		artifactRoot,
		"openapi/connection-catalog.v1.openapi.json",
	),
	jsonSchema: resolve(artifactRoot, "json-schema/common.v1.schema.json"),
	openapi: resolve(artifactRoot, "openapi/common.v1.openapi.json"),
	pilotBrowserOpenapi: resolve(
		artifactRoot,
		"openapi/pilot-browser.v1.openapi.json",
	),
	pilotBrowserOpenapiV2: resolve(
		artifactRoot,
		"openapi/pilot-browser.v2.openapi.json",
	),
	pilotDelegatedJsonSchema: resolve(
		artifactRoot,
		"json-schema/pilot-delegated.v1.schema.json",
	),
	pilotDelegatedJsonSchemaV2: resolve(
		artifactRoot,
		"json-schema/pilot-delegated.v2.schema.json",
	),
	pilotDelegatedOpenapi: resolve(
		artifactRoot,
		"openapi/pilot-delegated.v1.openapi.json",
	),
	pilotDelegatedOpenapiV2: resolve(
		artifactRoot,
		"openapi/pilot-delegated.v2.openapi.json",
	),
	pilotSseJsonSchema: resolve(
		artifactRoot,
		"json-schema/pilot-sse.v1.schema.json",
	),
	registryManifestJsonSchema: resolve(
		artifactRoot,
		"json-schema/registry-manifest.v1.schema.json",
	),
	kubernetesWorkloadJsonSchema: resolve(
		artifactRoot,
		"json-schema/kubernetes-workload.v1.schema.json",
	),
	secretLifecycleJsonSchema: resolve(
		artifactRoot,
		"json-schema/secret-lifecycle.v1.schema.json",
	),
	workerResultJsonSchema: resolve(
		artifactRoot,
		"json-schema/worker-result.v1.schema.json",
	),
	runtimeJsonSchema: resolve(
		artifactRoot,
		"json-schema/runtime.v1.schema.json",
	),
	runtimeJsonSchemaV2: resolve(
		artifactRoot,
		"json-schema/runtime.v2.schema.json",
	),
	runtimeOpenapi: resolve(artifactRoot, "openapi/runtime-host.v1.openapi.json"),
	runtimeOpenapiV2: resolve(
		artifactRoot,
		"openapi/runtime-host.v2.openapi.json",
	),
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

function rebaseDefinitionRefs(value, definitionName) {
	if (Array.isArray(value)) {
		return value.map((entry) => rebaseDefinitionRefs(entry, definitionName));
	}
	if (value === null || typeof value !== "object") return value;
	const definitionPointer = definitionName
		.replaceAll("~", "~0")
		.replaceAll("/", "~1");
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			key === "$ref" &&
			typeof entry === "string" &&
			entry.startsWith("#/$defs/")
				? `#/$defs/${definitionPointer}/$defs/${entry.slice("#/$defs/".length)}`
				: rebaseDefinitionRefs(entry, definitionName),
		]),
	);
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

function jsonSchemaDocument({ id, title, definitions, io = "output" }) {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: id,
		title,
		$defs: Object.fromEntries(
			Object.entries(definitions).map(([name, schema]) => [
				name,
				rebaseDefinitionRefs(
					withoutSchemaDialect(
						z.toJSONSchema(schema, {
							io,
							target: "draft-2020-12",
							unrepresentable: "throw",
						}),
					),
					name,
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
	const connectionJsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/connection.v1.schema.json",
		title: "Connection Pilot Contracts V1",
		definitions: connectionSchemasV1,
	});
	const connectionBrowserOpenapi = createDocument({
		openapi: "3.1.0",
		info: { title: "Connection Pilot Browser API", version: "1.0.0" },
		paths: connectionBrowserOpenApiPathsV1,
		components: {
			securitySchemes: {
				ConnectionAdminSession: {
					type: "apiKey",
					in: "cookie",
					name: "connection_session",
					description:
						"Requires the server to revalidate the current AdministratorRole binding.",
				},
				ConnectionBrowserSession: {
					type: "apiKey",
					in: "cookie",
					name: "connection_session",
				},
				ConnectionCsrf: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
			},
			schemas: connectionBrowserSchemasV1,
		},
	});
	const connectionCatalogOpenapi = createDocument({
		openapi: "3.1.0",
		info: { title: "Connection Pilot Catalog API", version: "1.0.0" },
		paths: connectionCatalogOpenApiPathsV1,
		components: {
			securitySchemes: {
				ConnectionCatalogCredential: {
					type: "oauth2",
					flows: {
						clientCredentials: {
							tokenUrl: "/oauth/token",
							scopes: {
								"catalog:read": "Read the published Connection catalog",
							},
						},
					},
				},
			},
			schemas: connectionCatalogSchemasV1,
		},
	});
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
	const runtimeJsonSchemaV2 = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/runtime.v2.schema.json",
		title: "Agent Infra Runtime Contracts V2",
		definitions: {
			...RuntimeHostV2SchemaDefinitions,
			...RuntimeDriverV2SchemaDefinitions,
		},
	});
	const runtimeOpenapi = createDocument({
		openapi: "3.1.0",
		info: { title: "Agent Infra RuntimeHost Contract", version: "1.0.0" },
		security: [{ RuntimeServiceBearer: [] }],
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
		components: {
			securitySchemes: {
				RuntimeServiceBearer: { type: "http", scheme: "bearer" },
			},
			schemas: runtimeOpenApiDefinitions,
		},
	});
	const runtimeOpenapiV2 = createDocument({
		openapi: "3.1.0",
		info: { title: "Agent Infra RuntimeHost Contract", version: "2.0.0" },
		security: [{ RuntimeServiceBearer: [] }],
		paths: {
			"/internal/runtime/v2/turns": {
				post: postOperation(
					"submitRuntimeTurnV2",
					RuntimeSubmitTurnRequestV2Schema,
					RuntimeOperationResponseV2Schema,
					"application/json",
				),
			},
			"/internal/runtime/v2/status": {
				post: postOperation(
					"recoverRuntimeStatusV2",
					RuntimeStatusRequestV2Schema,
					RuntimeStatusResponseV2Schema,
					"application/json",
				),
			},
		},
		components: {
			securitySchemes: {
				RuntimeServiceBearer: { type: "http", scheme: "bearer" },
			},
			schemas: {
				ProtocolErrorV1: ProtocolErrorV1Schema,
				...RuntimeHostV2SchemaDefinitions,
			},
		},
	});
	const pilotBrowserOpenapi = createDocument({
		openapi: "3.1.0",
		info: {
			title: "Agent Infra Pilot Browser API",
			version: "1.0.0",
		},
		paths: {
			...pilotBrowserOpenApiPathsV1,
			...pilotBrowserSseOpenApiPathsV1,
		},
		components: {
			schemas: { ...pilotBrowserSchemasV1, ...pilotSseSchemasV1 },
		},
	});
	const pilotBrowserOpenapiV2 = createDocument({
		openapi: "3.1.0",
		info: {
			title: "Agent Infra Pilot Browser Audit API",
			version: "2.0.0",
		},
		paths: pilotBrowserOpenApiPathsV2,
		components: { schemas: pilotBrowserSchemasV2 },
	});
	const pilotSseJsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/pilot-sse.v1.schema.json",
		title: "Agent Infra Pilot SSE Contracts V1",
		definitions: pilotSseSchemasV1,
	});
	const pilotDelegatedJsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/pilot-delegated.v1.schema.json",
		title: "Agent Infra Pilot Delegated Contracts V1",
		definitions: pilotDelegatedSchemasV1,
	});
	const pilotDelegatedOpenapi = createDocument({
		openapi: "3.1.0",
		info: {
			title: "Agent Infra Pilot Delegated Action API",
			version: "1.0.0",
		},
		paths: pilotDelegatedOpenApiPathsV1,
		components: { schemas: pilotDelegatedSchemasV1 },
	});
	const pilotDelegatedJsonSchemaV2 = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/pilot-delegated.v2.schema.json",
		title: "Agent Infra Pilot Delegated Contracts V2",
		definitions: pilotDelegatedSchemasV2,
	});
	const pilotDelegatedOpenapiV2 = createDocument({
		openapi: "3.1.0",
		info: {
			title: "Agent Infra Pilot Delegated Action API",
			version: "2.0.0",
		},
		paths: pilotDelegatedOpenApiPathsV2,
		components: { schemas: pilotDelegatedSchemasV2 },
	});
	const registryManifestJsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/registry-manifest.v1.schema.json",
		title: "Agent Infra Registry and Runtime Manifest Contracts V1",
		definitions: registryManifestSchemasV1,
		io: "input",
	});
	const kubernetesWorkloadJsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/kubernetes-workload.v1.schema.json",
		title: "Agent Infra Kubernetes Workload Contracts V1",
		definitions: kubernetesWorkloadSchemasV1,
		io: "input",
	});
	const secretLifecycleJsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/secret-lifecycle.v1.schema.json",
		title: "Agent Infra Secret Lifecycle Contracts V1",
		definitions: secretLifecycleSchemasV1,
		io: "input",
	});
	const workerResultJsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/worker-result.v1.schema.json",
		title: "Agent Infra Worker Result Contracts V1",
		definitions: workerResultSchemasV1,
		io: "input",
	});
	return {
		connectionJsonSchema,
		connectionBrowserOpenapi,
		connectionCatalogOpenapi,
		jsonSchema,
		openapi,
		pilotBrowserOpenapi,
		pilotBrowserOpenapiV2,
		pilotDelegatedJsonSchema,
		pilotDelegatedJsonSchemaV2,
		pilotDelegatedOpenapi,
		pilotDelegatedOpenapiV2,
		pilotSseJsonSchema,
		kubernetesWorkloadJsonSchema,
		registryManifestJsonSchema,
		secretLifecycleJsonSchema,
		workerResultJsonSchema,
		runtimeJsonSchema,
		runtimeJsonSchemaV2,
		runtimeOpenapi,
		runtimeOpenapiV2,
	};
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
