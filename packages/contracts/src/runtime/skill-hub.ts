import { z } from "zod";
import {
	SkillHubSyncBindingV1Schema,
	SkillWorkloadProjectionV1Schema,
} from "../skill-hub.ts";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** Fixed process environment key carrying the verified Worker projection. */
export const runtimeSkillHubBindingEnvironmentNameV1 =
	"AGENT_INFRA_RUNTIME_SKILL_HUB_BINDING" as const;

export const RuntimeSkillHubBindingV1Schema = z
	.strictObject({
		schemaVersion: z.literal(1),
		agentId: identifier,
		agentVersion: identifier,
		configurationRevision: z.number().int().positive(),
		generationId: z.string().regex(/^[a-f0-9]{64}$/),
		projections: z.array(SkillWorkloadProjectionV1Schema).max(32),
		appliedBindings: z.array(SkillHubSyncBindingV1Schema).max(32),
	})
	.superRefine((value, context) => {
		if (
			value.projections.some(
				(projection) =>
					projection.agentId !== value.agentId ||
					projection.agentVersion !== value.agentVersion,
			)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["projections"],
				message: "Skill projections must share the binding identity",
			});
		}
		if (
			new Set(value.projections.map((projection) => projection.targetPath))
				.size !== value.projections.length ||
			new Set(
				value.appliedBindings.map(
					(binding) => binding.skillVersion.skillVersionId,
				),
			).size !== value.appliedBindings.length ||
			new TextEncoder().encode(JSON.stringify(value)).byteLength > 30_000
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["projections"],
				message: "Skill projection metadata is not bounded or unique",
			});
		}
		if (
			value.appliedBindings.some(
				(binding) =>
					binding.state !== "synced" ||
					binding.agentId !== value.agentId ||
					binding.agentVersion !== value.agentVersion ||
					binding.configurationRevision !== value.configurationRevision ||
					binding.appliedReceipt.generationId !== value.generationId,
			)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["appliedBindings"],
				message: "Applied Skill bindings must match the current generation",
			});
		}
		if (
			value.projections.length !== value.appliedBindings.length ||
			value.projections.some((projection) => {
				const binding = value.appliedBindings.find(
					(candidate) =>
						candidate.skillVersion.skillVersionId ===
						projection.skillVersion.skillVersionId,
				);
				return (
					binding === undefined ||
					binding.skillName !== projection.manifest.name ||
					binding.grant.tools.length !== projection.grant.tools.length ||
					JSON.stringify(binding.grant) !== JSON.stringify(projection.grant)
				);
			})
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["projections"],
				message: "Applied Skill bindings must cover each projection",
			});
		}
	});

export type RuntimeSkillHubBindingV1 = z.infer<
	typeof RuntimeSkillHubBindingV1Schema
>;
