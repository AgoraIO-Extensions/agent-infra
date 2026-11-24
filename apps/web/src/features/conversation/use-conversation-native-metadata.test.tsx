import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import {
	filterConversationCapabilities,
	prepareCapabilityInvocation,
} from "./conversation-capability-picker.js";
import {
	nativeMetadataCapabilities,
	useConversationNativeMetadata,
} from "./use-conversation-native-metadata.js";

const clients: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
});

describe("conversation native metadata consumer", () => {
	it("maps the authenticated Skill selector to picker capabilities", async () => {
		const requests: Request[] = [];
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				return Response.json({
					selector: "skills",
					revision: "a".repeat(64),
					capabilities: [
						{
							id: "b".repeat(64),
							kind: "skill",
							name: "workspace-summary",
							description: "Summarize files",
							source: { name: "skillhub", version: "1.0.0" },
							availability: "discovered",
						},
					],
				});
			},
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		clients.push(queryClient);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() =>
				useConversationNativeMetadata({
					identityKey: "login-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					client,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.available).toBe(true));
		expect(result.current.capabilities).toEqual([
			expect.objectContaining({
				kind: "skill",
				name: "workspace-summary",
				source: "skillhub",
			}),
		]);
		expect(new URL(requests[0].url).search).toBe("?selector=skills");
		expect(nativeMetadataCapabilities(undefined)).toEqual([]);
	});

	it("shows the original command hint without constructing an invocation", () => {
		const rows = nativeMetadataCapabilities({
			schemaVersion: 1,
			selector: "commands",
			projectionVersion: 2,
			revision: "a".repeat(64),
			capabilities: [],
			discoveredCommands: [
				{
					name: "compact",
					description: "Compact",
					argumentHint: "[instructions]",
				},
			],
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			name: "compact",
			argumentHint: "[instructions]",
			discoveryOnly: true,
		});
		expect(prepareCapabilityInvocation(rows[0]!, "notes")).toHaveProperty(
			"error",
		);
		expect(rows[0]).not.toHaveProperty("identity");
	});

	it("searches a full SDK directory alongside installed Skills", () => {
		const commands = Array.from({ length: 128 }, (_, i) => ({
			kind: "command" as const,
			name: "cmd" + i,
			description: "",
			source: "Pi",
			discoveryOnly: true as const,
		}));
		const skills = Array.from({ length: 23 }, (_, i) => ({
			kind: "skill" as const,
			name: "skill" + i,
			description: "",
			source: "hub",
		}));
		expect(
			filterConversationCapabilities([...commands, ...skills], "skill22"),
		).toEqual([skills[22]]);
	});

	it.each([false, true])(
		"preserves state-changing command metadata across API rollback (%s)",
		async (legacy) => {
			const requests: Request[] = [];
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async (input, init) => {
					requests.push(new Request(input, init));
					if (
						legacy &&
						new URL(requests.at(-1)!.url).searchParams.has(
							"includeDiscoveredCommands",
						)
					)
						return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
					return Response.json({
						schemaVersion: 1,
						projectionVersion: 2,
						selector: "commands",
						revision: "a".repeat(64),
						capabilities: [
							{
								schemaVersion: 2,
								id: "b".repeat(64),
								kind: "command",
								name: "compact",
								description: "Compact the native session",
								source: { name: "codex", version: "0.153.0" },
								parameters: [],
								effect: "state_changing",
								availability: "available",
							},
						],
					});
				},
			});
			const queryClient = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			clients.push(queryClient);
			const wrapper = ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
			);
			const { result } = renderHook(
				() =>
					useConversationNativeMetadata({
						identityKey: "login-a",
						conversationId: "conversation-a",
						executionId: "execution-a",
						selector: "commands",
						projectionVersion: 2,
						client,
					}),
				{ wrapper },
			);
			await waitFor(() => expect(result.current.available).toBe(true));
			expect(new URL(requests[0].url).search).toBe(
				"?selector=commands&projectionVersion=2&includeDiscoveredCommands=true",
			);
			expect(requests).toHaveLength(legacy ? 2 : 1);
			if (legacy)
				expect(new URL(requests[1].url).search).toBe(
					"?selector=commands&projectionVersion=2",
				);
			expect(result.current.capabilities[0]).toMatchObject({
				name: "compact",
				effect: "state_changing",
			});
		},
	);

	it("stays unavailable when there is no execution or the API refuses the read", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		clients.push(queryClient);
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () => new Response(null, { status: 503 }),
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() =>
				useConversationNativeMetadata({
					identityKey: "login-a",
					conversationId: "conversation-a",
					client,
				}),
			{ wrapper },
		);
		expect(result.current.available).toBe(false);
		expect(result.current.capabilities).toEqual([]);
	});

	it("does not request native metadata when the Agent capability is absent", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		clients.push(queryClient);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() =>
				useConversationNativeMetadata({
					identityKey: "login-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					enabled: false,
				}),
			{ wrapper },
		);
		expect(result.current.available).toBe(false);
		expect(result.current.capabilities).toEqual([]);
	});

	it("hides cached metadata when the Agent capability is disabled", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		clients.push(queryClient);
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () =>
				Response.json({
					selector: "skills",
					revision: "a".repeat(64),
					capabilities: [
						{
							id: "b".repeat(64),
							kind: "skill",
							name: "workspace-summary",
							description: "Summarize files",
							source: { name: "skillhub", version: "1.0.0" },
							availability: "discovered",
						},
					],
				}),
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) =>
				useConversationNativeMetadata({
					identityKey: "login-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					enabled,
					client,
				}),
			{ initialProps: { enabled: true }, wrapper },
		);
		await waitFor(() => expect(result.current.available).toBe(true));
		rerender({ enabled: false });
		expect(result.current.available).toBe(false);
		expect(result.current.capabilities).toEqual([]);
	});

	it.each([
		{},
		{
			selector: "commands",
			revision: "a".repeat(64),
			capabilities: [],
		},
	])("rejects malformed or mismatched projections: %j", async (payload) => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		clients.push(queryClient);
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () => Response.json(payload),
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() =>
				useConversationNativeMetadata({
					identityKey: "login-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					client,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.available).toBe(false);
		expect(result.current.capabilities).toEqual([]);
	});

	it("clears a successful projection after a failed refetch", async () => {
		let calls = 0;
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		clients.push(queryClient);
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () => {
				calls += 1;
				if (calls > 1) return new Response(null, { status: 403 });
				return Response.json({
					selector: "skills",
					revision: "a".repeat(64),
					capabilities: [],
				});
			},
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() =>
				useConversationNativeMetadata({
					identityKey: "login-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					client,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.available).toBe(true));
		await result.current.refetch();
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.available).toBe(false);
		expect(result.current.capabilities).toEqual([]);
	});

	it("keeps a read projection when a background reread is temporarily unavailable (#3387)", async () => {
		let calls = 0;
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		clients.push(queryClient);
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () => {
				calls += 1;
				if (calls > 1) return new Response(null, { status: 503 });
				return Response.json({
					selector: "skills",
					revision: "a".repeat(64),
					capabilities: [],
				});
			},
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() =>
				useConversationNativeMetadata({
					identityKey: "login-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					client,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.available).toBe(true));
		await result.current.refetch();
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.available).toBe(true);
	});
});
