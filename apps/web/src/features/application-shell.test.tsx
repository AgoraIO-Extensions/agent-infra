import {
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBrowserSession } from "./agent-administration/use-browser-session";
import {
	ApplicationShell,
	safeDeploymentUrl,
	useApplicationSession,
} from "./application-shell";

vi.mock("@tanstack/react-router", () => ({
	useLocation: () => "/agents",
	Link: ({ children, to }: { children: ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
}));
const clients: QueryClient[] = [];
const identity = (userId: string, admin = false) => ({
	kind: "ready",
	session: {
		schemaVersion: 1,
		user: {
			userId,
			displayName: userId,
			roles: admin ? ["employee", "system_admin"] : ["employee"],
		},
	},
});
afterEach(() => {
	cleanup();
	for (const client of clients) client.clear();
	clients.length = 0;
});
function setup(initial: unknown, children: ReactNode = <p>受保护内容</p>) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	clients.push(client);
	client.setQueryData(["browser-session"], initial);
	render(
		<StrictMode>
			<QueryClientProvider client={client}>
				<ApplicationShell>{children}</ApplicationShell>
			</QueryClientProvider>
		</StrictMode>,
	);
	return client;
}
describe("application session boundary", () => {
	it("gates all protected content when anonymous and removes it on logout", async () => {
		const client = setup({ kind: "unavailable", retryable: false });
		expect(screen.queryByText("受保护内容")).toBeNull();
		expect(screen.getByRole("heading", { name: "登录工作空间" })).toBeTruthy();
		await act(async () => {
			client.setQueryData(["browser-session"], identity("owner"));
		});
		await screen.findByText("受保护内容");
		await act(async () => {
			client.setQueryData(["browser-session"], {
				kind: "unavailable",
				retryable: false,
			});
		});
		await waitFor(() => expect(screen.queryByText("受保护内容")).toBeNull());
	});
	it("uses a fresh feature cache for another user while sharing the authoritative session", async () => {
		const observed: { user: string; cached: unknown; client: QueryClient }[] =
			[];
		function Probe() {
			const { session } = useApplicationSession();
			const cache = useQueryClient();
			const nested = useBrowserSession();
			observed.push({
				user: session.user.userId,
				cached: cache.getQueryData(["private"]),
				client: cache,
			});
			return (
				<p>
					{nested.state.kind === "ready"
						? `nested-${nested.state.session.user.userId}`
						: "no-session"}
				</p>
			);
		}
		const client = setup(identity("owner"), <Probe />);
		await screen.findByText("nested-owner");
		const old = observed[0]?.client;
		old?.setQueryData(["private"], "owner-secret");
		await act(async () => {
			client.setQueryData(["browser-session"], identity("admin", true));
		});
		await screen.findByText("nested-admin");
		expect(
			observed
				.filter((entry) => entry.user === "admin")
				.every((entry) => entry.cached === undefined && entry.client !== old),
		).toBe(true);
		expect(old?.getQueryData(["private"])).toBeUndefined();
		expect(screen.getByRole("link", { name: "审批" })).toBeTruthy();
		await act(async () => {
			client.setQueryData(["browser-session"], identity("admin", false));
		});
		await waitFor(() =>
			expect(screen.queryByRole("link", { name: "审批" })).toBeNull(),
		);
	});
});
describe("deployment links", () => {
	it("accepts configured HTTPS or local paths and rejects executable or ambiguous URLs", () => {
		expect(safeDeploymentUrl("/__local/login")).toBe("/__local/login");
		expect(safeDeploymentUrl("https://identity.example.test/login")).toBe(
			"https://identity.example.test/login",
		);
		for (const value of [
			"//evil.test",
			"javascript:alert(1)",
			"https://user:password@example.test",
			"http://example.test",
			" /login",
			"/\\evil.test",
		])
			expect(safeDeploymentUrl(value)).toBeUndefined();
	});
});
