import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const identifier = z.number().int().positive().safe();
export const RelayAdapterConfig = z.strictObject({
	instanceId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
	origin: z.url().refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && url.origin === value;
	}),
	serviceBearer: z.string().min(16),
	relayReadKey: z.string().min(16),
	// The Relay operator owns these verified enterprise account links and eligible groups.
	accounts: z.record(z.string().min(1), identifier),
	agentGroupIds: z.array(identifier).min(1),
});
const keyRow = z.object({
	id: identifier,
	user_id: identifier,
	status: z.string(),
	group_id: identifier.nullable(),
	group: z.object({ id: identifier, status: z.string() }).nullable().optional(),
	quota: z.number().nonnegative(),
	quota_used: z.number().nonnegative(),
	expires_at: z.iso.datetime({ offset: true }).nullable(),
});
const pageSchema = z.object({
	items: z.array(keyRow).max(100),
	total: z.number().int().nonnegative().max(1000),
});
const hash = (input: string) => createHash("sha256").update(input).digest();
export function createSub2ApiAdapter(
	input: unknown,
	transport: typeof fetch = fetch,
) {
	const config = RelayAdapterConfig.parse(input);
	const manifest = {
		schemaVersion: 1,
		instanceId: config.instanceId,
		capabilities: ["model-authorization"],
	};
	async function read(path: string, signal: AbortSignal, authenticated = true) {
		const response = await transport(new URL(path, config.origin), {
			headers: authenticated
				? { "x-api-key": config.relayReadKey, accept: "application/json" }
				: { accept: "application/json" },
			redirect: "error",
			credentials: "omit",
			signal,
		});
		if (
			!response.ok ||
			!response.body ||
			!response.headers.get("content-type")?.includes("application/json")
		) {
			await response.body?.cancel();
			throw Error();
		}
		const reader = response.body.getReader();
		const bytes: Uint8Array[] = [];
		let length = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.length;
				if (length > 1048576) throw Error();
				bytes.push(value);
			}
		} finally {
			await reader.cancel();
		}
		return z
			.object({ code: z.literal(0), data: z.unknown() })
			.parse(JSON.parse(Buffer.concat(bytes).toString())).data;
	}
	return async (request: Request) => {
		const path = new URL(request.url).pathname;
		const header = request.headers.get("authorization");
		const authenticated =
			header !== null &&
			timingSafeEqual(hash(header), hash(`Bearer ${config.serviceBearer}`));
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(4500)]);
		try {
			if (
				path === "/.well-known/agent-infra-adapter" &&
				request.method === "GET"
			) {
				if (header && !authenticated)
					return new Response(null, { status: 403 });
				z.object({
					version: z.string().min(1),
					site_name: z.string().min(1),
				}).parse(await read("/api/v1/settings/public", signal, false));
				return Response.json(manifest);
			}
			if (path !== "/v1/model-authorizations" || request.method !== "POST")
				return new Response(null, { status: 404 });
			if (!authenticated) return new Response(null, { status: 403 });
			const body = z
				.strictObject({
					schemaVersion: z.literal(1),
					subjectId: z.string().min(1).max(256),
				})
				.safeParse(await request.json());
			if (!body.success) return new Response(null, { status: 400 });
			const subjectId = body.data.subjectId;
			if (!Object.hasOwn(config.accounts, subjectId))
				return new Response(null, { status: 403 });
			const account = config.accounts[subjectId];
			const user = z
				.object({ id: identifier, status: z.literal("active") })
				.parse(await read(`/api/v1/admin/users/${account}`, signal));
			if (user.id !== account) return new Response(null, { status: 403 });
			const keys = new Map<number, { ref: string; displayName: string }>();
			let seen = 0;
			for (let page = 1; page <= 10; page++) {
				const result = pageSchema.parse(
					await read(
						`/api/v1/admin/users/${account}/api-keys?page=${page}&page_size=100&sort_by=id&sort_order=asc`,
						signal,
					),
				);
				for (const key of result.items) {
					if (key.user_id !== account) throw Error();
					if (
						key.status === "active" &&
						key.group_id !== null &&
						config.agentGroupIds.includes(key.group_id) &&
						key.group?.id === key.group_id &&
						key.group.status === "active" &&
						(!key.expires_at || Date.parse(key.expires_at) > Date.now()) &&
						(key.quota === 0 || key.quota_used < key.quota)
					) {
						keys.set(key.id, {
							ref: String(key.id),
							displayName: `Relay 授权 #${key.id}`,
						});
					}
				}
				seen += result.items.length;
				if (seen >= result.total) break;
				if (!result.items.length || page === 10) throw Error();
			}
			const items = [...keys].sort(([a], [b]) => a - b).map(([, item]) => item);
			if (items.length > 256) throw Error();
			return Response.json(
				{ schemaVersion: 1, instanceId: config.instanceId, subjectId, items },
				{ headers: { "cache-control": "no-store" } },
			);
		} catch {
			return new Response(null, { status: 502 });
		}
	};
}
