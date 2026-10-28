import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import { ApplicationCredentialList } from "./application-credential-list.js";

const metadata = {
	applicationId: "app-1",
	credentialId: "credential-1",
	scopes: ["agent:read"],
	expiresAt: null,
	revokedAt: null as string | null,
	createdAt: "2026-10-20T00:00:00Z",
	lastUsedAt: null,
};
afterEach(cleanup);
function setup(failure: "none" | "write" | "read" = "none") {
	let revoked = false;
	let writes = 0;
	let reads = 0;
	let failedRead = false;
	const fetcher = vi.fn(async (input: Request) => {
		if (input.method === "DELETE") {
			writes += 1;
			expect(input.url).toContain("/app-1/credentials/credential-1");
			expect(input.headers.get("Idempotency-Key")).toBeTruthy();
			revoked = true;
			if (failure === "write") throw new TypeError("lost response");
			return Response.json({
				metadata: { ...metadata, revokedAt: "2026-10-28T00:00:00Z" },
				replayed: false,
			});
		}
		reads += 1;
		if (failure === "read" && revoked && !failedRead) {
			failedRead = true;
			return Response.json({}, { status: 503 });
		}
		return Response.json({
			items: [
				{ ...metadata, revokedAt: revoked ? "2026-10-28T00:00:00Z" : null },
			],
			nextCursor: null,
		});
	});
	const client = createClient({
		baseUrl: "https://platform.test",
		fetch: fetcher,
	});
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	function mount() {
		return render(
			<QueryClientProvider client={queryClient}>
				<ApplicationCredentialList applicationId="app-1" client={client} />
			</QueryClientProvider>,
		);
	}
	return { mount, writes: () => writes, reads: () => reads };
}
it("reloads persisted metadata on mount and remount, confirms the selected credential and refreshes success", async () => {
	const task = setup();
	const first = task.mount();
	await screen.findByText("credential-1");
	first.unmount();
	task.mount();
	await screen.findByText("credential-1");
	expect(task.reads()).toBe(2);
	fireEvent.click(
		screen.getByRole("button", { name: "撤销应用凭证 credential-1" }),
	);
	const dialog = await screen.findByRole("dialog");
	expect(within(dialog).getByText("credential-1")).toBeTruthy();
	expect(task.writes()).toBe(0);
	fireEvent.click(within(dialog).getByRole("button", { name: "撤销凭证" }));
	await screen.findByText("已撤销");
	expect(task.writes()).toBe(1);
	expect(task.reads()).toBe(3);
});
it.each(["write", "read"] as const)(
	"requires metadata readback after %s failure and never retries a write automatically",
	async (failure) => {
		const task = setup(failure);
		task.mount();
		fireEvent.click(
			await screen.findByRole("button", { name: "撤销应用凭证 credential-1" }),
		);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "撤销凭证" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("重新加载"),
		);
		expect(task.writes()).toBe(1);
		fireEvent.click(screen.getByRole("button", { name: "重新加载凭证" }));
		await screen.findByText("已撤销");
		expect(task.writes()).toBe(1);
		expect(screen.queryByRole("alert")).toBeNull();
	},
);
