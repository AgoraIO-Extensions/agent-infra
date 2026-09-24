import { createHash } from "node:crypto";
import type { AuthenticatedConnectionContext } from "./tokens.js";

export interface CatalogActionVersion {
	id: string;
	actionId: string;
	version: string;
	effect: "read" | "write";
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	requiredScopes: readonly string[];
	status: "published" | "disabled";
}

export interface CatalogProvider {
	id: string;
	name: string;
	status: "active" | "disabled";
}

export interface CatalogEntry {
	provider: CatalogProvider;
	actionVersion: CatalogActionVersion;
}

export interface CatalogReader {
	list(
		context: AuthenticatedConnectionContext,
	): Promise<readonly CatalogEntry[]>;
}

export function catalogEtag(entries: readonly CatalogEntry[]): string {
	const canonical = JSON.stringify(entries);
	return `"${createHash("sha256").update(canonical).digest("hex")}"`;
}
