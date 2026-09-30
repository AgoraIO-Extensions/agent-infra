import { describe, expect, it, vi } from "vitest";

import { ApiIdentityError } from "./api-identity-management.js";
import {
	createPlatformUserGovernanceUseCaseV1,
	requireCurrentPlatformUserGovernanceV1,
} from "./platform-user-governance.js";

const command = {
	actorUserId: "administrator",
	actorRoles: ["system_admin"],
	targetUserId: "target",
	disabled: true,
	traceId: "trace",
	requestId: "request",
};

describe("Platform user governance", () => {
	it("rechecks current administrator authority and LDAP enable-target status", () => {
		const current = {
			actorUserId: "administrator",
			targetUserId: "target",
			disabled: true,
			actorPlatformDisabled: false,
			actor: {
				userId: "administrator",
				accountStatus: "active" as const,
				roles: ["system_admin" as const],
			},
			target: null,
		};
		expect(() => requireCurrentPlatformUserGovernanceV1(current)).not.toThrow();
		for (const changed of [
			{ actorPlatformDisabled: true },
			{ actor: null },
			{ actor: { ...current.actor, userId: "another-user" } },
			{ actor: { ...current.actor, accountStatus: "disabled" as const } },
			{ actor: { ...current.actor, roles: ["employee" as const] } },
		])
			expect(() =>
				requireCurrentPlatformUserGovernanceV1({ ...current, ...changed }),
			).toThrow(expect.objectContaining({ code: "not_authorized" }));
		const enabling = { ...current, disabled: false };
		for (const target of [
			null,
			{ userId: "target", accountStatus: "disabled" as const, roles: [] },
			{ userId: "another-user", accountStatus: "active" as const, roles: [] },
		])
			expect(() =>
				requireCurrentPlatformUserGovernanceV1({ ...enabling, target }),
			).toThrow(expect.objectContaining({ code: "resource_unavailable" }));
		expect(() =>
			requireCurrentPlatformUserGovernanceV1({
				...enabling,
				target: { userId: "target", accountStatus: "active", roles: [] },
			}),
		).not.toThrow();
	});
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
