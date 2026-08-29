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
	pilotBrowserOpenApiPathsV1,
	pilotBrowserSchemasV1,
	pilotBrowserSseOpenApiPathsV1,
	pilotDelegatedOpenApiPathsV1,
	pilotDelegatedSchemasV1,
	pilotSseSchemasV1,
} from "./pilot/index.ts";
import { registryManifestSchemasV1 } from "./workload/index.ts";

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
	pilotBrowserOpenapi: resolve(
		artifactRoot,
		"openapi/pilot-browser.v1.openapi.json",
	),
	pilotDelegatedJsonSchema: resolve(
		artifactRoot,
		"json-schema/pilot-delegated.v1.schema.json",
	),
	pilotDelegatedOpenapi: resolve(
		artifactRoot,
		"openapi/pilot-delegated.v1.openapi.json",
	),
	pilotSseJsonSchema: resolve(
		artifactRoot,
		"json-schema/pilot-sse.v1.schema.json",
	),
	registryManifestJsonSchema: resolve(
		artifactRoot,
		"json-schema/registry-manifest.v1.schema.json",
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
	const registryManifestJsonSchema = jsonSchemaDocument({
		id: "https://github.com/AgoraIO-Extensions/agent-infra/schemas/registry-manifest.v1.schema.json",
		title: "Agent Infra Registry and Runtime Manifest Contracts V1",
		definitions: registryManifestSchemasV1,
		io: "input",
	});
	return {
		jsonSchema,
		openapi,
		pilotBrowserOpenapi,
		pilotDelegatedJsonSchema,
		pilotDelegatedOpenapi,
		pilotSseJsonSchema,
		registryManifestJsonSchema,
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
