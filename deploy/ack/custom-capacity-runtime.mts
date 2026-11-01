import { createHash, type KeyObject, randomUUID } from "node:crypto";
import { createWorkerRuntimeGrantSignerV2 } from "../../apps/platform-worker/src/runtime-grant-signer.ts";
import { createWorkerRuntimeHostClientV3 } from "../../apps/platform-worker/src/runtime-host-client.ts";
import {
	type RuntimeEventPersistRequestV3,
	type RuntimeEventV2,
	RuntimeSubmitTurnRequestV3Schema,
} from "../../packages/contracts/src/runtime/index.ts";

const MAX_BYTES = 1_048_576;
const MAX_EVENTS = 256;
const MAX_READS = 128;
const STREAM_WINDOW_MS = 10_000;
const MAX_DURATION_SAMPLING_SKEW_MS = 1_000;
const PROMPT =
	"Reply with exactly READY. Do not use tools, files, or external actions.";

export interface CustomRuntimeOptions {
	baseUrl: string;
	serviceToken: string;
	privateKey: KeyObject;
	grantIssuer: string;
	grantKeyId: string;
	workerId: string;
	agentId: string;
	principal: { kind: "application"; id: string };
	modelOptionId: string;
	reasoningLevel: string;
	runtimeConfigVersion: string;
	expectedModelId: string;
	expectedReply: string;
	signal: AbortSignal;
	checkpoint: (value: Record<string, unknown>) => Promise<void>;
	fetch?: typeof fetch;
	now?: () => number;
}

export class CustomCapacityRuntimeError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "CustomCapacityRuntimeError";
		this.code = code;
	}
}
function fail(code: string): never {
	throw new CustomCapacityRuntimeError(code);
}
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const errorCode = (error: unknown) =>
	error && typeof error === "object" && "code" in error
		? error.code
		: undefined;

// Race dependencies as well as native fetch: a late body/checkpoint cannot sign success.
async function bounded<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				abort = () =>
					reject(new CustomCapacityRuntimeError("CUSTOM_CAPACITY_DEADLINE"));
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

