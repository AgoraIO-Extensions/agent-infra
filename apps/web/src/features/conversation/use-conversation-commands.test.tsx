import {
	CommandAcceptedProjectionV1Schema,
	ConversationProjectionV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated/client/index.js";
import { useConversationCommands } from "./use-conversation-commands.js";

const target = {
	identityKey: "user-a",
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: undefined as string | undefined,
};
const timestamp = "2026-09-15T10:00:00Z";
function conversation() {
	return ConversationProjectionV1Schema.parse({
		schemaVersion: 1,
		agentId: "agent-a",
		conversationId: "conversation-a",
		title: "Synthetic private title",
		status: "ready",
		selectedModelOptionId: null,
		selectedReasoningLevel: null,
		lastConversationCursor: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
}

const clients: QueryClient[] = [];
function setup(handler: (request: Request) => Response | Promise<Response>) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: 3 } },
	});
	clients.push(queryClient);
	const requests: Request[] = [];
	const client = createClient({
		baseUrl: "https://platform.example.test",
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requests.push(request.clone());
			return handler(request);
		},
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return {
		...renderHook((props) => useConversationCommands({ ...props, client }), {
			initialProps: target,
			wrapper,
		}),
		requests,
		queryClient,
	};
}

afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
});

describe("Conversation commands through the generated client", () => {
	it("treats a success body under an undocumented HTTP status as uncertain", async () => {
		const { result } = setup(() =>
			Response.json(conversation(), { status: 200 }),
		);
		act(() => {
			result.current.create();
		});
		await waitFor(() =>
			expect(result.current.result).toEqual({ kind: "unknown" }),
		);
	});
	it("rejects an invalid local command before calling the transport", async () => {
		const { result, requests } = setup(() => {
			throw new Error("No transport expected");
		});
		act(() => {
			result.current.submitText("");
		});
		await waitFor(() =>
			expect(result.current.result).toEqual({
				kind: "rejected",
				code: "INVALID_REQUEST",
				retryable: false,
			}),
		);
		act(() => {
			result.current.stop();
		});
		await waitFor(() => expect(result.current.isPending).toBe(false));
		expect(requests).toHaveLength(0);
	});

	it.each(["agent", "conversation", "execution", "schema"] as const)(
		"keeps a mismatched %s receipt uncertain without publishing foreign data",
		async (wrong) => {
			const { result, requests, rerender } = setup(() => {
				const data =
					wrong === "execution"
						? CommandAcceptedProjectionV1Schema.parse({
								schemaVersion: 1,
								status: "submitted",
								messageId: null,
								executionId: "foreign-execution",
							})
						: wrong === "schema"
							? { private: "untrusted payload" }
							: ConversationProjectionV1Schema.parse({
									...conversation(),
									...(wrong === "agent"
										? { agentId: "foreign-agent" }
										: { conversationId: "foreign-conversation" }),
								});
				return Response.json(data, {
					status: wrong === "execution" ? 202 : wrong === "agent" ? 201 : 200,
				});
			});
			if (wrong === "execution")
				rerender({ ...target, executionId: "execution-a" });
			act(() => {
				if (wrong === "agent") result.current.create();
				else if (wrong === "execution") result.current.stop();
				else
					result.current.selectModel({
						modelOptionId: "option-a",
						reasoningLevel: "high",
					});
			});
			await waitFor(() =>
				expect(result.current.result).toEqual({ kind: "unknown" }),
			);
			expect(JSON.stringify(result.current.result)).not.toContain("foreign");
			act(() => {
				expect(result.current.create()).toBe(false);
			});
			expect(requests).toHaveLength(1);
		},
	);

	it("preserves an already-finished stop receipt without guessing the execution outcome", async () => {
		const receipt = CommandAcceptedProjectionV1Schema.parse({
			schemaVersion: 1,
			executionId: "execution-a",
			messageId: null,
			status: "already_finished",
		});
		const { result, rerender } = setup(() =>
			Response.json(receipt, { status: 202 }),
		);
		rerender({ ...target, executionId: "execution-a" });
		act(() => {
			result.current.stop();
		});
		await waitFor(() =>
			expect(result.current.result).toEqual({ kind: "accepted", receipt }),
		);
	});
	it("accepts an explicit authorization-revoked signal while a response is in flight", async () => {
		const pending = Promise.withResolvers<Response>();
		const { result, requests } = setup(() => pending.promise);
		act(() => {
			result.current.submitText("Revoked private input");
		});
		await waitFor(() => expect(requests).toHaveLength(1));
		act(() => {
			result.current.revoke();
		});
		expect(result.current.result).toBeUndefined();
		await waitFor(() => expect(result.current.isDenied).toBe(true));
		expect(requests[0].signal.aborted).toBe(true);
		await act(async () =>
			pending.resolve(
				Response.json(
					CommandAcceptedProjectionV1Schema.parse({
						schemaVersion: 1,
						executionId: "revoked-execution",
						messageId: "revoked-message",
						status: "submitted",
					}),
					{ status: 202 },
				),
			),
		);
		expect(result.current.result).toBeUndefined();
		act(() => {
			expect(result.current.retry()).toBe(false);
			expect(result.current.create()).toBe(false);
		});
		expect(requests).toHaveLength(1);
	});
	it.each(["identityKey", "agentId", "conversationId"] as const)(
		"discards old receipts and retry data after changing %s",
		async (field) => {
			const pending = Promise.withResolvers<Response>();
			const { result, rerender, requests } = setup(() => pending.promise);
			const oldCommands = result.current;
			act(() => {
				result.current.submitText("Old private input");
			});
			await waitFor(() => expect(requests).toHaveLength(1));
			rerender({ ...target, [field]: `${field}-other` });
			expect(result.current.result).toBeUndefined();
			expect(requests[0].signal.aborted).toBe(true);
			act(() => {
				expect(oldCommands.retry()).toBe(false);
				expect(oldCommands.create()).toBe(false);
				expect(result.current.retry()).toBe(false);
			});
			await act(async () =>
				pending.resolve(
					Response.json(
						CommandAcceptedProjectionV1Schema.parse({
							schemaVersion: 1,
							executionId: "old-execution",
							messageId: "old-message",
							status: "submitted",
						}),
						{ status: 202 },
					),
				),
			);
			expect(result.current.result).toBeUndefined();
			expect(requests).toHaveLength(1);
		},
	);
	it("preserves a pending and then unknown message when the execution selection changes in the same conversation", async () => {
		const pending = Promise.withResolvers<Response>();
		let calls = 0;
		const receipt = CommandAcceptedProjectionV1Schema.parse({
			schemaVersion: 1,
			executionId: "execution-a",
			messageId: "message-a",
			status: "submitted",
		});
		const { result, requests, rerender } = setup(() =>
			++calls === 1 ? pending.promise : Response.json(receipt, { status: 202 }),
		);
		rerender({ ...target, executionId: "execution-a" });
		act(() => {
			result.current.submitText("Synthetic private input");
		});
		await waitFor(() => expect(requests).toHaveLength(1));
		rerender({ ...target, executionId: "execution-b" });
		expect(requests[0].signal.aborted).toBe(false);
		await waitFor(() => expect(result.current.isPending).toBe(true));
		act(() => {
			expect(result.current.submitText("Different input")).toBe(false);
			expect(result.current.retry()).toBe(false);
		});
		await act(async () =>
			pending.reject(new TypeError("Synthetic lost response")),
		);
		await waitFor(() =>
			expect(result.current.result).toEqual({ kind: "unknown" }),
		);
		rerender({ ...target, executionId: "execution-c" });
		expect(result.current.result).toEqual({ kind: "unknown" });
		expect(result.current.canRetry).toBe(true);
		act(() => {
			expect(result.current.submitText("Different input")).toBe(false);
			expect(result.current.retry()).toBe(true);
		});
		await waitFor(() =>
			expect(result.current.result).toEqual({ kind: "accepted", receipt }),
		);
		expect(requests).toHaveLength(2);
		expect(requests[1].url).toBe(requests[0].url);
		expect(requests[1].headers.get("Idempotency-Key")).toBe(
			requests[0].headers.get("Idempotency-Key"),
		);
		for (const request of requests)
			expect(await request.json()).toEqual({
				schemaVersion: 1,
				text: "Synthetic private input",
			});
	});
	it("keeps an in-flight stop bound to its original execution and uses the new selection for a later stop", async () => {
		const pending = Promise.withResolvers<Response>();
		let calls = 0;
		const receipt = (executionId: string) =>
			CommandAcceptedProjectionV1Schema.parse({
				schemaVersion: 1,
				executionId,
				messageId: null,
				status: "submitted",
			});
		const { result, requests, rerender } = setup(() =>
			++calls === 1
				? pending.promise
				: Response.json(receipt("execution-b"), { status: 202 }),
		);
		rerender({ ...target, executionId: "execution-a" });
		act(() => {
			result.current.stop();
		});
		await waitFor(() => expect(requests).toHaveLength(1));
		rerender({ ...target, executionId: "execution-b" });
		expect(requests[0].signal.aborted).toBe(false);
		act(() => {
			expect(result.current.stop()).toBe(false);
		});
		await act(async () =>
			pending.resolve(Response.json(receipt("execution-a"), { status: 202 })),
		);
		await waitFor(() =>
			expect(result.current.result).toEqual({
				kind: "accepted",
				receipt: receipt("execution-a"),
			}),
		);
		act(() => {
			expect(result.current.stop()).toBe(true);
		});
		await waitFor(() =>
			expect(result.current.result).toEqual({
				kind: "accepted",
				receipt: receipt("execution-b"),
			}),
		);
		expect(requests).toHaveLength(2);
		expect(await requests[0].json()).toEqual({
			schemaVersion: 1,
			targetExecutionId: "execution-a",
		});
		expect(await requests[1].json()).toEqual({
			schemaVersion: 1,
			targetExecutionId: "execution-b",
		});
		expect(requests[1].headers.get("Idempotency-Key")).not.toBe(
			requests[0].headers.get("Idempotency-Key"),
		);
	});

	it.each([401, 403, 404])(
		"clears its command on HTTP %s and leaves unrelated Query data intact",
		async (status) => {
			const { result, requests, queryClient } = setup(() =>
				Response.json(
					PilotProtocolErrorV1Schema.parse({
						schemaVersion: 1,
						code: "AUTHORIZATION_REVOKED",
						retryable: false,
						message: "Synthetic private failure",
						traceId: "trace-a",
					}),
					{ status },
				),
			);
			queryClient.setQueryData(["unrelated"], { kept: true });
			act(() => {
				result.current.submitText("Synthetic private input");
			});
			await waitFor(() =>
				expect(result.current.result).toEqual({
					kind: "denied",
					code: "AUTHORIZATION_REVOKED",
				}),
			);
			act(() => {
				expect(result.current.retry()).toBe(false);
				expect(result.current.create()).toBe(false);
			});
			expect(requests).toHaveLength(1);
			expect(queryClient.getQueryData(["unrelated"])).toEqual({ kept: true });
			expect(
				JSON.stringify(
					queryClient
						.getMutationCache()
						.getAll()
						.map((item) => item.state),
				),
			).not.toContain("private");
		},
	);

	it.each([
		["MODEL_SELECTION_INVALID", false],
		["ORIGINAL_RESPONSE_NOT_STARTED", false],
		["ORIGINAL_RESPONSE_ALREADY_FINISHED", false],
		["AGENT_BUSY", true],
	] as const)(
		"preserves the formal %s outcome without a fallback command",
		async (code, retryable) => {
			const { result, requests } = setup(() =>
				Response.json(
					PilotProtocolErrorV1Schema.parse({
						schemaVersion: 1,
						code,
						retryable,
						message: "Synthetic private rejection",
						traceId: "trace-a",
					}),
					{ status: 409 },
				),
			);
			act(() => {
				result.current.selectModel({
					modelOptionId: "option-a",
					reasoningLevel: "high",
				});
			});
			await waitFor(() =>
				expect(result.current.result).toEqual({
					kind: "rejected",
					code,
					retryable,
				}),
			);
			expect(requests).toHaveLength(1);
			if (!retryable)
				act(() => {
					expect(result.current.retry()).toBe(false);
				});
		},
	);

	it("aborts on unmount without removing another business mutation", async () => {
		const pending = Promise.withResolvers<Response>();
		const { result, requests, queryClient, unmount } = setup(
			() => pending.promise,
		);
		const unrelated = queryClient.getMutationCache().build(queryClient, {
			mutationKey: ["unrelated"],
			mutationFn: async () => "kept",
		});
		const commands = result.current;
		act(() => {
			commands.submitText("Pending private input");
		});
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(
			JSON.stringify(
				queryClient
					.getMutationCache()
					.getAll()
					.map((item) => item.state),
			),
		).not.toContain("Pending private input");
		unmount();
		expect(requests[0].signal.aborted).toBe(true);
		expect(commands.retry()).toBe(false);
		await act(async () =>
			pending.resolve(
				Response.json(
					CommandAcceptedProjectionV1Schema.parse({
						schemaVersion: 1,
						executionId: "execution-a",
						messageId: "message-a",
						status: "submitted",
					}),
					{ status: 202 },
				),
			),
		);
		expect(queryClient.getMutationCache().getAll()).toEqual([unrelated]);
	});
	it.each(["submitText", "supplement"] as const)(
		"sends %s during an active reply through the ordinary message contract",
		async (method) => {
			const receipt = CommandAcceptedProjectionV1Schema.parse({
				schemaVersion: 1,
				executionId: "execution-a",
				messageId: "supplement-a",
				status: "submitted",
			});
			const { result, requests, rerender } = setup(() =>
				Response.json(receipt, { status: 202 }),
			);
			rerender({ ...target, executionId: "execution-a" });
			act(() => {
				expect(result.current[method]("Synthetic supplement")).toBe(true);
			});
			await waitFor(() =>
				expect(result.current.result).toEqual({ kind: "accepted", receipt }),
			);
			expect(requests).toHaveLength(1);
			expect(new URL(requests[0].url).pathname).toBe(
				"/api/v1/conversations/conversation-a/messages",
			);
			expect(await requests[0].json()).toEqual({
				schemaVersion: 1,
				text: "Synthetic supplement",
			});
		},
	);
	it("uses the actual accepted execution when the previously displayed reply ends before acceptance", async () => {
		const pending = Promise.withResolvers<Response>();
		const { result, requests, rerender } = setup(() => pending.promise);
		rerender({ ...target, executionId: "execution-a" });
		act(() => {
			result.current.supplement("Synthetic supplement");
		});
		await waitFor(() => expect(requests).toHaveLength(1));
		const receipt = CommandAcceptedProjectionV1Schema.parse({
			schemaVersion: 1,
			executionId: "execution-b",
			messageId: "message-b",
			status: "submitted",
		});
		await act(async () =>
			pending.resolve(Response.json(receipt, { status: 202 })),
		);
		await waitFor(() =>
			expect(result.current.result).toEqual({ kind: "accepted", receipt }),
		);
		expect(JSON.stringify(result.current.result)).not.toContain("execution-a");
		expect(requests).toHaveLength(1);
	});
	it("shows busy without fallback and retries the same message key, body and conversation explicitly", async () => {
		let calls = 0;
		const { result, requests, rerender } = setup(() =>
			++calls === 1
				? Response.json(
						PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "AGENT_BUSY",
							retryable: true,
							message: "Synthetic busy response",
							traceId: "trace-a",
						}),
						{ status: 409 },
					)
				: Response.json(
						CommandAcceptedProjectionV1Schema.parse({
							schemaVersion: 1,
							executionId: "execution-a",
							messageId: "supplement-a",
							status: "submitted",
						}),
						{ status: 202 },
					),
		);
		rerender({ ...target, executionId: "execution-a" });
		act(() => {
			result.current.supplement("Synthetic supplement");
		});
		await waitFor(() =>
			expect(result.current.result).toEqual({
				kind: "rejected",
				code: "AGENT_BUSY",
				retryable: true,
			}),
		);
		expect(requests).toHaveLength(1);
		act(() => {
			expect(result.current.retry()).toBe(true);
			expect(result.current.retry()).toBe(false);
		});
		await waitFor(() =>
			expect(result.current.result).toMatchObject({ kind: "accepted" }),
		);
		expect(requests).toHaveLength(2);
		expect(requests[1].url).toBe(requests[0].url);
		expect(requests[1].headers.get("Idempotency-Key")).toBe(
			requests[0].headers.get("Idempotency-Key"),
		);
		for (const request of requests)
			expect(await request.json()).toEqual({
				schemaVersion: 1,
				text: "Synthetic supplement",
			});
	});
	it("consumes model selection and regeneration using their actual command schemas", async () => {
		const { result, requests } = setup((request) =>
			request.method === "PUT"
				? Response.json(
						ConversationProjectionV1Schema.parse({
							...conversation(),
							selectedModelOptionId: "option-a",
							selectedReasoningLevel: "high",
						}),
					)
				: Response.json(
						CommandAcceptedProjectionV1Schema.parse({
							schemaVersion: 1,
							executionId: "regenerated-a",
							messageId: null,
							status: "submitted",
						}),
						{ status: 202 },
					),
		);
		act(() => {
			result.current.selectModel({
				modelOptionId: "option-a",
				reasoningLevel: "high",
			});
		});
		await waitFor(() =>
			expect(result.current.result).toEqual({
				kind: "selection-updated",
				agentId: "agent-a",
				conversationId: "conversation-a",
				modelOptionId: "option-a",
				reasoningLevel: "high",
			}),
		);
		act(() => {
			result.current.regenerate("original-message");
		});
		await waitFor(() =>
			expect(result.current.result).toMatchObject({
				kind: "accepted",
				receipt: {
					executionId: "regenerated-a",
					messageId: null,
				},
			}),
		);
		expect(new URL(requests[0].url).pathname).toBe(
			"/api/v1/conversations/conversation-a/model-selection",
		);
		expect(await requests[0].json()).toEqual({
			schemaVersion: 1,
			modelOptionId: "option-a",
			reasoningLevel: "high",
		});
		expect(new URL(requests[1].url).pathname).toBe(
			"/api/v1/conversations/conversation-a/regenerations",
		);
		expect(await requests[1].json()).toEqual({
			schemaVersion: 1,
			messageId: "original-message",
		});
	});
	it("sends the original stop target and retains its acceptance without synthesizing cancellation", async () => {
		const receipt = CommandAcceptedProjectionV1Schema.parse({
			schemaVersion: 1,
			executionId: "execution-a",
			messageId: null,
			status: "submitted",
		});
		const { result, requests, rerender } = setup(() =>
			Response.json(receipt, { status: 202 }),
		);
		rerender({ ...target, executionId: "execution-a" });
		act(() => {
			result.current.stop();
		});
		await waitFor(() =>
			expect(result.current.result).toEqual({ kind: "accepted", receipt }),
		);
		expect(new URL(requests[0].url).pathname).toBe(
			"/api/v1/conversations/conversation-a/stops",
		);
		expect(await requests[0].json()).toEqual({
			schemaVersion: 1,
			targetExecutionId: "execution-a",
		});
		expect(JSON.stringify(result.current.result)).not.toContain("cancelled");
	});
	it("keeps an uncertain message's original key and payload for explicit retry only", async () => {
		let calls = 0;
		const { result, requests, queryClient, rerender } = setup(() => {
			if (++calls === 1) throw new TypeError("Synthetic lost response");
			return Response.json(
				CommandAcceptedProjectionV1Schema.parse({
					schemaVersion: 1,
					executionId: "execution-a",
					messageId: "message-a",
					status: "submitted",
				}),
				{ status: 202 },
			);
		});
		rerender({ ...target, executionId: "execution-a" });
		act(() => {
			result.current.submitText("Synthetic private input");
		});
		await waitFor(() =>
			expect(result.current.result).toEqual({ kind: "unknown" }),
		);
		expect(requests).toHaveLength(1);
		act(() => {
			expect(result.current.submitText("Different input")).toBe(false);
		});
		expect(
			JSON.stringify(
				queryClient
					.getMutationCache()
					.getAll()
					.map((item) => item.state),
			),
		).not.toContain("Synthetic private input");
		act(() => {
			expect(result.current.retry()).toBe(true);
		});
		await waitFor(() =>
			expect(result.current.result).toMatchObject({ kind: "accepted" }),
		);
		expect(requests).toHaveLength(2);
		expect(requests[0].headers.get("Idempotency-Key")).toBeTruthy();
		expect(requests[1].headers.get("Idempotency-Key")).toBe(
			requests[0].headers.get("Idempotency-Key"),
		);
		expect(await requests[0].json()).toEqual({
			schemaVersion: 1,
			text: "Synthetic private input",
		});
		expect(await requests[1].json()).toEqual({
			schemaVersion: 1,
			text: "Synthetic private input",
		});
		act(() => {
			expect(result.current.retry()).toBe(false);
		});
	});
	it("creates one conversation for a double click and excludes its title from mutation state", async () => {
		const response = Promise.withResolvers<Response>();
		const { result, requests, queryClient } = setup(() => response.promise);
		act(() => {
			expect(result.current.create()).toBe(true);
			expect(result.current.create()).toBe(false);
		});
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(new URL(requests[0].url).pathname).toBe(
			"/api/v1/agents/agent-a/conversations",
		);
		expect(await requests[0].json()).toEqual({ schemaVersion: 1 });
		await act(async () =>
			response.resolve(Response.json(conversation(), { status: 201 })),
		);
		await waitFor(() =>
			expect(result.current.result).toEqual({
				kind: "created",
				agentId: "agent-a",
				conversationId: "conversation-a",
			}),
		);
		expect(
			JSON.stringify(
				queryClient
					.getMutationCache()
					.getAll()
					.map((item) => item.state),
			),
		).not.toContain("Synthetic private title");
	});
});
