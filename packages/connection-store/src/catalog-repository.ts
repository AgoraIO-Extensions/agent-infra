import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ConnectionDatabase } from "./database.js";
import {
	actionVersions,
	auditEvents,
	providerReleases,
	providers,
} from "./schema.js";

export function createConnectionCatalogRepository(db: ConnectionDatabase) {
	return {
		async list() {
			return db
				.select({
					providerId: providers.id,
					providerStatus: providers.status,
					releaseStatus: providerReleases.status,
					actionId: actionVersions.actionId,
					actionVersion: actionVersions.version,
					inputSchema: actionVersions.inputSchema,
					outputSchema: actionVersions.outputSchema,
					effect: actionVersions.effect,
					requiredScopes: actionVersions.requiredScopes,
					status: actionVersions.status,
				})
				.from(actionVersions)
				.innerJoin(providers, eq(actionVersions.providerId, providers.id))
				.innerJoin(
					providerReleases,
					eq(actionVersions.providerReleaseId, providerReleases.id),
				);
		},
		async auditRead(
			binding: {
				principalId: string;
				consumerInstanceId: string;
				actorId: string | null;
			},
			catalogVersion: string,
			actionCount: number,
		) {
			await db.insert(auditEvents).values({
				id: randomUUID(),
				traceId: randomUUID(),
				principalId: binding.principalId,
				consumerInstanceId: binding.consumerInstanceId,
				actorId: binding.actorId,
				action: "catalog.read",
				targetType: "catalog",
				targetId: catalogVersion,
				outcome: "succeeded",
				metadata: { actionCount },
			});
		},
	};
}
