import { ApiIdentityError } from "./api-identity-management.js";

export interface PlatformUserGovernanceStoreV1 {
	setPlatformDisabled(input: {
		readonly actorUserId: string;
		readonly targetUserId: string;
		readonly disabled: boolean;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<boolean>;
	recordRejected(input: {
		readonly actorUserId: string | null;
		readonly targetUserId: string | null;
		readonly traceId: string;
		readonly requestId: string;
		readonly reason: string;
		readonly outcome: "rejected" | "failed";
	}): Promise<void>;
}

export interface PlatformUserGovernanceUseCaseV1 {
	assertAdministrator(actorRoles: readonly string[]): void;
	setPlatformDisabled(input: {
		readonly actorUserId: string;
		readonly actorRoles: readonly string[];
		readonly targetUserId: string;
		readonly disabled: boolean;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<void>;
	recordRejected: PlatformUserGovernanceStoreV1["recordRejected"];
}

export function createPlatformUserGovernanceUseCaseV1(
	store: PlatformUserGovernanceStoreV1,
): PlatformUserGovernanceUseCaseV1 {
	const assertAdministrator = (actorRoles: readonly string[]) => {
		if (!actorRoles.includes("system_admin"))
			throw new ApiIdentityError("not_authorized");
	};
	return {
		assertAdministrator,
		async setPlatformDisabled(input) {
			assertAdministrator(input.actorRoles);
			await store.setPlatformDisabled({
				actorUserId: input.actorUserId,
				targetUserId: input.targetUserId,
				disabled: input.disabled,
				traceId: input.traceId,
				requestId: input.requestId,
			});
		},
		recordRejected: (input) => store.recordRejected(input),
	};
}
