import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import { pendingApplication } from "../my-agents/test-fixtures.js";
import {
	confirmationCopy,
	visibleLifecycleCommands,
} from "./agent-lifecycle-commands.js";

const ownerSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-owner-1",
		displayName: "Owner",
		roles: ["employee"],
	},
});
const administratorSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-admin-1",
		displayName: "Administrator",
		roles: ["employee", "system_admin"],
	},
});
const ordinaryUserSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-employee-1",
		displayName: "Employee",
		roles: ["employee"],
	},
});
const agent = AgentProjectionV2Schema.parse({
	schemaVersion: 2,
	agentId: "agent-pilot-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	managementStatus: "available",
	serviceAvailability: "unavailable",
	configuration: {
		...pendingApplication.configuration,
		owners: [ownerSession.user],
	},
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
});

const ready = (session: typeof ownerSession) =>
	({ kind: "ready", session }) as const;

describe("visibleLifecycleCommands", () => {
	it.each(["unavailable", "starting", "updating", "ready"] as const)(
		"offers stop and restart to the Owner of an available Agent whose service is %s",
		(serviceAvailability) => {
			expect(
				visibleLifecycleCommands(
					{ ...agent, serviceAvailability },
					ready(ownerSession),
				),
			).toEqual(["stop", "restart"]);
		},
	);

	it("follows the server-projected management state for the Owner and administrator", () => {
		const stopped = {
			...agent,
			managementStatus: "stopped" as const,
			serviceAvailability: null,
		};
		const failed = {
			...agent,
			managementStatus: "creation_failed" as const,
			serviceAvailability: null,
		};
		const disabled = {
			...agent,
			managementStatus: "disabled" as const,
			serviceAvailability: null,
		};
		expect(visibleLifecycleCommands(stopped, ready(ownerSession))).toEqual([
			"restart",
		]);
		expect(visibleLifecycleCommands(failed, ready(ownerSession))).toEqual([
			"retry_creation",
		]);
		expect(
			visibleLifecycleCommands(failed, ready(administratorSession)),
		).toEqual(["retry_creation", "disable"]);
		expect(
			visibleLifecycleCommands(agent, ready(administratorSession)),
		).toEqual(["disable"]);
		expect(visibleLifecycleCommands(disabled, ready(ownerSession))).toEqual([]);
		expect(
			visibleLifecycleCommands(disabled, ready(administratorSession)),
		).toEqual([]);
	});

	it("does not infer lifecycle permission for an ordinary user or an unresolved session", () => {
		expect(visibleLifecycleCommands(agent, ready(ordinaryUserSession))).toEqual(
			[],
		);
		expect(visibleLifecycleCommands(agent, { kind: "loading" })).toEqual([]);
	});
});

describe("confirmationCopy", () => {
	it("spaces a Latin Agent name in the restart title and keeps Han names joined", () => {
		expect(confirmationCopy.restart.title("Release assistant")).toBe(
			"重启 Release assistant？",
		);
		expect(confirmationCopy.restart.title("3 号助手")).toBe("重启 3 号助手？");
		expect(confirmationCopy.restart.title("发布助理")).toBe("重启发布助理？");
	});
});
