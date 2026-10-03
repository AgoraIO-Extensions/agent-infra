import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
	type CodexNativeCallbackHandlerV1,
	type CodexNativeCallbackResponseV1,
	type CodexNativeOperationRequestV1,
	type CodexNativeSourceRequestV1,
	type CodexNativeSourceResponseV1,
	serveCodexNativeCallbacksV1,
} from "./codex-native-callback.js";

function pair() {
	const requests = new PassThrough();
	const replies = new PassThrough();
	const server = Duplex.from({ readable: requests, writable: replies });
	const native = Duplex.from({ readable: replies, writable: requests });
	native.on("error", () => {});
	return { server, native };
}

const sourceOwner = {
	rootThreadId: "original-thread",
	rootTurnId: "original-turn",
};

function sourceReserve(): Extract<
	CodexNativeSourceRequestV1,
	{ phase: "source-reserve" }
> {
	return {
		schemaVersion: 1,
		requestId: randomUUID(),
		phase: "source-reserve",
		occurredAt: Date.now(),
		reservation: {
			reservationId: randomUUID(),
			parent: { ...intent().identity, parentAttemptRef: randomUUID() },
			parentPermitId: randomUUID(),
			childThreadId: "child-线程",
			submissionId: "child-submission",
		},
	};
}

const nativeSource = { threadId: "child-线程", turnId: "child-turn" };

function sourceBind(
	delivery: "started" | "steered" = "started",
): Extract<CodexNativeSourceRequestV1, { phase: "source-bind" }> {
	return {
		...sourceReserve(),
		phase: "source-bind",
		source: nativeSource,
		delivery,
	};
}

const notStartedDetails = [
	{ stage: "not_queued", reason: "queue_closed" },
	{ stage: "not_queued", reason: "cancelled_before_start" },
	{ stage: "not_routed", reason: "routing_rejected" },
	{ stage: "not_routed", reason: "cancelled_before_start" },
	{ stage: "gate_rejected", reason: "binding_denied", source: nativeSource },
	{
		stage: "gate_rejected",
		reason: "cancelled_before_start",
		source: nativeSource,
	},
] as const;

function sourceNotStarted(
	details: (typeof notStartedDetails)[number] = notStartedDetails[0],
): Extract<CodexNativeSourceRequestV1, { phase: "source-not-started" }> {
	return { ...sourceReserve(), ...details, phase: "source-not-started" };
}

function sourceTerminal(
	nativeStatus: "completed" | "failed" | "cancelled" = "completed",
): Extract<CodexNativeSourceRequestV1, { phase: "source-terminal" }> {
	return {
		...sourceReserve(),
		phase: "source-terminal",
		source: nativeSource,
		nativeStatus,
	};
}

function sourceAck(
	request: CodexNativeSourceRequestV1,
): CodexNativeSourceResponseV1 {
	if (request.phase === "source-reserve" || request.phase === "source-bind") {
		return {
			schemaVersion: 1,
			requestId: request.requestId,
			phase: request.phase,
			request,
			decision: "ack",
			sourceOwner,
		};
	}
	return {
		schemaVersion: 1,
		requestId: request.requestId,
		phase: request.phase,
		request,
		decision: "ack",
	};
}

async function expectSourceExchange(
	request: CodexNativeSourceRequestV1,
	response: CodexNativeSourceResponseV1 = sourceAck(request),
) {
	const { server, native } = pair();
	const failure = vi.fn();
	const handle = vi.fn<CodexNativeCallbackHandlerV1>(async () => response);
	const channel = serveCodexNativeCallbacksV1(server, handle, failure);
	try {
		const frame = Buffer.from(`${JSON.stringify(request)}\n`);
		// Split inside a multibyte identifier and withhold the final newline.
		const split = frame.indexOf(Buffer.from("线程")) + 1;
		expect(split).toBeGreaterThan(0);
		native.write(frame.subarray(0, split));
		await setImmediate();
		expect(handle).not.toHaveBeenCalled();
		native.write(frame.subarray(split, -1));
		await setImmediate();
		expect(handle).not.toHaveBeenCalled();
		const replied = once(native, "data");
		native.write(frame.subarray(-1));
		const [bytes] = await replied;
		expect(bytes.toString()).toBe(`${JSON.stringify(response)}\n`);
		expect(handle).toHaveBeenCalledExactlyOnceWith(
			request,
			expect.any(AbortSignal),
		);
		expect(failure).not.toHaveBeenCalled();
	} finally {
		channel.close();
		await channel.finished;
		native.destroy();
	}
}

