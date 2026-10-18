import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AvailabilityNameList,
	type DirectoryNames,
	formatOrganization,
	formatPerson,
	useAvailabilityNames,
	useDirectoryNames,
} from "./directory-names.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function namedDirectory(delay?: Promise<void>) {
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(String(input), "http://localhost");
		const ids = url.searchParams.get("ids")?.split(",") ?? [];
		await delay;
		return Response.json({
			items: ids
				.filter((id) => !id.endsWith("-missing"))
				.map((id) => ({
					kind: url.searchParams.get("kind"),
					canonicalId: id,
					displayName: `Name ${id}`,
					email: `${id}@example.test`,
				})),
		});
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

function Names({
	ids,
	onNames,
}: {
	ids: readonly string[];
	onNames?: (names: DirectoryNames) => void;
}) {
	const names = useDirectoryNames("user", ids);
	onNames?.(names);
	return (
		<ul data-status={names.status}>
			{[...new Set(ids)].map((id) => (
				<li key={id}>{names.resolve(id).name}</li>
			))}
		</ul>
	);
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useDirectoryNames", () => {
	it("batches one page of IDs and reuses the cached set", async () => {
		const fetch = namedDirectory();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const ids = Array.from({ length: 120 }, (_, index) => `user-${index}`);
		const view = render(<Names ids={ids} />, { wrapper: wrapper(client) });
		expect(await screen.findByText("Name user-119")).toBeTruthy();
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(
			fetch.mock.calls.map(
				([url]) =>
					new URL(String(url), "http://localhost").searchParams
						.get("ids")
						?.split(",").length,
			),
		).toEqual([50, 50, 20]);
		view.unmount();
		// 同一集合（顺序不同、含重复）再次读取时命中缓存，不再请求。
		render(<Names ids={[...ids].reverse().concat("user-0")} />, {
			wrapper: wrapper(client),
		});
		expect(await screen.findByText("Name user-0")).toBeTruthy();
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("resolves missing records as unresolved without exposing the ID", async () => {
		namedDirectory();
		let latest: DirectoryNames | undefined;
		render(
			<Names
				ids={["user-a", "user-b-missing"]}
				onNames={(names) => {
					latest = names;
				}}
			/>,
			{ wrapper: wrapper(new QueryClient()) },
		);
		await waitFor(() => expect(latest?.status).toBe("ready"));
		expect(latest?.resolve("user-a")).toEqual({
			id: "user-a",
			name: "Name user-a",
			secondary: "user-a@example.test",
			resolved: true,
		});
		expect(latest?.resolve("user-b-missing")).toEqual({
			id: "user-b-missing",
			name: "未识别的用户",
			secondary: "",
			resolved: false,
		});
		expect(document.body.textContent).not.toContain("user-b-missing");
	});

	it("keeps displayed names while refetching in the background", async () => {
		namedDirectory();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(<Names ids={["user-a"]} />, { wrapper: wrapper(client) });
		expect(await screen.findByText("Name user-a")).toBeTruthy();
		let release = () => {};
		const fetch = namedDirectory(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		void client.invalidateQueries({ queryKey: ["directory-names"] });
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		expect(screen.getByText("Name user-a")).toBeTruthy();
		expect(screen.queryByRole("status")).toBeNull();
		release();
		await waitFor(() =>
			expect(client.isFetching({ queryKey: ["directory-names"] })).toBe(0),
		);
		expect(screen.getByText("Name user-a")).toBeTruthy();
	});
});

it("keeps names and shows no failure when a background refetch fails", async () => {
	namedDirectory();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	let latest: DirectoryNames | undefined;
	render(
		<Names
			ids={["user-a"]}
			onNames={(names) => {
				latest = names;
			}}
		/>,
		{ wrapper: wrapper(client) },
	);
	expect(await screen.findByText("Name user-a")).toBeTruthy();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 503 })),
	);
	await client.refetchQueries({ queryKey: ["directory-names"] });
	expect(screen.getByText("Name user-a")).toBeTruthy();
	expect(latest?.status).toBe("ready");
});

it("formats people and organizations without falling back to IDs", () => {
	expect(
		formatPerson({ displayName: "林默", email: "lin@example.test" }),
	).toEqual({ name: "林默", secondary: "lin@example.test" });
	expect(formatPerson({ displayName: " ", email: "lin@example.test" })).toEqual(
		{ name: "lin@example.test", secondary: "" },
	);
	expect(formatPerson({})).toEqual({ name: "未识别的用户", secondary: "" });
	expect(
		formatOrganization({ name: "平台工程", path: "研发 / 平台工程" }),
	).toEqual({ name: "平台工程", secondary: "研发 / 平台工程" });
	expect(formatOrganization({ name: null })).toEqual({
		name: "未识别的组织",
		secondary: "",
	});
});

it("lists every availability target by name instead of a count", async () => {
	namedDirectory();
	const targets = [
		{ kind: "user", userId: "user-a" },
		{ kind: "user", userId: "user-b" },
		{ kind: "organization", organizationId: "org-c" },
	] as const;
	function Scope() {
		const names = useAvailabilityNames(targets);
		return (
			<AvailabilityNameList
				targets={targets}
				names={names}
				layout="list"
				empty="未额外指定"
			/>
		);
	}
	render(<Scope />, { wrapper: wrapper(new QueryClient()) });
	expect(await screen.findByText("Name org-c")).toBeTruthy();
	expect(
		screen.getAllByRole("listitem").map((item) => item.textContent),
	).toEqual([
		"Name user-auser-a@example.test",
		"Name user-buser-b@example.test",
		"Name org-c",
	]);
	expect(document.body.textContent).not.toMatch(/\d+ 个范围|\d+ 名员工/);
});
