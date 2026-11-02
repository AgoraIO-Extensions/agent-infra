import { describe, expect, it, vi } from "vitest";
import { createWorkspaceSnapshotCredentialResolverV1 } from "./workspace-snapshot-credential-resolver.js";

describe("workspace snapshot credential resolver", () => {
	it("uses the existing personal credential authority for user principals", async () => {
		const readIdentity = vi.fn().mockResolvedValue({
			principal: { kind: "user", id: "user-1" },
			scopes: ["agent:create", "agent:read"],
		});
		const personalApiAgentRead = { readIdentity } as never;
		const resolver = createWorkspaceSnapshotCredentialResolverV1({
			personalApiAgentRead,
		});
		expect(await resolver.resolve("papi_valid")).toEqual({
			kind: "user",
			id: "user-1",
			scopes: ["agent:create", "agent:read"],
		});
		expect(readIdentity).toHaveBeenCalledOnce();
	});

	it("fails closed for application or invalid credentials", async () => {
		const readIdentity = vi.fn().mockResolvedValue({
			principal: { kind: "application", id: "app-1" },
			scopes: ["agent:create"],
		});
		const personalApiAgentRead = { readIdentity } as never;
		const resolver = createWorkspaceSnapshotCredentialResolverV1({
			personalApiAgentRead,
		});
		expect(await resolver.resolve("papi_application")).toBeNull();
		readIdentity.mockRejectedValueOnce(new Error("invalid"));
		expect(await resolver.resolve("bad")).toBeNull();
	});
});