async function expectRejectedSourceResponse(
	request: CodexNativeSourceRequestV1 | CodexNativeOperationRequestV1,
	response: unknown,
) {
	const { server, native } = pair();
	const failure = vi.fn();
	const received: Buffer[] = [];
	native.on("data", (bytes) => received.push(bytes));
	// Deliberately inject a possibly invalid handler result at the wire boundary.
	const handle = vi.fn<CodexNativeCallbackHandlerV1>(
		async () => response as CodexNativeCallbackResponseV1,
	);
	const channel = serveCodexNativeCallbacksV1(server, handle, failure);
	try {
		native.write(`${JSON.stringify(request)}\n`);
		await channel.finished;
		expect(handle).toHaveBeenCalledExactlyOnceWith(
			request,
			expect.any(AbortSignal),
		);
		expect(failure).toHaveBeenCalledOnce();
		expect(server.destroyed).toBe(true);
		expect(received).toEqual([]);
	} finally {
		channel.close();
		native.destroy();
	}
}

async function expectRejectedSourceInput(
	value: unknown,
	frame = Buffer.from(`${JSON.stringify(value)}\n`),
) {
	const { server, native } = pair();
	const failure = vi.fn();
	const handle = vi.fn<CodexNativeCallbackHandlerV1>();
	const received: Buffer[] = [];
	native.on("data", (bytes) => received.push(bytes));
	const channel = serveCodexNativeCallbacksV1(server, handle, failure);
	try {
		native.write(frame);
		await channel.finished;
		expect(handle).not.toHaveBeenCalled();
		expect(failure).toHaveBeenCalledOnce();
		expect(server.destroyed).toBe(true);
		expect(received).toEqual([]);
	} finally {
		channel.close();
		native.destroy();
	}
}

function intent(): CodexNativeOperationRequestV1 {
	return {
		schemaVersion: 1,
		requestId: randomUUID(),
		phase: "intent",
		occurredAt: Date.now(),
		identity: {
			sessionId: "original-thread",
			turnId: "original-turn",
			callId: "original-call",
			attemptRef: randomUUID(),
			toolName: "exec_command",
		},
	};
}

