import {
	AgentProjectionV1Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBrowserSession } from "../agent-administration/use-browser-session.js";
import { AgentConfigurationWorkflow } from "./agent-configuration-workflow.js";
import { useAgentConfigurationSubmission } from "./use-agent-configuration-submission.js";

vi.mock("../agent-administration/use-browser-session.js", () => ({
	useBrowserSession: vi.fn(),
}));
vi.mock("./use-agent-configuration-submission.js", () => ({
	useAgentConfigurationSubmission: vi.fn(),
}));

const ownerSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-owner-1",
		displayName: "Owner",
		roles: ["employee"],
	},
});
const firstAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);
const secondAgent = AgentProjectionV1Schema.parse({
	...firstAgent,
	agentId: "agent-configuration-2",
	configuration: {
		...firstAgent.configuration,
		availability: [{ kind: "organization", organizationId: "organization-2" }],
		secrets: [],
	},
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

beforeEach(() => {
	vi.mocked(useBrowserSession).mockReturnValue({
		state: { kind: "ready", session: ownerSession },
	} as never);
	vi.mocked(useAgentConfigurationSubmission).mockReturnValue({
		isError: false,
		error: null,
		data: undefined,
		isPending: false,
		saveConfiguration: vi.fn(),
		upgradeImage: vi.fn(),
	} as never);
});

describe("AgentConfigurationWorkflow", () => {
	it("drops an entered Secret when navigation changes the Agent", () => {
		const { rerender } = render(
			<AgentConfigurationWorkflow agent={firstAgent} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add Secret" }));
		fireEvent.change(screen.getByLabelText("Secret name"), {
			target: { value: "NEW_SECRET" },
		});
		fireEvent.change(screen.getByLabelText("Secret value"), {
			target: { value: "typed-secret" },
		});

		rerender(<AgentConfigurationWorkflow agent={secondAgent} />);

		expect(screen.queryByLabelText("Secret value")).toBeNull();
		expect(
			(
				screen.getByLabelText(
					"Organization availability IDs",
				) as HTMLTextAreaElement
			).value,
		).toBe("organization-2");
	});
});
