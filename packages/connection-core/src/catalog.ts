import { createHash } from "node:crypto";
import { canonicalJson } from "./calls.js";

export interface CatalogActionState {
	providerId: string;
	providerStatus: string;
	releaseStatus: string;
	actionId: string;
	actionVersion: string;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	effect: string;
	requiredScopes: readonly string[];
	status: string;
}

export function projectDirectCatalog(
	rows: readonly CatalogActionState[],
	grantedScopes: readonly string[],
) {
	const allowedScopes = new Set(grantedScopes);
	const actions = rows
		.filter(
			(row) =>
				row.providerStatus === "active" &&
				row.releaseStatus === "active" &&
				row.status === "published" &&
				row.requiredScopes.every((scope) => allowedScopes.has(scope)),
		)
		.map((row) => {
			if (row.effect !== "read" && row.effect !== "write")
				throw new Error("Catalog action effect is invalid");
			return {
				providerId: row.providerId,
				actionId: row.actionId,
				actionVersion: row.actionVersion,
				inputSchema: row.inputSchema,
				outputSchema: row.outputSchema,
				effect: row.effect === "read" ? ("READ" as const) : ("WRITE" as const),
				requiredScopes: [...row.requiredScopes].sort(),
				status: "published" as const,
			};
		})
		.sort((left, right) => {
			const a = [left.providerId, left.actionId, left.actionVersion].join(
				"\u0000",
			);
			const b = [right.providerId, right.actionId, right.actionVersion].join(
				"\u0000",
			);
			return a < b ? -1 : a > b ? 1 : 0;
		});
	return {
		schemaVersion: 1 as const,
		catalogVersion: `sha256:${createHash("sha256").update(canonicalJson(actions)).digest("hex")}`,
		actions,
	};
}
