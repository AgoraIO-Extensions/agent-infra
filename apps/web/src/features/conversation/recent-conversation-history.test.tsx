import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as v2 } from "../../pilot/generated-v2/client.gen.js";
import { deferred, history } from "./conversation-test-fixtures.js";
import { RecentConversationHistory } from "./recent-conversation-history.js";

const originalV2 = v2.getConfig();
const queries: QueryClient[] = [];

afterEach(() => {
	cleanup();
	for (const query of queries.splice(0)) query.clear();
	v2.setConfig(originalV2);
});

const item = (conversationId: string, agentId = "agent-1") => ({
	...history(conversationId).conversation,
	agentId,
	title: `最近对话 ${conversationId}`,
});

function setup(
	handler: (request: Request) => Response | Promise<Response>,
	identityKey = "login-a",
) {
	const requests: Request[] = [];
	v2.setConfig({
		baseUrl: "https://platform.example.test",
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requests.push(request.clone());
			return handler(request);
		},
	});
	const queryClient = new QueryClient();
	queries.push(queryClient);
	const onSelect = vi.fn();
	const view = (key: string) => (
		<QueryClientProvider client={queryClient}>
			<RecentConversationHistory
				agentId="agent-1"
				conversationId="first-1"
				identityKey={key}
				onSelect={onSelect}
			/>
		</QueryClientProvider>
	);
	const result = render(view(identityKey));
	return {
		...result,
		requests,
		onSelect,
		rerenderIdentity: (key: string) => result.rerender(view(key)),
	};
}

const region = () => screen.getByRole("region", { name: "最近对话" });
const titles = () =>
	within(region())
		.queryAllByRole("link")
		.map((link) => link.querySelector("strong")?.textContent);

describe("RecentConversationHistory continuation", () => {
	it("reads 50 per page and appends the continuation from the opaque cursor", async () => {
		const { requests } = setup((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			return Response.json(
				cursor === "opaque-next/+?="
					? { items: [item("later-1", "agent-2")], nextCursor: null }
					: {
							items: [item("first-1"), item("first-2", "agent-2")],
							nextCursor: "opaque-next/+?=",
						},
			);
		});
		await waitFor(() =>
			expect(titles()).toEqual(["最近对话 first-1", "最近对话 first-2"]),
		);
		fireEvent.click(screen.getByRole("button", { name: "加载更多对话" }));
		await waitFor(() =>
			expect(titles()).toEqual([
				"最近对话 first-1",
				"最近对话 first-2",
				"最近对话 later-1",
			]),
		);
		expect(screen.queryByRole("button", { name: "加载更多对话" })).toBeNull();
		expect(
			requests.map((request) => {
				const url = new URL(request.url);
				return [
					request.method,
					url.searchParams.get("limit"),
					url.searchParams.get("cursor"),
				];
			}),
		).toEqual([
			["GET", "50", null],
			["GET", "50", "opaque-next/+?="],
		]);
	});

	it.each([
		[503, "最近对话暂时无法读取。", true],
		[401, "最近对话无法读取，请重新登录。", false],
		[403, "当前无权读取最近对话。", false],
	] as const)(
		"hides loaded rows when the continuation fails with %s and retries from a new first page",
		async (status, message, retryable) => {
			let failing = false;
			let recovered = false;
			const { requests } = setup((request) => {
				const cursor = new URL(request.url).searchParams.get("cursor");
				if (cursor && failing)
					return Response.json({ message: "controlled" }, { status });
				return Response.json(
					recovered
						? { items: [item("fresh-1")], nextCursor: null }
						: { items: [item("first-1")], nextCursor: "opaque-next/+?=" },
				);
			});
			await waitFor(() => expect(titles()).toEqual(["最近对话 first-1"]));
			failing = true;
			fireEvent.click(screen.getByRole("button", { name: "加载更多对话" }));
			await screen.findByText(message);
			expect(titles()).toEqual([]);
			expect(screen.queryByRole("button", { name: "加载更多对话" })).toBeNull();
			if (!retryable) {
				expect(within(region()).queryAllByRole("button")).toHaveLength(0);
				return;
			}
			recovered = true;
			fireEvent.click(screen.getByRole("button", { name: "重试读取最近对话" }));
			await waitFor(() => expect(titles()).toEqual(["最近对话 fresh-1"]));
			// 重试从新的首页开始，不复用失败的续页 cursor。
			expect(
				new URL(requests.at(-1)?.url ?? "").searchParams.get("cursor"),
			).toBe(null);
		},
	);

	it("drops a held continuation and its cursor when the login identity changes", async () => {
		const held = deferred<Response>();
		const { requests, rerenderIdentity } = setup((request) => {
			const url = new URL(request.url);
			if (url.searchParams.get("cursor")) return held.promise;
			return Response.json(
				requests.length > 2
					? { items: [item("new-identity")], nextCursor: null }
					: { items: [item("old-identity")], nextCursor: "old-cursor/+?=" },
			);
		});
		await waitFor(() => expect(titles()).toEqual(["最近对话 old-identity"]));
		fireEvent.click(screen.getByRole("button", { name: "加载更多对话" }));
		await waitFor(() => expect(requests).toHaveLength(2));
		const continuation = requests[1];
		rerenderIdentity("login-b");
		await waitFor(() => expect(titles()).toEqual(["最近对话 new-identity"]));
		await act(async () => {
			held.resolve(
				Response.json({ items: [item("old-late")], nextCursor: "late/+?=" }),
			);
		});
		expect(continuation?.signal.aborted).toBe(true);
		expect(titles()).toEqual(["最近对话 new-identity"]);
		expect(screen.queryByRole("button", { name: "加载更多对话" })).toBeNull();
		expect(
			requests
				.slice(2)
				.map((request) => new URL(request.url).searchParams.get("cursor")),
		).toEqual([null]);
	});
});
