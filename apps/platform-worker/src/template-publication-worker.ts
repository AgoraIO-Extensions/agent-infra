import { randomUUID } from "node:crypto";
import {
	TemplatePublicationReadyV1Schema,
	type TemplatePublicationStatusV1,
	TemplatePublicationStatusV1Schema,
} from "@agent-infra/contracts/pilot";
import type { StandardTemplateModelBindingV1 } from "@agent-infra/model-catalog";
import { createPostgresOutboxStore } from "@agent-infra/platform-store";

export interface WorkerTemplatePublicationV1 {
	readonly publicationId: string;
	readonly catalogRevision: string;
	readonly templateId: string;
	readonly targetImageDigest: string;
	readonly origin: string;
	/** Deployment-authenticated confidential transport; signs each actual method/path/body afresh. */
	readonly request: (request: Request) => Promise<Response>;
}

export function createWorkerTemplatePublicationV1(input: {
	readonly databaseUrl: string;
	readonly templateModelBindings: readonly StandardTemplateModelBindingV1[];
	readonly publications: readonly WorkerTemplatePublicationV1[];
	readonly log?: (message: string) => void;
}) {
	if (
		input.publications.length > 64 ||
		new Set(input.publications.map((p) => p.publicationId)).size !==
			input.publications.length
	)
		throw new Error("WORKER_TEMPLATE_PUBLICATION_INVALID");
	const publications = input.publications.map((publication) => {
		const url = new URL(publication.origin);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			typeof publication.request !== "function" ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(publication.publicationId) ||
			!input.templateModelBindings.some(
				(b) =>
					b.templateId === publication.templateId &&
					b.imageDigest === publication.targetImageDigest,
			)
		)
			throw new Error("WORKER_TEMPLATE_PUBLICATION_INVALID");
		return {
			...publication,
			ready: TemplatePublicationReadyV1Schema.parse({
				schemaVersion: 1,
				catalogRevision: publication.catalogRevision,
				templateId: publication.templateId,
				targetImageDigest: publication.targetImageDigest,
			}),
		};
	});
	const outbox = createPostgresOutboxStore(input);
	const leaseOwner = `template-publisher-${randomUUID()}`;
	let stopped = false;
	let running: Promise<void> | undefined;
	const active = new Set<AbortController>();
	const done = new Set<string>();
	const ready = new Set<string>();
	const nextPoll = new Map<string, number>();
	async function call(
		publication: WorkerTemplatePublicationV1,
		command: string,
		body?: unknown,
	): Promise<TemplatePublicationStatusV1> {
		const controller = new AbortController();
		active.add(controller);
		const timeout = setTimeout(() => controller.abort(), 45_000);
		try {
			return await Promise.race([
				(async () => {
					const response = await publication.request(
						new Request(
							new URL(
								`/internal/ops/standard-template-releases/${publication.publicationId}/${command}`,
								publication.origin,
							),
							{
								method: body === undefined ? "GET" : "POST",
								headers:
									body === undefined
										? {}
										: { "content-type": "application/json" },
								body: body === undefined ? undefined : JSON.stringify(body),
								signal: controller.signal,
							},
						),
					);
					if (response.status !== 202 && response.status !== 200)
						throw new Error("TEMPLATE_PUBLICATION_UNAVAILABLE");
					const reader = response.body?.getReader();
					if (!reader) throw new Error("TEMPLATE_PUBLICATION_UNAVAILABLE");
					const chunks: Uint8Array[] = [];
					let length = 0;
					for (;;) {
						const part = await reader.read();
						if (part.done) break;
						length += part.value.length;
						if (length > 1_048_576) {
							await reader.cancel();
							throw new Error("TEMPLATE_PUBLICATION_UNAVAILABLE");
						}
						chunks.push(part.value);
					}
					const result = TemplatePublicationStatusV1Schema.parse(
						JSON.parse(Buffer.concat(chunks).toString("utf8")),
					);
					if (result.publicationId !== publication.publicationId)
						throw new Error("TEMPLATE_PUBLICATION_UNAVAILABLE");
					return result;
				})(),
				new Promise<never>((_, reject) =>
					controller.signal.addEventListener(
						"abort",
						() => reject(new Error("TEMPLATE_PUBLICATION_INTERRUPTED")),
						{ once: true },
					),
				),
			]);
		} finally {
			clearTimeout(timeout);
			active.delete(controller);
			controller.abort();
		}
	}
	async function poll() {
		for (const publication of publications) {
			if (stopped) return;
			if (
				done.has(publication.publicationId) ||
				(nextPoll.get(publication.publicationId) ?? 0) > Date.now()
			)
				continue;
			try {
				const status = await call(publication, "status-automatic");
				if (status.status === "prepared") {
					if (!ready.has(publication.publicationId)) {
						await call(publication, "worker-ready", {
							schemaVersion: 1,
							catalogRevision: publication.catalogRevision,
							templateId: publication.templateId,
							targetImageDigest: publication.targetImageDigest,
						});
						ready.add(publication.publicationId);
					}
					continue;
				}
				if (["completed", "revoked", "superseded"].includes(status.status)) {
					done.add(publication.publicationId);
					continue;
				}
				if (!["active", "partial"].includes(status.status)) continue;
				const itemId = `publication-${publication.publicationId}`;
				const claim = await outbox.claim({
					itemId,
					leaseOwner,
					leaseDurationMs: 60_000,
				});
				if (!claim) continue;
				const owned = {
					itemId,
					leaseOwner,
					deliveryFence: claim.deliveryFence,
				};
				const renewal = setInterval(() => {
					void outbox
						.renew({ ...owned, leaseDurationMs: 60_000 })
						.catch(() => {});
				}, 10_000);
				try {
					const result = await call(publication, "run-automatic", {
						schemaVersion: 1,
						itemId,
						leaseOwner,
						deliveryFence: String(claim.deliveryFence),
					});
					if (result.status === "completed") {
						await outbox.markSucceeded(owned);
						done.add(publication.publicationId);
					} else
						await outbox.scheduleRetry({
							...owned,
							retryDelayMs: 30_000,
							errorCode: "TEMPLATE_PUBLICATION_PENDING",
						});
				} catch {
					await outbox.scheduleRetry({
						...owned,
						retryDelayMs: 30_000,
						errorCode: "TEMPLATE_PUBLICATION_UNKNOWN",
					});
				} finally {
					clearInterval(renewal);
				}
			} catch {
				nextPoll.set(publication.publicationId, Date.now() + 30_000);
				try {
					input.log?.(
						JSON.stringify({
							service: "platform-worker",
							code: "TEMPLATE_PUBLICATION_UNAVAILABLE",
							publicationId: publication.publicationId,
						}),
					);
				} catch {}
			}
		}
	}
	return {
		runOnce: () => {
			if (stopped) return Promise.resolve();
			running ??= poll().finally(() => {
				running = undefined;
			});
			return running;
		},
		async close() {
			stopped = true;
			for (const controller of active) controller.abort();
			await running?.catch(() => {});
			await outbox.close();
		},
	};
}