describe("private native callback channel", () => {
	it("withholds a permit while durable intent and authorization are pending", async () => {
		const { server, native } = pair();
		const saved = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const request = intent();
		const failure = vi.fn();
		const observed: Buffer[] = [];
		native.on("data", (bytes) => observed.push(bytes));
		const running = serveCodexNativeCallbacksV1(
			server,
			async (value) => {
				assert("identity" in value);
				entered.resolve();
				await saved.promise;
				return {
					schemaVersion: 1,
					requestId: value.requestId,
					phase: "intent",
					identity: value.identity,
					decision: "permit",
					sourceOwner: {
						rootThreadId: "original-thread",
						rootTurnId: "original-turn",
					},
					permitId: randomUUID(),
					expiresAt: Date.now() + 3000,
				};
			},
			failure,
		);
		try {
			native.write(`${JSON.stringify(request)}\n`);
			await entered.promise;
			expect(observed).toEqual([]);
			const replied = once(native, "data");
			saved.resolve();
			const [bytes] = await replied;
			expect(JSON.parse(bytes.toString())).toMatchObject({
				decision: "permit",
				requestId: request.requestId,
				identity: request.identity,
			});
			expect(failure).not.toHaveBeenCalled();
		} finally {
			running.close();
			await running.finished;
			native.destroy();
		}
	});

	it.each(["identity", "expired", "extra field"])(
		"closes rather than sending %s authorization",
		async (mode) => {
			const { server, native } = pair();
			const failed = Promise.withResolvers<void>();
			const received: Buffer[] = [];
			native.on("data", (bytes) => received.push(bytes));
			const channel = serveCodexNativeCallbacksV1(
				server,
				async (request) => {
					assert("identity" in request);
					return {
						schemaVersion: 1,
						requestId: request.requestId,
						phase: "intent",
						identity: {
							...request.identity,
							...(mode === "identity" ? { turnId: "foreign-turn" } : {}),
						},
						decision: "permit",
						sourceOwner: {
							rootThreadId: "original-thread",
							rootTurnId: "original-turn",
						},
						permitId: randomUUID(),
						expiresAt: mode === "expired" ? Date.now() - 1 : Date.now() + 3000,
						...(mode === "extra field"
							? { untrusted: "private-request-sentinel" }
							: {}),
					};
				},
				() => failed.resolve(),
			);
			native.write(`${JSON.stringify(intent())}\n`);
			await failed.promise;
			await channel.finished;
			expect(received).toEqual([]);
			native.destroy();
		},
	);

	it.each(["extra", "oversized", "malformed"])(
		"rejects %s input before invoking a durable handler",
		async (mode) => {
			const { server, native } = pair();
			const failed = Promise.withResolvers<void>();
			const handle = vi.fn();
			const channel = serveCodexNativeCallbacksV1(server, handle, () =>
				failed.resolve(),
			);
			native.write(
				mode === "oversized"
					? "x".repeat(16_385)
					: mode === "malformed"
						? "{bad\n"
						: `${JSON.stringify({ ...intent(), args: "private-request-sentinel" })}\n`,
			);
			await failed.promise;
			await channel.finished;
			expect(handle).not.toHaveBeenCalled();
			native.destroy();
		},
	);
	it("rejects duplicate keys when whitespace precedes the colon", async () => {
		const request = intent();
		const input = JSON.stringify(request);
		const first = input.replace('"requestId":', '"requestId" :');
		const duplicate = `${first.slice(0, -1)},"requestId":"${randomUUID()}"}\n`;
		await expectRejectedSourceInput(request, Buffer.from(duplicate));
	});

	it("cancels a pending handler when the native side disconnects", async () => {
		const { server, native } = pair();
		const entered = Promise.withResolvers<AbortSignal>();
		const failed = Promise.withResolvers<void>();
		const channel = serveCodexNativeCallbacksV1(
			server,
			async (_request, signal) => {
				entered.resolve(signal);
				await once(signal, "abort");
				throw new Error("private-error-sentinel");
			},
			() => failed.resolve(),
		);
		native.write(`${JSON.stringify(intent())}\n`);
		const signal = await entered.promise;
		native.destroy();
		await failed.promise;
		await channel.finished;
		expect(signal.aborted).toBe(true);
	});
});

