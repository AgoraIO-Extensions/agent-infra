/** Internal Bridge/Driver seam; this module is not part of the package surface. */
export const codexSkillLaunch = Symbol("codexSkillLaunch");

export interface CodexSkillLaunchProvenance {
	readonly transport: object;
	readonly processId: string;
	readonly cwd: string;
	readonly conversationKey: string;
	readonly bundledSkillsDisabled: boolean;
}
