import type { Hono } from "hono";
import { z } from "zod";
import { HttpProtocolError } from "./common.js";
import type { IdentityAdapter } from "./identity.js";

export type DirectorySearchItem = {
	readonly kind: "user" | "organization";
	readonly canonicalId: string;
	readonly displayName: string;
	readonly email?: string;
	readonly organizationPath?: string;
};

export type DirectoryRouteDependencies = {
	readonly identity: IdentityAdapter;
	readonly search: (input: {
		readonly kind: "user" | "organization";
		readonly query: string;
		readonly ids: readonly string[];
		readonly limit: number;
	}) => Promise<readonly DirectorySearchItem[]>;
};

const querySchema = z.object({
	kind: z.enum(["user", "organization"]),
	q: z.string().trim().max(120).default(""),
	limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function registerDirectoryRoutes(
	app: Hono,
	dependencies: DirectoryRouteDependencies,
) {
	app.get("/api/v2/directory/search", async (context) => {
		const principal = await dependencies.identity.resolve(context.req.raw);
		if (!principal)
			throw new HttpProtocolError(
				"AUTHENTICATION_REQUIRED",
				"directory-search",
			);
		const parsed = querySchema.safeParse({
			kind: context.req.query("kind"),
			q: context.req.query("q") ?? "",
			limit: context.req.query("limit") ?? "20",
		});
		if (!parsed.success)
			throw new HttpProtocolError("INVALID_REQUEST", "directory-search");
		const items = await dependencies.search({
			kind: parsed.data.kind,
			query: parsed.data.q,
			ids: (context.req.query("ids") ?? "")
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean),
			limit: parsed.data.limit,
		});
		return context.json({
			items,
			query: parsed.data.q,
			kind: parsed.data.kind,
		});
	});
}