export async function measureCustomRuntime(options: CustomRuntimeOptions) {
	const now = options.now ?? Date.now;
	const lifetime = new AbortController();
	const signal = AbortSignal.any([options.signal, lifetime.signal]);
	const check = () => {
		if (signal.aborted) fail("CUSTOM_CAPACITY_DEADLINE");
	};
	let bytes = 0;
	let byteLimitExceeded = false;
	try {
		check();
		const origin = new URL(options.baseUrl);
		if (
			origin.protocol !== "http:" ||
			!["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) ||
			origin.username ||
			origin.password ||
			origin.search ||
			origin.hash ||
			origin.pathname !== "/" ||
			options.expectedReply !== "READY" ||
			options.principal.kind !== "application"
		)
			fail("CUSTOM_CAPACITY_RUNTIME_INPUT_INVALID");

		const transport =
			(status?: (value: number) => void): typeof fetch =>
			async (input, init) => {
				check();
				const requestSignal = AbortSignal.any([
					signal,
					...(init?.signal ? [init.signal] : []),
				]);
				const pending = (options.fetch ?? fetch)(input, {
					...init,
					signal: requestSignal,
					redirect: "error",
				});
				void pending.then(
					(late) => {
						if (requestSignal.aborted)
							void late.body?.cancel().catch(() => undefined);
					},
					() => undefined,
				);
				const response = await bounded(pending, requestSignal);
				check();
				status?.(response.status);
				const reader = response.body?.getReader();
				if (!reader) return response;
				const body = new ReadableStream<Uint8Array>({
					async pull(controller) {
						try {
							const next = await bounded(reader.read(), requestSignal);
							if (requestSignal.aborted) fail("CUSTOM_CAPACITY_DEADLINE");
							bytes += next.value?.byteLength ?? 0;
							if (bytes > MAX_BYTES) {
								byteLimitExceeded = true;
								fail("CUSTOM_CAPACITY_EVENT_LIMIT");
							}
							if (next.done) controller.close();
							else if (next.value) controller.enqueue(next.value);
						} catch (error) {
							controller.error(error);
							void reader.cancel().catch(() => undefined);
						}
					},
					cancel() {
						void reader.cancel().catch(() => undefined);
					},
				});
				return new Response(body, {
					status: response.status,
					headers: response.headers,
				});
			};
		const clientFor = (
			serviceToken: string,
			status?: (value: number) => void,
		) =>
			createWorkerRuntimeHostClientV3({
				baseUrl: origin.href,
				serviceToken,
				fetch: transport(status),
			});
		const client = clientFor(options.serviceToken);
		const sign = createWorkerRuntimeGrantSignerV2({
			issuer: options.grantIssuer,
			workerId: options.workerId,
			keyId: options.grantKeyId,
			privateKey: options.privateKey,
			now,
		});
		const executionId = randomUUID();
		const context = {
			schemaVersion: 3 as const,
			requestId: randomUUID(),
			traceId: randomUUID(),
			principal: options.principal,
			channelId: "isolated-custom-runtime-capacity",
			agentId: options.agentId,
			conversationId: randomUUID(),
			executionId,
			turnId: randomUUID(),
			sessionGeneration: 1,
			hostSessionRef: null,
			operation: {
				kind: "execution" as const,
				id: executionId,
				deliveryFence: 1,
				executionDeliveryFence: 1,
			},
		};
		const authority = {
			purpose: "business" as const,
			authorizationRecordId: randomUUID(),
		};
		const control = {
			purpose: "control" as const,
			controlRecordId: randomUUID(),
			reason: "recovery" as const,
		};
		const probe = {
			...context,
			originalOperationDigest: createHash("sha256")
				.update(executionId)
				.digest("base64url"),
		};
		const signedProbe = {
			...probe,
			grant: sign(probe, control, "session.status"),
		};
		async function requireDenial(
			token: string,
			crossBinding: boolean,
			httpStatus: number,
			code: string,
		) {
			let observedStatus: number | undefined;
			try {
				await bounded(
					clientFor(token, (value) => {
						observedStatus = value;
					}).readOriginalBinding(
						crossBinding
							? { ...signedProbe, agentId: randomUUID() }
							: signedProbe,
						signal,
					),
					signal,
				);
			} catch (error) {
				check();
				if (observedStatus === httpStatus && errorCode(error) === code) return;
			}
			fail("CUSTOM_CAPACITY_NEGATIVE_CHECK_FAILED");
		}
		await requireDenial(
			`invalid-${randomUUID()}`,
			false,
			401,
			"RUNTIME_SERVICE_UNAUTHORIZED",
		);
		await requireDenial(
			options.serviceToken,
			true,
			403,
			"RUNTIME_GRANT_INVALID",
		);
		const negativeChecks = {
			wrongServiceToken: true as const,
			crossBindingGrant: true as const,
		};
		const turn = {
			...context,
			requestId: randomUUID(),
			input: { text: PROMPT, attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: options.modelOptionId,
				reasoningLevel: options.reasoningLevel,
			},
		};
		const request = RuntimeSubmitTurnRequestV3Schema.parse({
			...turn,
			grant: sign(turn, authority, "turn.submit"),
		});
		const submittedAt = new Date(now()).toISOString();
		let renewAt = now() + 15_000;
		const accepted = await bounded(client.submitTurn(request, signal), signal);
		check();
		if (
			accepted.operationId !== executionId ||
			accepted.result.outcome !== "accepted" ||
			!["running", "completed"].includes(accepted.result.status)
		)
			fail("CUSTOM_CAPACITY_SUBMIT_UNCONFIRMED");
		const hostSessionRef = accepted.hostSessionRef;
		const boundContext = { ...context, hostSessionRef };
		let cursor: string | null = null;
		let reply = "";
		let completedAt: string | undefined;
		const modelFacts: RuntimeEventV2[] = [];
		let intent: RuntimeEventV2 | undefined;
		let lastTime = Date.parse(submittedAt);
		const cursors = new Set<string>();
		const eventKeys = new Set<string>();
		const persist = async (nextCursor: string | null) => {
			try {
				await bounded(
					options.checkpoint({
						executionId,
						operationId: executionId,
						hostSessionRef,
						submittedAt,
						confirmedCursor: nextCursor,
						modelFacts: structuredClone(modelFacts),
						replySha256: hash(reply),
						terminal: completedAt !== undefined,
						...(completedAt ? { completedAt } : {}),
						negativeChecks,
					}),
					signal,
				);
			} catch {
				check();
				fail("CUSTOM_CAPACITY_CHECKPOINT_FAILED");
			}
			check();
		};
		await persist(null);
		const renew = async () => {
			if (now() < renewAt) return;
			const body = { ...boundContext, requestId: randomUUID() };
			const renewed = await bounded(
				client.renewAuthorization(
					{ ...body, grant: sign(body, authority, "execution.renew") },
					signal,
				),
				signal,
			);
			check();
			if (
				renewed.executionId !== executionId ||
				renewed.expiresAt <= now() ||
				renewed.expiresAt > now() + 30_000
			)
				fail("CUSTOM_CAPACITY_RENEW_INVALID");
			renewAt = renewed.expiresAt - 15_000;
		};
		for (let read = 0; read < MAX_READS; read++) {
			check();
			await renew();
			const streamAbort = new AbortController();
			const streamSignal = AbortSignal.any([signal, streamAbort.signal]);
			const timer = setTimeout(() => streamAbort.abort(), STREAM_WINDOW_MS);
			const issuedAt = now();
			try {
				const body: Omit<RuntimeEventPersistRequestV3, "grant"> = {
					...boundContext,
					requestId: randomUUID(),
					consumer: "platform_worker_persistence" as const,
					afterCursor: cursor,
				};
				for await (const event of client.events(
					{ ...body, grant: sign(body, authority, "events.persist") },
					streamSignal,
				)) {
					check();
					if (cursors.size >= MAX_EVENTS) fail("CUSTOM_CAPACITY_EVENT_LIMIT");
					if (
						event.executionId !== executionId ||
						cursors.has(event.cursor) ||
						eventKeys.has(event.adapterEventKey)
					)
						fail("CUSTOM_CAPACITY_EVENT_BINDING_INVALID");
					const eventTime = Date.parse(event.occurredAt);
					if (eventTime < lastTime || eventTime > now())
						fail("CUSTOM_CAPACITY_EVENT_TIME_INVALID");
					lastTime = eventTime;
					cursors.add(event.cursor);
					eventKeys.add(event.adapterEventKey);
					if (event.type === "operation") {
						const fact = event.payload;
						if (
							fact.kind !== "model" ||
							!["intent", "started", "completed"].includes(fact.phase) ||
							fact.failureCode !== undefined
						)
							fail("CUSTOM_CAPACITY_MODEL_FACT_INVALID");
						if (
							fact.model.configVersion !== options.runtimeConfigVersion ||
							fact.model.modelOptionId !== options.modelOptionId ||
							fact.model.modelId !== options.expectedModelId ||
							fact.model.reasoningLevel !== options.reasoningLevel
						)
							fail("CUSTOM_CAPACITY_MODEL_IDENTITY_INVALID");
						const first = intent ?? modelFacts[0];
						if (
							first &&
							(first.payload.operationRef !== fact.operationRef ||
								first.payload.attemptRef !== fact.attemptRef)
						)
							fail("CUSTOM_CAPACITY_MODEL_BINDING_INVALID");
						if (fact.phase === "intent") {
							if (intent || modelFacts.length)
								fail("CUSTOM_CAPACITY_MODEL_FACT_INVALID");
							intent = event;
						} else {
							const started = Date.parse(fact.startedAt ?? "");
							if (
								!Number.isFinite(started) ||
								started < Date.parse(submittedAt) ||
								started > eventTime
							)
								fail("CUSTOM_CAPACITY_EVENT_TIME_INVALID");
							if (fact.phase === "started") {
								if (
									modelFacts.length ||
									fact.finishedAt !== undefined ||
									fact.durationMs !== undefined
								)
									fail("CUSTOM_CAPACITY_MODEL_FACT_INVALID");
							} else {
								const finished = Date.parse(fact.finishedAt ?? "");
								const duration = fact.durationMs;
								// ACP samples finishedAt and durationMs in separate clock reads.
								if (
									modelFacts.length !== 1 ||
									modelFacts[0]?.payload.startedAt !== fact.startedAt ||
									!Number.isFinite(finished) ||
									finished < started ||
									finished > eventTime ||
									typeof duration !== "number" ||
									!Number.isSafeInteger(duration) ||
									duration < 0 ||
									Math.abs(duration - (finished - started)) >
										MAX_DURATION_SAMPLING_SKEW_MS
								)
									fail("CUSTOM_CAPACITY_MODEL_FACT_INVALID");
							}
							modelFacts.push(event);
						}
					} else if (event.type === "text") {
						reply += event.payload.delta;
						if (Buffer.byteLength(reply) > 4_096)
							fail("CUSTOM_CAPACITY_EVENT_LIMIT");
					} else if (event.type === "status") {
						if (!["running", "completed"].includes(event.payload.status))
							fail("CUSTOM_CAPACITY_EXECUTION_UNCONFIRMED");
					} else if (event.type === "completed") {
						if (
							event.payload.status !== "completed" ||
							modelFacts.length !== 2 ||
							reply.trim() !== options.expectedReply
						)
							fail("CUSTOM_CAPACITY_COMPLETION_INVALID");
						completedAt = event.occurredAt;
					} else if (event.type !== "reasoning")
						fail("CUSTOM_CAPACITY_UNEXPECTED_EVENT");
					await persist(event.cursor);
					const ack = {
						...boundContext,
						requestId: randomUUID(),
						consumer: "platform_worker_persistence" as const,
						confirmedCursor: event.cursor,
					};
					try {
						const result = await bounded(
							client.acknowledgeEvents(
								{ ...ack, grant: sign(ack, authority, "events.ack") },
								signal,
							),
							signal,
						);
						check();
						if (
							result.executionId !== executionId ||
							result.confirmedCursor !== event.cursor
						)
							fail("CUSTOM_CAPACITY_ACK_FAILED");
					} catch {
						check();
						fail("CUSTOM_CAPACITY_ACK_FAILED");
					}
					cursor = event.cursor;
					if (completedAt)
						return {
							executionId,
							hostSessionRef,
							submittedAt,
							completedAt,
							replyMatched: true as const,
							replySha256: hash(reply),
							modelFacts,
							negativeChecks,
						};
				}
			} catch (error) {
				check();
				if (byteLimitExceeded) fail("CUSTOM_CAPACITY_EVENT_LIMIT");
				if (error instanceof CustomCapacityRuntimeError) throw error;
				const code = errorCode(error);
				if (
					!streamSignal.aborted &&
					code !== "RUNTIME_UNAVAILABLE" &&
					code !== "RUNTIME_GRANT_EXPIRED" &&
					!(code === "RUNTIME_GRANT_INVALID" && now() >= issuedAt + 30_000)
				)
					fail("CUSTOM_CAPACITY_EVENT_INVALID");
			} finally {
				clearTimeout(timer);
				streamAbort.abort();
			}
			await bounded(
				new Promise<void>((resolve) => setTimeout(resolve, 50)),
				signal,
			);
		}
		fail("CUSTOM_CAPACITY_READ_LIMIT");
	} catch (error) {
		if (options.signal.aborted) fail("CUSTOM_CAPACITY_DEADLINE");
		if (byteLimitExceeded) fail("CUSTOM_CAPACITY_EVENT_LIMIT");
		if (error instanceof CustomCapacityRuntimeError) throw error;
		fail("CUSTOM_CAPACITY_RUNTIME_REJECTED");
	} finally {
		lifetime.abort();
	}
}
