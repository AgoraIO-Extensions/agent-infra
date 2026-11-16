import type { ConnectionAssociationVerificationV1 } from "@agent-infra/platform-core";

/**
 * Spec §13.5.7 Owner manual association: one read-only Connection call
 * (`GET /connection/v1/agents/{agentId}/actions`) authenticated with the submitted
 * service credential. The credential never reaches logs, errors or responses; the
 * response body is read only to confirm the authenticated Connection Agent.
 */
export interface ConnectionAssociationVerifierOptionsV1 {
	/** Approved one-time system access origin, e.g. `https://connection.example`. */
	readonly publicOrigin: string;
	readonly fetch?: typeof fetch;
}

const maximumBytes = 256 * 1024;
const unavailableCodes =
	/(?:^|_)(?:DISABLED|INACTIVE|SUSPENDED|DELETED|PAUSED)(?:_|$)/;

async function boundedJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	if (!response.body) return undefined;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	let complete = false;
	try {
		while (true) {
			signal.throwIfAborted();
			const next = await reader.read();
			if (next.done) {
				complete = true;
				break;
			}
			length += next.value.byteLength;
			if (length > maximumBytes) throw new Error("oversized");
			chunks.push(next.value);
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
	} finally {
		if (!complete) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Identifiers the response may echo for the authenticated Connection Agent. */
function reportedAgentIds(value: unknown): string[] {
	if (!object(value)) return [];
	const candidates = [value, value.agent, value.consumer].filter(object);
	return candidates.flatMap((candidate) =>
		["agentId", "consumerId"].flatMap((key) =>
			typeof candidate[key] === "string" ? [candidate[key] as string] : [],
		),
	);
}

function errorCode(value: unknown): string | undefined {
	if (!object(value)) return undefined;
	const error = object(value.error) ? value.error : value;
	return typeof error.code === "string" ? error.code : undefined;
}

export function createConnectionAssociationVerifierV1(
	options: ConnectionAssociationVerifierOptionsV1,
) {
	const origin = new URL(options.publicOrigin);
	if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin)
		throw new Error("CONNECTION_ASSOCIATION_CONFIGURATION_INVALID");
	const send = options.fetch ?? fetch;
	return async (
		input: {
			readonly connectionAgentId: string;
			readonly serviceCredential: string;
		},
		signal: AbortSignal,
	): Promise<ConnectionAssociationVerificationV1> => {
		const target = `${origin.origin}/connection/v1/agents/${encodeURIComponent(input.connectionAgentId)}/actions`;
		let response: Response;
		try {
			response = await send(
				new Request(target, {
					method: "GET",
					headers: {
						accept: "application/json",
						authorization: `Bearer ${input.serviceCredential}`,
					},
					credentials: "omit",
					redirect: "error",
					signal,
				}),
			);
		} catch {
			return "unknown";
		}
		try {
			if (response.redirected || (response.url && response.url !== target))
				return "unknown";
			const json = (
				response.headers.get("content-type")?.split(";")[0]?.trim() ?? ""
			).toLowerCase();
			const body =
				json === "application/json"
					? await boundedJson(response, signal).catch(() => undefined)
					: undefined;
			if (response.status === 200) {
				if (json !== "application/json" || body === undefined) return "unknown";
				const reported = reportedAgentIds(body);
				// An echoed identity must be the submitted Connection Agent.
				return reported.every((id) => id === input.connectionAgentId)
					? "verified"
					: "credential_rejected";
			}
			const code = errorCode(body);
			if (code && unavailableCodes.test(code)) return "consumer_unavailable";
			if ([401, 403, 404].includes(response.status))
				return "credential_rejected";
			if ([409, 423].includes(response.status)) return "consumer_unavailable";
			return "unknown";
		} finally {
			void response.body?.cancel().catch(() => {});
		}
	};
}
