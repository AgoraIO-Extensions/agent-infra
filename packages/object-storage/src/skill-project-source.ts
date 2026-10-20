import {
	SkillPackageAdmissionErrorV1,
	type SkillPackageSourceProofV1,
	type SkillPackageSourceVerifierV1,
} from "./skill-package-admission.js";

// 平台项目来源引用：项目 ID 与正整数内容修订（与 platform-core skillHubProjectSourceVersionV1 一致）。
const projectSourceVersion =
	/^project:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}:r[1-9][0-9]{0,9}$/;

/**
 * 网页编辑 Skill 项目的来源证明（工程 Spec §11.6、§11.6.2）：来源是平台自己的项目内容，
 * 由平台项目供应生成证明，不调用部署的外部来源校验器。只接受 my_library、项目修订引用、
 * 与实际 ZIP 摘要一致的来源摘要且没有审批引用；发布者取供应操作记录的 Owner。
 */
export function createSkillProjectSourceVerifierV1(): SkillPackageSourceVerifierV1 {
	return {
		async verify(input): Promise<SkillPackageSourceProofV1> {
			if (
				input.provider !== "my_library" ||
				input.approvalRef !== null ||
				input.sourceDigest !== input.archiveDigest ||
				!/^[a-f0-9]{64}$/.test(input.sourceDigest) ||
				!projectSourceVersion.test(input.sourceVersion) ||
				typeof input.ownerId !== "string" ||
				input.ownerId.length === 0
			)
				throw new SkillPackageAdmissionErrorV1("source_untrusted");
			return Object.freeze({
				schemaVersion: 1,
				provider: "my_library",
				publisherId: input.ownerId,
				sourceVersion: input.sourceVersion,
				sourceDigest: input.sourceDigest,
				approvalRef: null,
				trustRevision: input.trustRevision,
			});
		},
	};
}