describe("private native source callback frames", () => {
	it.each([
		["source-reserve", sourceReserve],
		["source-bind started", () => sourceBind("started")],
		["source-bind steered", () => sourceBind("steered")],
		["source-not-started", sourceNotStarted],
		["source-terminal", sourceTerminal],
	] as const)(
		"echoes the complete fragmented %s request",
		async (_name, make) => {
			await expectSourceExchange(make());
		},
	);

	it.each(notStartedDetails)(
		"acknowledges source-not-started $stage / $reason with its permitted source shape",
		async (details) => {
			await expectSourceExchange(sourceNotStarted(details));
		},
	);

	it.each(["completed", "failed", "cancelled"] as const)(
		"acknowledges the actual source terminal status %s",
		async (status) => {
			await expectSourceExchange(sourceTerminal(status));
		},
	);

	it.each([sourceReserve, sourceBind])(
		"can deny a new reserve or started binding with a full echoed request",
		async (make) => {
			const request = make();
			await expectSourceExchange(request, {
				schemaVersion: 1,
				requestId: request.requestId,
				phase: request.phase,
				request,
				decision: "deny",
				reason: "authorization_denied",
			});
		},
	);

	it.each([
		"authorization_denied",
		"authorization_unavailable",
		"persistence_unavailable",
	] as const)(
		"closes instead of denying an already steered bind: %s",
		async (reason) => {
			const request = sourceBind("steered");
			await expectRejectedSourceResponse(request, {
				schemaVersion: 1,
				requestId: request.requestId,
				phase: request.phase,
				request,
				decision: "deny",
				reason,
			});
		},
	);

	it.each([
		"reservationId",
		"parentPermitId",
		"childThreadId",
		"submissionId",
	] as const)("closes on an echoed reservation.%s mismatch", async (field) => {
		const request = sourceBind();
		const response = sourceAck({
			...request,
			reservation: { ...request.reservation, [field]: randomUUID() },
		});
		await expectRejectedSourceResponse(request, response);
	});

	it.each([
		"sessionId",
		"turnId",
		"callId",
		"attemptRef",
		"toolName",
		"parentAttemptRef",
	] as const)(
		"closes on an echoed reservation.parent.%s mismatch",
		async (field) => {
			const request = sourceBind();
			await expectRejectedSourceResponse(
				request,
				sourceAck({
					...request,
					reservation: {
						...request.reservation,
						parent: { ...request.reservation.parent, [field]: randomUUID() },
					},
				}),
			);
		},
	);

	it("closes when the echoed optional parent ancestry is omitted", async () => {
		const request = sourceBind();
		const { parentAttemptRef: _parentAttemptRef, ...parent } =
			request.reservation.parent;
		await expectRejectedSourceResponse(
			request,
			sourceAck({
				...request,
				reservation: { ...request.reservation, parent },
			}),
		);
	});

	it.each(["threadId", "turnId"] as const)(
		"closes on an echoed actual source.%s mismatch",
		async (field) => {
			const request = sourceBind();
			await expectRejectedSourceResponse(
				request,
				sourceAck({
					...request,
					source: { ...request.source, [field]: "another-source" },
				}),
			);
		},
	);

	it.each([sourceReserve, sourceBind, sourceNotStarted, sourceTerminal])(
		"closes when only the echoed request timestamp changes",
		async (make) => {
			const request = make();
			await expectRejectedSourceResponse(
				request,
				sourceAck({ ...request, occurredAt: request.occurredAt + 1 }),
			);
		},
	);

	it.each(["outer requestId", "echoed requestId", "phase", "delivery"])(
		"closes on a source callback %s mismatch",
		async (mode) => {
			const request = sourceBind();
			let response = sourceAck(request);
			if (mode === "outer requestId") {
				response = { ...response, requestId: randomUUID() };
			} else if (mode === "echoed requestId") {
				response = {
					...sourceAck({ ...request, requestId: randomUUID() }),
					requestId: request.requestId,
				};
			} else if (mode === "phase") {
				const {
					source: _source,
					delivery: _delivery,
					...reservation
				} = request;
				response = sourceAck({ ...reservation, phase: "source-reserve" });
			} else {
				response = sourceAck({ ...request, delivery: "steered" });
			}
			await expectRejectedSourceResponse(request, response);
		},
	);

	it.each(["stage", "reason"])(
		"closes on a schema-valid not-started %s echo mismatch",
		async (mode) => {
			const request = sourceNotStarted();
			const echo = {
				...request,
				...(mode === "stage" ? notStartedDetails[2] : notStartedDetails[1]),
			};
			await expectRejectedSourceResponse(request, sourceAck(echo));
		},
	);

	it("closes on a different echoed native terminal status", async () => {
		const request = sourceTerminal();
		await expectRejectedSourceResponse(
			request,
			sourceAck({ ...request, nativeStatus: "cancelled" }),
		);
	});

	it.each([
		["source-reserve", sourceReserve],
		["source-bind started", () => sourceBind("started")],
		["source-bind steered", () => sourceBind("steered")],
	] as const)("requires sourceOwner on a %s ACK", async (_name, make) => {
		const request = make();
		const response = sourceAck(request);
		assert("sourceOwner" in response);
		const { sourceOwner: _owner, ...missingOwner } = response;
		await expectRejectedSourceResponse(request, missingOwner);
	});

	it.each([
		{},
		{ rootThreadId: "original-thread" },
		{ rootTurnId: "original-turn" },
		{ ...sourceOwner, rootTurnId: "" },
		{ ...sourceOwner, actorId: "caller-supplied" },
	])("rejects a malformed sourceOwner %j", async (owner) => {
		const request = sourceReserve();
		await expectRejectedSourceResponse(request, {
			...sourceAck(request),
			sourceOwner: owner,
		});
	});

	it("requires sourceOwner on an operation permit as well", async () => {
		const request = intent();
		await expectRejectedSourceResponse(request, {
			schemaVersion: 1,
			requestId: request.requestId,
			phase: "intent",
			identity: request.identity,
			decision: "permit",
			permitId: randomUUID(),
			expiresAt: Date.now() + 3000,
		});
	});

	it.each([sourceNotStarted, sourceTerminal])(
		"accepts only a plain ACK for source completion bookkeeping",
		async (make) => {
			const request = make();
			await expectRejectedSourceResponse(request, {
				...sourceAck(request),
				sourceOwner,
			});
			await expectRejectedSourceResponse(request, {
				...sourceAck(request),
				decision: "deny",
				reason: "authorization_denied",
			});
		},
	);

	it("rejects coalesced source requests before either handler runs", async () => {
		const request = sourceReserve();
		const frame = `${JSON.stringify(request)}\n`;
		await expectRejectedSourceInput(request, Buffer.from(frame + frame));
	});

	it("rejects malformed UTF-8 inside a source identifier before the handler", async () => {
		const request = sourceBind();
		const frame = Buffer.from(`${JSON.stringify(request)}\n`);
		const identifier = frame.indexOf(Buffer.from("线程"));
		expect(identifier).toBeGreaterThan(0);
		frame[identifier] = 0xff;
		await expectRejectedSourceInput(request, frame);
	});

	it.each([
		{ stage: "not_queued", reason: "routing_rejected" },
		{ stage: "not_routed", reason: "queue_closed" },
		{ stage: "gate_rejected", reason: "queue_closed", source: nativeSource },
		{ stage: "gate_rejected", reason: "binding_denied" },
		{ stage: "not_queued", reason: "queue_closed", source: nativeSource },
		{ stage: "not_routed", reason: "routing_rejected", source: nativeSource },
	])(
		"rejects illegal not-started combinations before the handler: %j",
		async (details) => {
			await expectRejectedSourceInput({
				...sourceReserve(),
				phase: "source-not-started",
				...details,
			});
		},
	);

	it.each([
		["caller supplied owner", () => ({ ...sourceReserve(), sourceOwner })],
		[
			"reserve with a premature source",
			() => ({ ...sourceReserve(), source: nativeSource }),
		],
		["bind without delivery", () => ({ ...sourceBind(), delivery: undefined })],
		[
			"bind without actual source",
			() => ({ ...sourceBind(), source: undefined }),
		],
		[
			"terminal with unknown status",
			() => ({ ...sourceTerminal(), nativeStatus: "unknown" }),
		],
		[
			"missing parent permit",
			() => {
				const request = sourceReserve();
				return {
					...request,
					reservation: { ...request.reservation, parentPermitId: undefined },
				};
			},
		],
	] as const)("rejects %s before the handler", async (_name, make) => {
		await expectRejectedSourceInput(make());
	});
});
