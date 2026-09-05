import {
	AgentProjectionV1Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pendingApplication } from "../my-agents/test-fixtures.js";
import { AgentLifecycleControls } from "./agent-lifecycle-controls.js";

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
const unavailableAgent = AgentProjectionV1Schema.parse({
	schemaVersion: 1,
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

afterEach(cleanup);

describe("AgentLifecycleControls", () => {
	it("keeps service availability distinct from management status and offers server-permitted Owner controls", () => {
		const onCommand = vi.fn();
		render(
			<AgentLifecycleControls
				agent={unavailableAgent}
				onCommand={onCommand}
				session={{ kind: "ready", session: ownerSession }}
			/>,
		);

		expect(screen.getByText("Available")).toBeTruthy();
		expect(screen.getByText("Unavailable")).toBeTruthy();
		expect(
			screen.getByText(
				"Service is temporarily unavailable. History is read-only until it recovers.",
			),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Restart Agent" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Stop Agent" })).toBeTruthy();
		expect(
			screen.getByText("Lifecycle controls").closest("section")?.className,
		).toContain("sm:flex-row");

		fireEvent.click(screen.getByRole("button", { name: "Restart Agent" }));
		expect(onCommand).toHaveBeenCalledWith("restart");
	});

	it.each(["starting", "updating"] as const)(
		"offers Owner lifecycle commands while service is %s",
		(serviceAvailability) => {
			render(
				<AgentLifecycleControls
					agent={{ ...unavailableAgent, serviceAvailability }}
					onCommand={vi.fn()}
					session={{ kind: "ready", session: ownerSession }}
				/>,
			);

			expect(screen.getByRole("button", { name: "Stop Agent" })).toBeTruthy();
			expect(
				screen.getByRole("button", { name: "Restart Agent" }),
			).toBeTruthy();
		},
	);

	it("uses the server-projected management state to limit Owner and administrator controls", () => {
		const owner = vi.fn();
		const { rerender } = render(
			<AgentLifecycleControls
				agent={{
					...unavailableAgent,
					managementStatus: "stopped",
					serviceAvailability: null,
				}}
				onCommand={owner}
				session={{ kind: "ready", session: ownerSession }}
			/>,
		);

		expect(screen.getByText("Stopped")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Restart Agent" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Stop Agent" })).toBeNull();
		expect(screen.queryByText("Service availability")).toBeNull();

		rerender(
			<AgentLifecycleControls
				agent={{
					...unavailableAgent,
					managementStatus: "creation_failed",
					serviceAvailability: null,
				}}
				onCommand={owner}
				session={{ kind: "ready", session: administratorSession }}
			/>,
		);
		expect(screen.getByText("Creation failed")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Retry creation" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Disable Agent" })).toBeTruthy();

		rerender(
			<AgentLifecycleControls
				agent={{
					...unavailableAgent,
					managementStatus: "disabled",
					serviceAvailability: null,
				}}
				onCommand={owner}
				session={{ kind: "ready", session: ownerSession }}
			/>,
		);
		expect(screen.getByText("Disabled")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("does not infer lifecycle permission for an ordinary-user projection", () => {
		render(
			<AgentLifecycleControls
				agent={unavailableAgent}
				onCommand={vi.fn()}
				session={{ kind: "ready", session: ordinaryUserSession }}
			/>,
		);

		expect(screen.queryByRole("button")).toBeNull();
	});

	it("renders processing and terminal lifecycle feedback for the matching Agent", () => {
		const failedAgent = {
			...unavailableAgent,
			managementStatus: "creation_failed" as const,
			serviceAvailability: null,
		};
		const { rerender } = render(
			<AgentLifecycleControls
				agent={failedAgent}
				onCommand={vi.fn()}
				pendingCommand={{
					agentId: failedAgent.agentId,
					command: "retry_creation",
				}}
				session={{ kind: "ready", session: administratorSession }}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Retrying creation..." }),
		).toBeTruthy();

		rerender(
			<AgentLifecycleControls
				agent={failedAgent}
				commandResult={{
					...failedAgent,
					managementStatus: "creating",
				}}
				onCommand={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe(
			"Lifecycle command submitted: Creating.",
		);

		rerender(
			<AgentLifecycleControls
				agent={failedAgent}
				commandError={Object.assign(new Error(), { retryable: false })}
				onCommand={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"Your permission or this Agent changed. Refresh the page.",
		);
	});
});
