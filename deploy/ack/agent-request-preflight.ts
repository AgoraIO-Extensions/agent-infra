import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AgentApiCreationRequestV1Schema } from "../../packages/contracts/src/pilot/browser.ts";
import { privateJson } from "./private-input.ts";

const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failureCodes = new Set([
	"REQUEST_FILE_INVALID",
	"REQUEST_FILE_TOO_MANY",
	"REQUEST_ENTRY_INVALID",
	"REQUEST_BODY_INVALID",
	"REQUEST_BODY_UNREADABLE",
]);

function failure(code: string, index?: number) {
	return {
		schemaVersion: 1,
		kind: "ack-agent-request-preflight",
		status: "failed",
		failureCode: failureCodes.has(code) ? code : "REQUEST_FILE_INVALID",
		...(index === undefined ? {} : { failedIndex: index }),
		requestCount: 0,
		bodyHashes: [],
		businessVerified: false,
	};
}

export async function validateAgentRequestFile(file: string) {
	let input: any;
	try {
		input = await privateJson(file);
	} catch {
		return failure("REQUEST_FILE_INVALID");
	}
	if (
		input?.schemaVersion !== 1 ||
		!Array.isArray(input.requests) ||
		input.requests.length < 1 ||
		input.requests.length > 20
	)
		return failure(input?.requests?.length > 20 ? "REQUEST_FILE_TOO_MANY" : "REQUEST_FILE_INVALID");
	const bodyHashes: string[] = [];
	const sourceKinds = new Set<string>();
	for (const [index, request] of input.requests.entries()) {
		if (
			!request ||
			typeof request !== "object" ||
			Object.keys(request).some((key) =>
				!["name", "bodyFile", "credentialFile", "idempotencyKey"].includes(key),
			) ||
			typeof request.name !== "string" ||
			!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(request.name) ||
			typeof request.bodyFile !== "string" ||
			typeof request.credentialFile !== "string" ||
			typeof request.idempotencyKey !== "string" ||
			!/^[\x21-\x7e]{8,256}$/u.test(request.idempotencyKey)
		)
			return failure("REQUEST_ENTRY_INVALID", index);
		let body: unknown;
		try {
			body = await privateJson(request.bodyFile);
		} catch {
			return failure("REQUEST_BODY_UNREADABLE", index);
		}
		const parsed = AgentApiCreationRequestV1Schema.safeParse(body);
		if (!parsed.success) return failure("REQUEST_BODY_INVALID", index);
		bodyHashes.push(hash(body));
		sourceKinds.add((parsed.data as any).source.kind);
	}
	return {
		schemaVersion: 1,
		kind: "ack-agent-request-preflight",
		status: "passed",
		requestCount: input.requests.length,
		sourceKinds: [...sourceKinds].sort(),
		bodyHashes,
		businessVerified: false,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		assert(process.argv[2]);
		const result = await validateAgentRequestFile(process.argv[2]);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		if (result.status !== "passed") process.exitCode = 1;
	} catch {
		process.stdout.write(`${JSON.stringify(failure("REQUEST_FILE_INVALID"))}\n`);
		process.exitCode = 1;
	}
}
