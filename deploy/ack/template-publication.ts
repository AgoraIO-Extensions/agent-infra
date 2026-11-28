import { pathToFileURL } from "node:url";
import {
	StandardTemplateReleaseApplyResponseV1Schema,
	StandardTemplateRegistrationResponseV1Schema,
	TemplatePublicationStatusV1Schema,
	standardTemplateRegistrationActions,
} from "../../packages/contracts/dist/pilot/index.mjs";

export interface TemplatePublicationOperatorV1 {
	readonly publicationId: string;
	readonly origin: string;
	/** Deployment-fixed Agent for all single-Agent commands. */
	readonly agentId?: string;
	/** Configuration CAS in the approved target, required by apply and result. */
	readonly expectedConfigurationRevision?: number;
	/** Actual current administrator transport for prepare/revoke; never a claimed actor field. */
	readonly administratorRequest: (request: Request) => Promise<Response>;
	/** Signed dedicated service transport for activate/read. */
	readonly serviceRequest: (request: Request) => Promise<Response>;
}

export async function runTemplatePublicationOperatorV1(
	command: string,
	input: TemplatePublicationOperatorV1,
) {
	try {
		const scoped = standardTemplateRegistrationActions.find(
			(action) => action === command,
		);
		const revisionCommand = command === "apply" || command === "result";
		const expected = input.expectedConfigurationRevision;
		if ((scoped || revisionCommand) && !input.agentId)
			throw new Error("TEMPLATE_PUBLICATION_OPERATOR_INVALID");
		if (
			revisionCommand &&
			(expected === undefined ||
				!Number.isSafeInteger(expected) ||
				expected < 1 ||
				expected >= Number.MAX_SAFE_INTEGER)
		)
			throw new Error("TEMPLATE_PUBLICATION_OPERATOR_INVALID");
		const commands = {
			prepare: "prepare-automatic",
			activate: "activate-automatic",
			revoke: "revoke-automatic",
			status: "status-automatic",
		} as const;
		if (
			(!scoped && !revisionCommand && !Object.hasOwn(commands, command)) ||
			input.publicationId === "." ||
			input.publicationId === ".." ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(input.publicationId)
		)
			throw new Error("TEMPLATE_PUBLICATION_OPERATOR_INVALID");
		const origin = new URL(input.origin);
		if (
			origin.protocol !== "https:" ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash
		)
			throw new Error("TEMPLATE_PUBLICATION_OPERATOR_INVALID");
		const read = command === "status";
		const headers: Record<string, string> = read
			? {}
			: { "content-type": "application/json" };
		if (scoped || revisionCommand)
			headers["Idempotency-Key"] = input.publicationId;
		const action = revisionCommand
			? command
			: (scoped ?? commands[command as keyof typeof commands]);
		const response = await (command === "activate"
			? input.serviceRequest
			: input.administratorRequest)(
			new Request(
				new URL(
					`/internal/ops/standard-template-releases/${input.publicationId}/${action}`,
					origin,
				),
				{
					method: read ? "GET" : "POST",
					headers,
					body: read ? undefined : JSON.stringify({ schemaVersion: 1 }),
					redirect: "error",
					signal: AbortSignal.timeout(30_000),
				},
			),
		);
		if (
			response.status !==
			(read || scoped === "registration" || command === "result" ? 200 : 202)
		)
			throw new Error("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE");
		const reader = response.body?.getReader();
		if (!reader) throw new Error();
		const chunks: Uint8Array[] = [];
		let length = 0;
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.length;
			if (length > 1_048_576) {
				await reader.cancel();
				throw new Error();
			}
			chunks.push(part.value);
		}
		const text = Buffer.concat(chunks).toString("utf8");
		const payload = JSON.parse(text);
		if (revisionCommand && expected !== undefined) {
			const result =
				StandardTemplateReleaseApplyResponseV1Schema.parse(payload);
			if (
				result.agentId !== input.agentId ||
				result.configurationRevision !== expected + 1
			)
				throw new Error("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE");
			return result;
		}
		if (scoped) {
			const registration =
				StandardTemplateRegistrationResponseV1Schema.parse(payload);
			if (
				registration.releaseId !== input.publicationId ||
				registration.agentId !== input.agentId ||
				(scoped === "register" && registration.state !== "registered") ||
				(scoped === "revoke-registration" && registration.state !== "revoked")
			)
				throw new Error();
			return registration;
		}
		const result = TemplatePublicationStatusV1Schema.parse(payload);
		if (result.publicationId !== input.publicationId)
			throw new Error("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE");
		return {
			schemaVersion: 1,
			publicationId: result.publicationId,
			status: result.status,
			counts: result.counts,
		};
	} catch {
		throw new Error("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE");
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const source = process.env.PLATFORM_TEMPLATE_PUBLICATION_MODULE;
		if (!source || new URL(source).protocol !== "file:") throw new Error();
		const configured = await import(source);
		process.stdout.write(
			`${JSON.stringify(await runTemplatePublicationOperatorV1(process.argv[2] ?? "", configured.publication))}\n`,
		);
	} catch {
		process.stderr.write("TEMPLATE_PUBLICATION_OPERATOR_UNAVAILABLE\n");
		process.exitCode = 1;
	}
}
