import type { Client } from "../../pilot/generated-v2/client/index.js";
import {
	associateAgentConnectionV2,
	disconnectAgentConnectionV2,
	getAgentConnectionAssociationV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import type { GetAgentConnectionAssociationV2Responses } from "../../pilot/generated-v2/types.gen.js";

export type AgentConnectionAssociationState =
	GetAgentConnectionAssociationV2Responses[200];

/** Stable failure reason from the server code and message; never carries the credential. */
export type ConnectionAssociationFailure =
	| "credential_rejected"
	| "consumer_unavailable"
	| "already_associated"
	| "conflict"
	| "automatic_unavailable"
	| "verification_unavailable"
	| "not_found"
	| "unavailable";

export class ConnectionAssociationRequestError extends Error {
	constructor(readonly reason: ConnectionAssociationFailure) {
		super("Connection association request failed");
		this.name = "ConnectionAssociationRequestError";
	}
}

function failure(
	status: number | undefined,
	error: { code?: string; message?: string } | undefined,
): ConnectionAssociationRequestError {
	const code = error?.code;
	const message = error?.message ?? "";
	if (code === "PROVIDER_REJECTED")
		return new ConnectionAssociationRequestError("credential_rejected");
	if (code === "ACTION_UNAVAILABLE")
		return new ConnectionAssociationRequestError(
			message.includes("Automatic")
				? "automatic_unavailable"
				: "consumer_unavailable",
		);
	if (code === "CONNECTION_UNAVAILABLE")
		return new ConnectionAssociationRequestError("verification_unavailable");
	if (status === 409)
		return new ConnectionAssociationRequestError(
			message.includes("already associated")
				? "already_associated"
				: "conflict",
		);
	if (status === 404 || status === 403)
		return new ConnectionAssociationRequestError("not_found");
	return new ConnectionAssociationRequestError("unavailable");
}

export async function loadAgentConnectionAssociation(
	agentId: string,
	client?: Client,
): Promise<AgentConnectionAssociationState> {
	const result = await getAgentConnectionAssociationV2<false>({
		client,
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw failure(result.response?.status, result.error);
	return result.data;
}

/** The credential is passed straight to the request body; nothing is cached or persisted. */
export async function associateAgentConnection(
	agentId: string,
	input: {
		readonly connectionAgentId: string;
		readonly serviceCredential: string;
		readonly expectedRevision: number | null;
	},
	client?: Client,
): Promise<AgentConnectionAssociationState> {
	const result = await associateAgentConnectionV2<false>({
		client,
		path: { agentId },
		body: { schemaVersion: 1, mode: "manual", ...input },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw failure(result.response?.status, result.error);
	return result.data;
}

export async function enableAgentConnectionRegistration(
	agentId: string,
	client?: Client,
): Promise<AgentConnectionAssociationState> {
	const result = await associateAgentConnectionV2<false>({
		client,
		path: { agentId },
		body: { schemaVersion: 1, mode: "automatic" },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw failure(result.response?.status, result.error);
	return result.data;
}

export async function disconnectAgentConnection(
	agentId: string,
	expectedRevision: number,
	client?: Client,
): Promise<AgentConnectionAssociationState> {
	const result = await disconnectAgentConnectionV2<false>({
		client,
		path: { agentId },
		body: { schemaVersion: 1, expectedRevision },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw failure(result.response?.status, result.error);
	return result.data;
}
