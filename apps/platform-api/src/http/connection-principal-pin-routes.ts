import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import type {
	ConnectionPrincipalPinAdministrationUseCaseV1,
	ConnectionPrincipalPinOperatorV1,
	ConnectionPrincipalPinRecordResultV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";
import {
	type IdentityAdapter,
	resolveCurrentMaterialGrantActor,
	resolveIdentity,
} from "./identity.js";

const recordSchema = z
	.object({
		schemaVersion: z.literal(1),
		expectedRuleRevision: z.number().int().safe().min(1),
		reference: z.string().min(1).max(512),
	})
	.strict();
const verificationSchema = recordSchema
	.extend({ result: z.enum(["consistent", "inconsistent"]) })
	.strict();

export interface ConnectionPrincipalPinRouteDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly pins: ConnectionPrincipalPinAdministrationUseCaseV1;
}

const base = "/internal/platform/v1/connection-principal-pins";

function response(result: ConnectionPrincipalPinRecordResultV1) {
	return {
		schemaVersion: 1 as const,
		pinId: result.pinId,
		ruleRevision: result.ruleRevision,
		closedInstallations: result.closedInstallations,
	};
}

/**
 * §13.5.1 exception items 4 and 6: the audited operations entry. Only the
 * Platform browser session is accepted, never a bearer credential; the
 * operator's identity and `system_admin` standing are resolved on the server
 * (§9.1) and re-checked by Core inside the record's transaction. No product
 * UI uses it. Without an approved exception the entry is not assembled.
 */
export function registerConnectionPrincipalPinRoutesV1(
	app: Hono,
	dependencies: ConnectionPrincipalPinRouteDependenciesV1,
): void {
	async function handle(
		context: Context,
		work: (
			operator: ConnectionPrincipalPinOperatorV1,
			metadata: ReturnType<typeof requestMetadata>,
		) => Promise<unknown>,
	): Promise<Response> {
		const metadata = requestMetadata(context.req.raw);
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
		try {
			if (context.req.raw.headers.has("Authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const operator = await resolveCurrentMaterialGrantActor(
				dependencies.identity,
				identity.userId,
				metadata.traceId,
			);
			if (!operator)
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			return context.json(await work(operator, metadata), 200);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			return context.json(protocol.body, protocol.status);
		}
	}

	function pinId(context: Context, traceId: string): string {
		const parsed = OpaqueIdV1Schema.safeParse(context.req.param("pinId"));
		if (!parsed.success)
			throw new HttpProtocolError("INVALID_REQUEST", traceId);
		return parsed.data;
	}

	app.get(base, (context) =>
		handle(context, async (operator, metadata) => {
			const query = new URL(context.req.url).searchParams;
			const userId = OpaqueIdV1Schema.safeParse(query.get("userId"));
			if (
				!userId.success ||
				[...query.keys()].some((key) => key !== "userId") ||
				query.getAll("userId").length !== 1
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const pins = await dependencies.pins.read({
				requestId: metadata.requestId,
				traceId: metadata.traceId,
				operator,
				userId: userId.data,
			});
			return { schemaVersion: 1 as const, pins };
		}),
	);

	app.post(`${base}/:pinId/release`, (context) =>
		handle(context, async (operator, metadata) => {
			const id = pinId(context, metadata.traceId);
			const { value } = await parseJson(
				context.req.raw,
				recordSchema,
				metadata.traceId,
			);
			return response(
				await dependencies.pins.release({
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					operator,
					pinId: id,
					expectedRuleRevision: value.expectedRuleRevision,
					reference: value.reference,
				}),
			);
		}),
	);

	app.post(`${base}/:pinId/verification`, (context) =>
		handle(context, async (operator, metadata) => {
			const id = pinId(context, metadata.traceId);
			const { value } = await parseJson(
				context.req.raw,
				verificationSchema,
				metadata.traceId,
			);
			return response(
				await dependencies.pins.recordVerification({
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					operator,
					pinId: id,
					expectedRuleRevision: value.expectedRuleRevision,
					reference: value.reference,
					result: value.result,
				}),
			);
		}),
	);
}
