import { describe, expect, it, vi } from "vitest";

import { ApiIdentityError } from "./api-identity-management.js";
import { createPlatformUserGovernanceUseCaseV1 } from "./platform-user-governance.js";

const command = {
	actorUserId: "administrator",
	actorRoles: ["system_admin"],
	targetUserId: "target",
	disabled: true,
	traceId: "trace",
	requestId: "request",
};

describe("Platform user governance", () => {
	it("requires administrator authority before reaching the Store", async () => {
		const setPlatformDisabled = vi.fn(async () => true);
		const governance = createPlatformUserGovernanceUseCaseV1({
			setPlatformDisabled,
			recordRejected: vi.fn(async () => {}),
		});
		expect(() => governance.assertAdministrator(["employee"])).toThrow(
			ApiIdentityError,
		);
		await expect(
			governance.setPlatformDisabled({ ...command, actorRoles: ["employee"] }),
		).rejects.toMatchObject({
			name: "ApiIdentityError",
			code: "not_authorized",
		});
		expect(setPlatformDisabled).not.toHaveBeenCalled();
		await governance.setPlatformDisabled(command);
		expect(setPlatformDisabled).toHaveBeenCalledWith({
			actorUserId: command.actorUserId,
			targetUserId: command.targetUserId,
			disabled: true,
			traceId: command.traceId,
			requestId: command.requestId,
		});
	});

	it("preserves the Store's current-authority rejection", async () => {
		const governance = createPlatformUserGovernanceUseCaseV1({
			setPlatformDisabled: async () => {
				throw new ApiIdentityError("not_authorized");
			},
			recordRejected: async () => {},
		});
		await expect(governance.setPlatformDisabled(command)).rejects.toMatchObject(
			{
				code: "not_authorized",
			},
		);
	});
});
