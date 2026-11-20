import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import {
	type CodexExecutorDrainEvidenceV1,
	CodexExecutorDrainJournalV1,
	type CodexSessionExecutorAdmissionV1,
	type ExecutorIdentityV1,
	executorControlRequestV1,
	executorRunnerControlOriginV1,
	signExecutorControlV1,
	verifyExecutorControlV1,
} from "@agent-infra/agent-runtime";

function invalid(): never {
	throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
}

export async function openExecutorDrainHostV1(
	admission: CodexSessionExecutorAdmissionV1,
	identity: ExecutorIdentityV1,
	directory: string,
): Promise<CodexSessionExecutorAdmissionV1> {
	const { binding, epoch } = admission;
	const authority = {
		epoch,
		resourceFence: binding.resourceFence,
		generation: binding.sessionGeneration,
	};
	const call = (path: string, input: Record<string, unknown>) =>
		executorControlRequestV1(identity, executorRunnerControlOriginV1, path, {
			...input,
			...authority,
		});
	const verified = (await call("/control/status", {})) as { epoch?: string };
	if (verified.epoch !== epoch) return invalid();

	let active:
		| {
				executionId: string;
				endpoint: string;
				protocolSession: string;
				journal: CodexExecutorDrainJournalV1;
				stopAuthorization?: { fence: number; expiresAt: number };
				terminalReported?: boolean;
		  }
		| undefined;
	const nonces = new Map<string, number>();
	const server = createServer((request, response) => {
		const path = request.url;
		if (
			request.method !== "POST" ||
			(path !== "/control/register" && path !== "/control/start-rejected")
		) {
			response.writeHead(404).end();
			return;
		}
		void (async () => {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				const item = Buffer.from(chunk);
				size += item.length;
				if (size > 16_384) return invalid();
				chunks.push(item);
			}
			const packet = verifyExecutorControlV1(
				identity,
				path,
				JSON.parse(Buffer.concat(chunks).toString("utf8")),
			);
			const target = active;
			if (
				!packet ||
				!target ||
				!packet.contents ||
				typeof packet.contents !== "object"
			)
				return invalid();
			for (const [nonce, expiry] of nonces) {
				if (expiry <= Date.now()) nonces.delete(nonce);
			}
			if (nonces.size >= 4_096 || nonces.has(packet.requestId))
				return invalid();
			nonces.set(packet.requestId, packet.deadline);
			const value = packet.contents as Record<string, unknown>;
			if (
				value.executionId !== target.executionId ||
				value.protocolSession !== target.protocolSession ||
				value.epoch !== epoch ||
				value.generation !== authority.generation ||
				value.resourceFence !== authority.resourceFence ||
				typeof value.handle !== "string"
			)
				return invalid();
			const attempt = {
				handle: value.handle,
				protocolSession: target.protocolSession,
			};
			const contents =
				path === "/control/register"
					? { admitted: await target.journal.admit(attempt) }
					: {
							rejection: await target.journal.rejectStart(
								attempt,
								value.code as number,
								value.occurredAt as number,
							),
						};
			const result = signExecutorControlV1(
				identity,
				`${path}/result`,
				contents,
				packet.requestId,
				packet.deadline,
			);
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify(result));
		})().catch(() => response.writeHead(503).end());
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(8069, "127.0.0.1", resolve);
	});
	const naturalStop = (executionId: string) => ({
		stopRequestId: `completed:${executionId}`,
		stopFence: 1,
		natural: true as const,
	});
	return {
		...admission,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await active?.journal.close();
			await admission.close();
		},
		drain: {
			async arm(executionId) {
				if (active?.executionId === executionId) return;
				if (active && !active.journal.confirmed()) return invalid();
				const result = (await call("/control/attach", { executionId })) as {
					endpoint?: string;
					protocolSession?: string;
				};
				if (
					!result.endpoint ||
					!/^ws:\/\/127\.0\.0\.1:8068\/native\/[a-f0-9-]{36}$/.test(
						result.endpoint,
					) ||
					!result.protocolSession
				)
					return invalid();
				await active?.journal.close();
				const journal = await CodexExecutorDrainJournalV1.open(
					join(
						directory,
						"executor-drain",
						`${createHash("sha256").update(executionId).digest("hex")}.json`,
					),
					{ ...authority, podUid: identity.podUid, executionId },
				);
				active = {
					executionId,
					endpoint: result.endpoint,
					protocolSession: result.protocolSession,
					journal,
				};
			},
			async bindNativeTurn(executionId, nativeTurnId) {
				if (!active || active.executionId !== executionId) return invalid();
				await active.journal.bindNativeTurn(nativeTurnId);
			},
			endpoint() {
				return active?.endpoint ?? invalid();
			},
			async sealStop(executionId, stopRequestId, stopFence, authorizedUntil) {
				const target = active;
				if (!target || target.executionId !== executionId) return invalid();
				if (target.journal.confirmed()) return;
				const stop = { stopRequestId, stopFence };
				if (
					authorizedUntil <= Date.now() ||
					authorizedUntil > Date.now() + 60_000
				)
					return invalid();
				await target.journal.seal(stop);
				target.stopAuthorization = {
					fence: stopFence,
					expiresAt: authorizedUntil,
				};
			},
			async confirm(executionId) {
				const target = active;
				if (!target || target.executionId !== executionId) return false;
				if (target.journal.confirmed()) return true;
				try {
					const stop = target.journal.sealedStop() ?? naturalStop(executionId);
					const authorization = target.stopAuthorization;
					if (
						!stop.natural &&
						(!authorization ||
							authorization.fence !== stop.stopFence ||
							authorization.expiresAt <= Date.now())
					)
						return false;
					const inventory = await target.journal.seal(stop);
					const result = (await call("/control/drain", {
						...stop,
						...inventory,
						executionId,
						terminate: stop.natural !== true,
						...(stop.natural
							? {}
							: { authorizedUntil: authorization?.expiresAt }),
					})) as Record<string, unknown>;
					if (
						result.epoch !== epoch ||
						result.digest !== inventory.digest ||
						result.stopRequestId !== stop.stopRequestId ||
						result.stopFence !== stop.stopFence ||
						!Array.isArray(result.groups) ||
						!(await target.journal.confirm(stop, inventory.digest, {
							verifiedAt: Date.now(),
							groups: result.groups as CodexExecutorDrainEvidenceV1["groups"],
							...(result.rejectedStarts === undefined
								? {}
								: {
										rejectedStarts: result.rejectedStarts as NonNullable<
											CodexExecutorDrainEvidenceV1["rejectedStarts"]
										>,
									}),
						}))
					)
						return false;
					const evidence = target.journal.evidence();
					if (evidence && !evidence.natural) {
						process.stdout.write(
							`${JSON.stringify({ schemaVersion: 1, code: "CODEX_EXECUTOR_DRAIN_VERIFIED", ...evidence })}\n`,
						);
					}
					return true;
				} catch {
					return false;
				}
			},
			reportTerminal(executionId, occurredAt) {
				const target = active;
				if (
					!target ||
					target.executionId !== executionId ||
					target.terminalReported
				)
					return;
				const evidence = target.journal.evidence();
				if (!evidence || evidence.natural) return;
				const {
					podUid,
					stopRequestId,
					generation,
					resourceFence,
					epoch,
					stopFence,
					digest,
				} = evidence;
				target.terminalReported = true;
				process.stdout.write(
					`${JSON.stringify({
						schemaVersion: 1,
						code: "CODEX_EXECUTOR_TERMINAL_COMMITTED",
						podUid,
						executionId,
						stopRequestId,
						generation,
						resourceFence,
						epoch,
						stopFence,
						digest,
						occurredAt: Date.parse(occurredAt),
					})}\n`,
				);
			},
			proven: (executionId) =>
				active?.executionId === executionId && active.journal.confirmed(),
		},
	};
}
