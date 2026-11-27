import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	ExternalRuntimeDirectory,
	ExternalServiceId,
	externalServiceOrigin,
} from "@agent-infra/contracts/pilot";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

const id = z.string().min(1).max(256);
const file = z.string().refine(isAbsolute);
const origin = z.string().transform(externalServiceOrigin);
const credential = z.string().regex(/^[\x21-\x7e]{16,8192}$/);
const configuration = z.strictObject({
	instanceId: ExternalServiceId,
	origin,
	workerTokenFile: file,
	accounts: z
		.array(z.strictObject({ subjectId: id, userId: id, grantFile: file }))
		.refine(
			(accounts) =>
				new Set(accounts.map((account) => account.subjectId)).size ===
					accounts.length &&
				new Set(accounts.map((account) => account.userId)).size ===
					accounts.length,
		),
});
const grant = z.strictObject({ origin, accessToken: credential });
const query = z.strictObject({ schemaVersion: z.literal(1), subjectId: id });
const account = z.object({ userId: id, disabled: z.boolean() });
const connectors = z.object({
	connectors: z
		.array(
			z.object({
				id: id.regex(/^[a-zA-Z0-9_-]+$/),
				userId: id,
				name: z.string(),
				status: z.enum(["online", "offline"]),
			}),
		)
		.max(256),
});
const inventory = z.object({
	connectorId: id,
	runtimes: z
		.array(
			z.object({
				connectorId: id,
				runtimeId: id,
				name: z.string(),
				present: z.boolean(),
				configured: z.boolean(),
				active: z.boolean(),
				available: z.boolean(),
				status: z.string(),
			}),
		)
		.max(128),
});
const digest = (value: string) => createHash("sha256").update(value).digest();
class AccountDenied extends Error {}

export function createAgentsAnywhereAdapter(
	configPath: string,
	transport: typeof fetch = fetch,
) {
	const app = new Hono<{
		Variables: { config: z.infer<typeof configuration> };
	}>();
	app.onError((error, c) =>
		error instanceof AccountDenied
			? c.json({ error: "forbidden" }, 403)
			: c.json({ error: "provider_unavailable" }, 503),
	);
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		const config = configuration.parse(
			JSON.parse(await readFile(configPath, "utf8")),
		);
		const token = credential.parse(
			(await readFile(config.workerTokenFile, "utf8")).trim(),
		);
		if (
			!timingSafeEqual(
				digest(c.req.header("authorization") ?? ""),
				digest(`Bearer ${token}`),
			)
		)
			return c.json({ error: "unauthorized" }, 401);
		c.set("config", config);
		await next();
	});
	app.get("/.well-known/agent-infra-adapter", (c) =>
		c.json({
			schemaVersion: 1,
			instanceId: c.var.config.instanceId,
			capabilities: ["discovery"],
		}),
	);
	app.use("/v1/resources/query", bodyLimit({ maxSize: 4096 }));
	app.post("/v1/resources/query", async (c) => {
		const input = query.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return c.json({ error: "invalid_request" }, 400);
		const { subjectId } = input.data;
		const config = c.var.config;
		const directory: z.infer<typeof ExternalRuntimeDirectory> = {
			schemaVersion: 1,
			instanceId: config.instanceId,
			subjectId,
			devices: [],
		};
		const link = config.accounts.find((item) => item.subjectId === subjectId);
		if (!link) return c.json(directory);
		const auth = grant.parse(
			JSON.parse(await readFile(link.grantFile, "utf8")),
		);
		if (auth.origin !== config.origin) throw new AccountDenied();
		const signal = AbortSignal.any([
			c.req.raw.signal,
			AbortSignal.timeout(4500),
		]);
		async function read(path: string): Promise<unknown> {
			const res = await transport(new URL(`/api/v2${path}`, config.origin), {
				headers: {
					authorization: `Bearer ${auth.accessToken}`,
					accept: "application/json",
				},
				redirect: "error",
				credentials: "omit",
				signal,
			});
			if (
				!res.ok ||
				res.redirected ||
				!/^application\/json\b/i.test(res.headers.get("content-type") ?? "")
			) {
				await res.body?.cancel();
				if (res.status === 401 || res.status === 403) throw new AccountDenied();
				throw Error("Directory unavailable");
			}
			return res.json();
		}
		const me = account.parse(await read("/auth/me"));
		if (me.disabled || me.userId !== link.userId) throw new AccountDenied();
		const devices = connectors.parse(await read("/connectors")).connectors;
		if (devices.some((device) => device.userId !== me.userId))
			throw new AccountDenied();
		for (let offset = 0; offset < devices.length; offset += 8) {
			const batch = await Promise.all(
				devices.slice(offset, offset + 8).map(async (device) => {
					const list = inventory.parse(
						await read(`/connectors/${encodeURIComponent(device.id)}/runtimes`),
					);
					if (
						list.connectorId !== device.id ||
						list.runtimes.some((runtime) => runtime.connectorId !== device.id)
					)
						throw new AccountDenied();
					return {
						ref: device.id,
						displayName: device.name,
						status: device.status,
						runtimes: list.runtimes.map((runtime) => {
							const executable =
								runtime.present && runtime.active && runtime.configured;
							let status: "available" | "unavailable" | "unknown" =
								"unavailable";
							if (device.status === "online" && executable) {
								if (runtime.status === "running" && runtime.available)
									status = "available";
								else if (
									["unknown", "starting", "discovering", "validating"].includes(
										runtime.status,
									)
								)
									status = "unknown";
							}
							return {
								ref: runtime.runtimeId,
								displayName: runtime.name,
								status,
								capabilities: executable ? ["execute" as const] : [],
							};
						}),
					};
				}),
			);
			directory.devices.push(...batch);
		}
		return c.json(ExternalRuntimeDirectory.parse(directory));
	});
	return app;
}
