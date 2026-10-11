import { z } from "zod";
import { SkillWorkloadProjectionV1Schema } from "../skill-hub.ts";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** Fixed process environment key carrying the verified Worker projection. */
export const runtimeSkillHubBindingEnvironmentNameV1 =
	"AGENT_INFRA_RUNTIME_SKILL_HUB_BINDING" as const;

export const RuntimeSkillHubBindingV1Schema = z
	.strictObject({
		schemaVersion: z.literal(1),
		agentId: identifier,
		agentVersion: identifier,
		generationId: z.string().regex(/^[a-f0-9]{64}$/),
		projections: z.array(SkillWorkloadProjectionV1Schema).max(32),
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
			new TextEncoder().encode(JSON.stringify(value)).byteLength > 30_000
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["projections"],
				message: "Skill projection metadata is not bounded or unique",
			});
		}
	});

export type RuntimeSkillHubBindingV1 = z.infer<
	typeof RuntimeSkillHubBindingV1Schema
>;
