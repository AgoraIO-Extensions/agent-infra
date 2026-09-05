import {
	AgentProjectionV1Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentConfigurationScreen } from "./agent-configuration-screen.js";

const agent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);
const ownerSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-owner-1",
		displayName: "Owner",
		roles: ["employee"],
	},
});
const ordinarySession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-ordinary-1",
		displayName: "Ordinary user",
		roles: ["employee"],
	},
});

afterEach(cleanup);

describe("AgentConfigurationScreen", () => {
	it("lets an Owner submit configuration while clearing entered Secret values", () => {
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.getByText("MODEL_API_KEY (set, version 1)")).toBeTruthy();
		expect(screen.queryByText("test-secret-value")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Add Secret" }));
		fireEvent.change(screen.getByLabelText("Secret name"), {
			target: { value: "NEW_SECRET" },
		});
		fireEvent.change(screen.getByLabelText("Secret value"), {
			target: { value: "test-secret-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				schemaVersion: 1,
				secrets: [{ name: "NEW_SECRET", value: "test-secret-value" }],
			}),
		);
		expect(screen.queryByLabelText("Secret value")).toBeNull();
	});

	it("does not render configuration data or controls for an ordinary-user projection", () => {
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ordinarySession }}
				submitting={false}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Configuration is unavailable" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Save configuration" }),
		).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
	});

	it("uses a separate custom image upgrade command", () => {
		const onUpgradeImage = vi.fn();
		const customAgent = AgentProjectionV1Schema.parse({
			...agent,
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/release:1",
				interactionMode: "platform-adapter",
			},
		});
		render(
			<AgentConfigurationScreen
				agent={customAgent}
				onSave={vi.fn()}
				onUpgradeImage={onUpgradeImage}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("New image reference"), {
			target: { value: "registry.example/agents/release:2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Upgrade image" }));
		expect(onUpgradeImage).toHaveBeenCalledWith(
			"registry.example/agents/release:2",
		);
	});

	it("renders projected completion and opaque configuration errors", () => {
		const { rerender } = render(
			<AgentConfigurationScreen
				agent={agent}
				commandResult={{ ...agent, managementStatus: "creating" }}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("status").textContent).toBe(
			"Configuration submitted: Creating.",
		);

		rerender(
			<AgentConfigurationScreen
				agent={agent}
				commandError={Object.assign(new Error("private transport detail"), {
					retryable: false,
				})}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe(
			"Your permission or this Agent changed. Refresh the page.",
		);
		expect(screen.queryByText("private transport detail")).toBeNull();
	});
});
