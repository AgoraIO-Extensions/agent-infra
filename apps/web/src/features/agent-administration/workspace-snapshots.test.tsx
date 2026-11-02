import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	loadWorkspaceSnapshots,
	WorkspaceSnapshotsPanel,
} from "./workspace-snapshots.js";

const snapshot = {
	snapshotId: "snap-1",
	digest: `sha256:${"a".repeat(64)}`,
	sizeBytes: 12,
	unpackedSizeBytes: 20,
	fileCount: 1,
	mediaType: "application/x-tar+gzip" as const,
	source: { kind: "direct-upload" as const },
	createdAt: "2026-11-02T00:00:00.000Z",
	status: "ready" as const,
	bindings: [],
};

describe("workspace snapshots panel", () => {
	it("does not offer snapshots for standard templates", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceSnapshotsPanel identityKey="u1" sourceKind="standard" />
			</QueryClientProvider>,
		);
		expect(screen.getByText("标准模板不支持工作区快照。"));
	});

	it("renders metadata without exposing archive content", async () => {
		const client = {} as never;
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(["workspace-snapshots", "u1"], {
			kind: "ready",
			snapshots: [snapshot],
		});
		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceSnapshotsPanel
					identityKey="u1"
					sourceKind="custom"
					client={client}
				/>
			</QueryClientProvider>,
		);
		expect(screen.getByText(/sha256:aaaa/)).toBeTruthy();
		expect(screen.queryByText(/archive|repo content/i)).toBeNull();
	});

	it("maps non-200 list responses to unavailable", async () => {
		const list = vi.fn().mockResolvedValue({
			response: { status: 403 },
			error: { retryable: false },
		});
		const result = await loadWorkspaceSnapshots({ get: list } as never);
		expect(result).toEqual({ kind: "unavailable", retryable: false });
	});
});
