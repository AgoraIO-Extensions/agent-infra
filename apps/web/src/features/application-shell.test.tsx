import {
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { type ReactNode, StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationShell,
	safeDeploymentUrl,
	useApplicationSession,
} from "./application-shell";
import { useBrowserSession } from "./use-browser-session";

vi.mock("@tanstack/react-router", () => ({
	useLocation: () => "/agents",
	Link: ({ children, to }: { children: ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
}));
beforeEach(() => {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((media: string) => ({
			matches: false,
			media,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	);
});
const clients: QueryClient[] = [];
const identity = (
	userId: string,
	admin = false,
	sessionGeneration?: string,
	connection?: {
		status: "available";
		schemaVersion: 1;
		publicOrigin: string;
		mcpPath: string;
		configFingerprint: string;
	},
) => ({
	kind: "ready",
	session: {
		schemaVersion: 1,
		user: {
			userId,
			displayName: userId,
			roles: admin ? ["employee", "system_admin"] : ["employee"],
		},
	},
	...(connection ? { connection } : {}),
	...(sessionGeneration ? { sessionGeneration } : {}),
});
afterEach(() => {
	cleanup();
	for (const client of clients) client.clear();
	clients.length = 0;
	vi.unstubAllGlobals();
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
		expect(screen.getByRole("link", { name: "创建审批" })).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Agent 管理" }).getAttribute("href"),
		).toBe("/admin/agents");
		for (const name of ["工作区", "我的管理", "系统管理"])
			expect(screen.getByRole("navigation", { name })).toBeTruthy();
		await act(async () => {
			client.setQueryData(["browser-session"], identity("admin", false));
		});
		await waitFor(() =>
			expect(screen.queryByRole("link", { name: "创建审批" })).toBeNull(),
		);
	});
	it("recreates the feature cache when the same user gets a new session", async () => {
		const observed: { user: string; cached: unknown; client: QueryClient }[] =
			[];
		function Probe() {
			const { session } = useApplicationSession();
			const cache = useQueryClient();
			observed.push({
				user: session.user.userId,
				cached: cache.getQueryData(["private"]),
				client: cache,
			});
			return <p>{session.user.userId}</p>;
		}
		const client = setup(identity("owner"), <Probe />);
		await waitFor(() => expect(observed.length).toBeGreaterThan(0));
		const old = observed.at(-1)?.client;
		old?.setQueryData(["private"], "old-session-secret");
		await act(async () => {
			const next = identity("owner");
			next.session.user.displayName = "owner-again";
			client.setQueryData(["browser-session"], next);
		});
		await waitFor(() =>
			expect(
				observed.some(
					(entry) =>
						entry.user === "owner" &&
						entry.client !== old &&
						entry.cached === undefined,
				),
			).toBe(true),
		);
		expect(old?.getQueryData(["private"])).toBeUndefined();
	});
	it("uses the server session generation when the projection is unchanged", async () => {
		const observed: QueryClient[] = [];
		function Probe() {
			observed.push(useQueryClient());
			return <p>受保护内容</p>;
		}
		const client = setup(identity("owner", false, "generation-1"), <Probe />);
		await screen.findByText("受保护内容");
		const old = observed.at(-1);
		old?.setQueryData(["private"], "old-session-secret");
		await act(async () => {
			client.setQueryData(
				["browser-session"],
				identity("owner", false, "generation-2"),
			);
		});
		await waitFor(() =>
			expect(
				observed.some(
					(value) =>
						value !== old && value.getQueryData(["private"]) === undefined,
				),
			).toBe(true),
		);
		expect(old?.getQueryData(["private"])).toBeUndefined();
	});
	it.each([
		{ fromAdmin: true, toAdmin: false },
		{ fromAdmin: false, toAdmin: true },
	])(
		"clears feature cache and drafts when admin changes from $fromAdmin to $toAdmin within one session generation",
		async ({ fromAdmin, toAdmin }) => {
			const observed: { client: QueryClient; identityKey: string }[] = [];
			function Probe() {
				const cache = useQueryClient();
				const { identityKey } = useApplicationSession();
				const [draft, setDraft] = useState("");
				observed.push({ client: cache, identityKey });
				return (
					<input
						aria-label="Private draft"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
				);
			}
			const generation = "g".repeat(43);
			const client = setup(
				identity("same-user", fromAdmin, generation),
				<Probe />,
			);
			const old = observed.at(-1);
			expect(old).toBeDefined();
			old?.client.setQueryData(["private"], "previous-role-cache");
			fireEvent.change(screen.getByLabelText("Private draft"), {
				target: { value: "previous-role-draft" },
			});
			await act(async () => {
				client.setQueryData(
					["browser-session"],
					identity("same-user", toAdmin, generation),
				);
			});
			await waitFor(() => {
				expect(Boolean(screen.queryByRole("link", { name: "创建审批" }))).toBe(
					toAdmin,
				);
			});
			expect(old?.client.getQueryData(["private"])).toBeUndefined();
			expect(observed.at(-1)?.client).not.toBe(old?.client);
			expect(observed.at(-1)?.identityKey).not.toBe(old?.identityKey);
			expect(
				(screen.getByLabelText("Private draft") as HTMLInputElement).value,
			).toBe("");
		},
	);
});
describe("deployment links", () => {
	it("uses the server session capability for the Connection entry", () => {
		setup(
			identity("owner", false, undefined, {
				status: "available",
				schemaVersion: 1,
				publicOrigin: "https://connection.example.test",
				mcpPath: "/mcp",
				configFingerprint: "a".repeat(64),
			}),
		);
		expect(
			screen
				.getByRole("link", { name: /我的 Connection/ })
				.getAttribute("href"),
		).toBe("https://connection.example.test/mcp");
	});

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
