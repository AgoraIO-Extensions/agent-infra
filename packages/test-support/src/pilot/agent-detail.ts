export type PilotAgentOwnerStatusV1 =
	| "active"
	| "disabled"
	| "departed"
	| "unavailable";

type PilotAgentV2Like = {
	readonly configuration: {
		readonly owners: readonly {
			readonly userId: string;
			readonly displayName: string;
		}[];
	};
};

export type PilotAgentDetailV1<T extends PilotAgentV2Like> = Omit<
	T,
	"schemaVersion" | "configuration"
> & {
	readonly schemaVersion: 1;
	readonly configuration: Omit<T["configuration"], "owners"> & {
		readonly owners: {
			readonly userId: string;
			readonly displayName: string | null;
			readonly status: PilotAgentOwnerStatusV1;
		}[];
	};
};

/**
 * 由 V2 Agent 投影构造 Agent 详情投影（#2910，getAgentDetailV1）。Owner 默认为 active；
 * statuses 按 userId 覆盖状态，departed 不带显示名。去掉 V2 Owner 的 roles。
 */
export function pilotAgentDetailFromV2<T extends PilotAgentV2Like>(
	agent: T,
	statuses: Readonly<Record<string, PilotAgentOwnerStatusV1>> = {},
): PilotAgentDetailV1<T> {
	// 泛型展开无法静态收窄覆盖后的字段；调用方都会再用正式 Schema 校验结果。
	return {
		...agent,
		schemaVersion: 1,
		configuration: {
			...agent.configuration,
			owners: agent.configuration.owners.map(({ userId, displayName }) => {
				const status = statuses[userId] ?? "active";
				return {
					userId,
					displayName: status === "departed" ? null : displayName,
					status,
				};
			}),
		},
	} as unknown as PilotAgentDetailV1<T>;
}
