import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBrowserSession } from "../agent-administration/use-browser-session.js";
import { AgentConfigurationWorkflow } from "./agent-configuration-workflow.js";
import { useAgentConfigurationSubmission } from "./use-agent-configuration-submission.js";

vi.mock("../agent-administration/use-browser-session.js", () => ({
	useBrowserSession: vi.fn(),
}));
vi.mock("../agent-administration/use-agent-lifecycle-command.js", () => ({
	useAgentLifecycleCommand: () => ({ mutate: vi.fn(), isPending: false }),
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
const firstAgent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const secondAgent = AgentProjectionV2Schema.parse({
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
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		fireEvent.change(screen.getByLabelText("Secret 名称"), {
			target: { value: "NEW_SECRET" },
		});
		fireEvent.change(screen.getByLabelText("新 Secret 值"), {
			target: { value: "typed-secret" },
		});

		rerender(<AgentConfigurationWorkflow agent={secondAgent} />);

		expect(screen.queryByLabelText("新 Secret 值")).toBeNull();
		expect(
			(screen.getByLabelText("可用组织 ID") as HTMLTextAreaElement).value,
		).toBe("organization-2");
	});
});
