import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentConfigurationScreen } from "./agent-configuration-screen.js";
import { ConfigurationTestProviders } from "./test-router-context.js";

afterEach(cleanup);

it("keeps selection and names in the draft, saves the source, and unbinds through the next configuration", () => {
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		source: {
			kind: "custom",
			imageReference: "registry.example/agent:1",
			interactionMode: "self-managed",
			identityResponsibility: "self-managed",
		},
	});
	const session = BrowserSessionProjectionV1Schema.parse({
		schemaVersion: 1,
		user: { userId: "user-owner-1", displayName: "Owner", roles: ["employee"] },
	});
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	queryClient.setQueryData(["workspace-snapshots", "user-owner-1"], {
		kind: "ready",
		snapshots: [
			{
				snapshotId: "snap-1",
				digest: `sha256:${"a".repeat(64)}`,
				sizeBytes: 12,
				unpackedSizeBytes: 20,
				fileCount: 1,
				mediaType: "application/x-tar+gzip",
				source: { kind: "direct-upload" },
				createdAt: "2026-11-02T00:00:00.000Z",
				status: "ready",
				bindings: [],
			},
		],
	});
	const onSave = vi.fn();
	const props = {
		agent,
		session: { kind: "ready" as const, session },
		submitting: false,
		onSave,
		onUpgradeImage: vi.fn(),
	};
	const view = render(
		<ConfigurationTestProviders queryClient={queryClient}>
			<AgentConfigurationScreen {...props} />
		</ConfigurationTestProviders>,
	);
	const checkbox = () =>
		screen.getByRole("checkbox", { name: "选择快照 snap-1" });
	fireEvent.click(checkbox());
	expect(checkbox().getAttribute("aria-checked")).toBe("true");
	fireEvent.change(screen.getByLabelText("快照挂载名称 snap-1"), {
		target: { value: "venv" },
	});
	expect(onSave).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
	expect(onSave).toHaveBeenLastCalledWith(
		expect.objectContaining({
			source: {
				...agent.source,
				workspaceSnapshots: [{ snapshotId: "snap-1", name: "venv" }],
			},
		}),
	);
	const saved = AgentProjectionV2Schema.parse({
		...agent,
		source: {
			...agent.source,
			workspaceSnapshots: [{ snapshotId: "snap-1", name: "venv" }],
		},
	});
	view.rerender(
		<ConfigurationTestProviders queryClient={queryClient}>
			<AgentConfigurationScreen
				{...props}
				agent={saved}
				commandResult={saved}
			/>
		</ConfigurationTestProviders>,
	);
	fireEvent.click(checkbox());
	expect(checkbox().getAttribute("aria-checked")).toBe("false");
	fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
	expect(onSave).toHaveBeenLastCalledWith(
		expect.objectContaining({
			source: { ...agent.source, workspaceSnapshots: [] },
		}),
	);
	expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
});
