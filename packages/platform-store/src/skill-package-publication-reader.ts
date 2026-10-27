import { isDeepStrictEqual } from "node:util";
import {
	parseSkillHubIdV1,
	parseSkillHubObjectVersionV1,
	parseSkillHubRegistrationV1,
	parseSkillPackagePublicationStateV1,
	platformIdempotencyV1,
	skillPackagePublicationStagesV1,
} from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { idempotencyRecords, outboxItems } from "./schema-operations.js";
import { skillHubSkills, skillHubVersions } from "./schema-skill-hub.js";

type Reader = Pick<ReturnType<typeof drizzle>, "select">;
/** Called only for a server-authorized binding. It never selects latest or repairs facts. */
export async function readSkillPackagePublicationV1(
	database: Reader,
	input: { skillVersionId: string; packageObjectVersion: string },
) {
	try {
		const id = parseSkillHubIdV1(input.skillVersionId);
		const objectVersion = parseSkillHubObjectVersionV1(
			input.packageObjectVersion,
		);
		const [row] = await database
			.select({ version: skillHubVersions, parent: skillHubSkills })
			.from(skillHubVersions)
			.innerJoin(
				skillHubSkills,
				eq(skillHubSkills.id, skillHubVersions.skillId),
			)
			.where(eq(skillHubVersions.id, id));
		if (
			row?.version.state !== "published" ||
			row.parent.status !== "active" ||
			row.parent.ownerId !== row.version.ownerId ||
			row.version.packageObjectVersion !== objectVersion
		)
			return null;
		const originals = await database
			.select()
			.from(idempotencyRecords)
			.where(
				and(
					eq(idempotencyRecords.scopeType, "skill_package"),
					eq(idempotencyRecords.scopeId, id),
					eq(idempotencyRecords.status, "completed"),
				),
			);
		const objects = await database
			.select()
			.from(outboxItems)
			.where(
				and(
					eq(outboxItems.scopeType, "skill_package"),
					eq(outboxItems.scopeId, id),
					eq(outboxItems.status, "succeeded"),
				),
			);
		if (originals.length !== 1 || objects.length !== 1) return null;
		const original = originals[0];
		const outbox = objects[0];
		if (!original || !outbox) return null;
		if (
			original.commandType !== "skill.package.publish.v1" ||
			outbox.operation !== "skill.package.publish.v1" ||
			original.id !== outbox.id ||
			original.actorId !== row.version.ownerId ||
			!isDeepStrictEqual(original.result, {
				operationId: original.id,
				skillVersionId: id,
			})
		)
			return null;
		const state = parseSkillPackagePublicationStateV1(outbox.payload);
		const s = state.selection;
		if (
			state.operationId !== original.id ||
			state.ownerId !== original.actorId ||
			original.requestDigest !==
				platformIdempotencyV1.canonicalRequestDigest({ ...s })
		)
			return null;
		if (skillPackagePublicationStagesV1.some((stage) => !state.objects[stage]))
			return null;
		const version = parseSkillHubRegistrationV1({
			schemaVersion: 1,
			name: row.parent.name,
			skillId: row.version.skillId,
			skillVersionId: row.version.id,
			visibility: row.version.visibility,
			provider: row.version.provider,
			version: row.version.version,
			packageObjectVersion: row.version.packageObjectVersion,
			packageDigest: row.version.packageDigest,
			manifestDigest: row.version.manifestDigest,
			signatureDigest: row.version.signatureDigest,
			...(Object.hasOwn(s, "organizationId")
				? { organizationId: row.parent.organizationId }
				: {}),
		});
		for (const field of [
			"name",
			"skillId",
			"skillVersionId",
			"visibility",
			"provider",
			"version",
		] as const)
			if (version[field] !== s[field]) return null;
		if (
			Object.hasOwn(s, "organizationId") &&
			s.organizationId !== row.parent.organizationId
		)
			return null;
		if (
			state.objects.zip?.version !== version.packageObjectVersion ||
			state.objects.zip?.sha256 !== version.packageDigest ||
			s.archiveDigest !== version.packageDigest ||
			state.objects.manifest?.sha256 !== version.manifestDigest ||
			state.objects.signature?.sha256 !== version.signatureDigest
		)
			return null;
		return Object.freeze({ state, version, ownerId: state.ownerId });
	} catch {
		return null;
	}
}
