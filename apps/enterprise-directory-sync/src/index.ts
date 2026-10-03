import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { pathToFileURL } from "node:url";
import {
	createWeComSource,
	DirectorySyncError,
	nextSyncDelay,
} from "@agent-infra/enterprise-directory";
import { createPostgresDirectoryStore } from "@agent-infra/enterprise-directory-store";
import { serve } from "@hono/node-server";
import { createDirectoryService } from "./service.js";

const RETRY_MS = 5 * 60_000;
type SyncResult = Awaited<
	ReturnType<ReturnType<typeof createDirectoryService>["syncOnce"]>
>;

export function syncLogRecord(result: SyncResult, durationMs: number) {
	return {
		service: "enterprise-directory-sync",
		event:
			result.status === "published"
				? "snapshot_published"
				: "snapshot_superseded",
		...(result.status === "published"
			? {
					revision: result.revision,
					fetchedAt: result.fetchedAt,
					validUntil: result.validUntil,
					...result.summary,
				}
			: {}),
		durationMs,
	};
}

export function syncFailureLogRecord(error: unknown, durationMs: number) {
	return {
		service: "enterprise-directory-sync",
		event: "snapshot_sync_failed",
		reason: error instanceof DirectorySyncError ? error.reason : "unexpected",
		durationMs,
	};
}

function required(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export async function startDirectorySync() {
	const rootDepartmentId = Number(required("DIRECTORY_ROOT_DEPARTMENT_ID"));
	if (!Number.isSafeInteger(rootDepartmentId) || rootDepartmentId < 1) {
		throw new Error("DIRECTORY_ROOT_DEPARTMENT_ID is invalid");
	}
	const port = Number(process.env.PORT ?? "3004");
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT is invalid");
	}
	const readToken = (
		await readFile(required("DIRECTORY_READ_TOKEN_FILE"), "utf8")
	).trim();
	const corpSecret = (
		await readFile(required("WECOM_CORP_SECRET_FILE"), "utf8")
	).trim();
	const [key, cert] = await Promise.all([
		readFile(required("DIRECTORY_TLS_KEY_FILE")),
		readFile(required("DIRECTORY_TLS_CERT_FILE")),
	]);
	if (!readToken || !corpSecret)
		throw new Error("Directory credentials are invalid");
	const store = createPostgresDirectoryStore(
		required("DIRECTORY_DATABASE_URL"),
	);
	const service = createDirectoryService({
		store,
		source: createWeComSource({
			corpId: required("WECOM_CORP_ID"),
			corpSecret,
			rootDepartmentId,
		}),
		readToken,
		rootDepartmentId,
	});
	const server = serve({
		fetch: service.app.fetch,
		port,
		createServer,
		serverOptions: { key, cert },
	});
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (delay: number) => {
		timer = setTimeout(async () => {
			const startedAt = Date.now();
			try {
				const result = await service.syncOnce();
				console.info(
					JSON.stringify(syncLogRecord(result, Date.now() - startedAt)),
				);
				if (!stopped)
					schedule(
						result.status === "published"
							? nextSyncDelay(result.validUntil, Date.now())
							: RETRY_MS,
					);
			} catch (error) {
				console.error(
					JSON.stringify(syncFailureLogRecord(error, Date.now() - startedAt)),
				);
				if (!stopped) schedule(RETRY_MS);
			}
		}, delay);
	};
	schedule(0);
	return {
		server,
		async close() {
			stopped = true;
			if (timer) clearTimeout(timer);
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await store.close();
		},
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	void startDirectorySync()
		.then((running) => {
			process.once("SIGTERM", () => void running.close());
			process.once("SIGINT", () => void running.close());
		})
		.catch(() => {
			console.error(
				JSON.stringify({
					service: "enterprise-directory-sync",
					event: "startup_failed",
				}),
			);
			process.exitCode = 1;
		});
}
