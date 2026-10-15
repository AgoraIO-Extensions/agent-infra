import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";

export interface PlatformWorkerNativeMetadataGatewayAppV1 {
	fetch(request: Request): Promise<Response>;
}

export interface PlatformWorkerNativeMetadataGatewayServerOptionsV1 {
	readonly app: PlatformWorkerNativeMetadataGatewayAppV1;
	readonly port?: number;
	readonly hostname?: string;
	readonly close?: () => Promise<void>;
}

/** Compose the native metadata and model-directory apps behind one Worker listener. */
export function composePlatformWorkerInternalGatewayServerOptionsV1(options: {
	readonly nativeMetadata?: PlatformWorkerInternalGatewayServerOptionsV1;
	readonly modelDirectory?: PlatformWorkerInternalGatewayServerOptionsV1;
	readonly savedKeyCandidates?: PlatformWorkerInternalGatewayServerOptionsV1;
}): PlatformWorkerInternalGatewayServerOptionsV1 | undefined {
	const nativeMetadata = options.nativeMetadata;
	const modelDirectory = options.modelDirectory;
	const savedKeyCandidates = options.savedKeyCandidates;
	if (!nativeMetadata && !modelDirectory && !savedKeyCandidates)
		return undefined;
	const ports = [
		nativeMetadata?.port,
		modelDirectory?.port,
		savedKeyCandidates?.port,
	].filter((port): port is number => port !== undefined);
	if (new Set(ports).size > 1)
		throw new Error("PLATFORM_WORKER_INTERNAL_GATEWAY_PORT_MISMATCH");
	const hostnames = [
		nativeMetadata?.hostname,
		modelDirectory?.hostname,
		savedKeyCandidates?.hostname,
	].filter((hostname): hostname is string => hostname !== undefined);
	if (new Set(hostnames).size > 1)
		throw new Error("PLATFORM_WORKER_INTERNAL_GATEWAY_HOSTNAME_MISMATCH");
	const close = async () => {
		const results = await Promise.allSettled(
			[nativeMetadata, modelDirectory, savedKeyCandidates]
				.map((gateway) =>
					gateway?.close
						? Promise.resolve().then(() => gateway.close?.())
						: undefined,
				)
				.filter((result): result is Promise<void> => result !== undefined),
		);
		if (results.some((result) => result.status === "rejected"))
			throw new Error("PLATFORM_WORKER_INTERNAL_GATEWAY_CLOSE_FAILED");
	};
	return {
		app: {
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (
					pathname === "/internal/worker/v1/saved-key-candidates" &&
					savedKeyCandidates
				)
					return savedKeyCandidates.app.fetch(request);
				if (
					pathname === "/internal/worker/v1/model-directory" &&
					modelDirectory
				)
					return modelDirectory.app.fetch(request);
				if (nativeMetadata) return nativeMetadata.app.fetch(request);
				return new Response(null, { status: 404 });
			},
		},
		...(modelDirectory?.port !== undefined
			? { port: modelDirectory.port }
			: savedKeyCandidates?.port !== undefined
				? { port: savedKeyCandidates.port }
				: nativeMetadata?.port !== undefined
					? { port: nativeMetadata.port }
					: {}),
		...(modelDirectory?.hostname !== undefined
			? { hostname: modelDirectory.hostname }
			: savedKeyCandidates?.hostname !== undefined
				? { hostname: savedKeyCandidates.hostname }
				: nativeMetadata?.hostname !== undefined
					? { hostname: nativeMetadata.hostname }
					: {}),
		close,
	};
}

function headers(input: IncomingMessage) {
	const result = new Headers();
	for (const [name, value] of Object.entries(input.headers)) {
		if (value === undefined) continue;
		result.set(name, Array.isArray(value) ? value.join(", ") : value);
	}
	return result;
}

async function respond(response: ServerResponse, value: Response) {
	response.statusCode = value.status;
	value.headers.forEach((header, name) => {
		response.setHeader(name, header);
	});
	if (!value.body) {
		response.end();
		return;
	}
	const reader = value.body.getReader();
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			if (response.destroyed) throw new Error("Response connection closed");
			if (!response.write(Buffer.from(next.value))) {
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => {
						response.off("drain", onDrain);
						response.off("close", onClose);
						response.off("error", onError);
					};
					const onDrain = () => {
						cleanup();
						resolve();
					};
					const onClose = () => {
						cleanup();
						reject(new Error("Response connection closed"));
					};
					const onError = (error: Error) => {
						cleanup();
						reject(error);
					};
					response.once("drain", onDrain);
					response.once("close", onClose);
					response.once("error", onError);
					if (response.destroyed) onClose();
				});
			}
		}
		response.end();
	} finally {
		reader.releaseLock();
	}
}

async function handle(
	request: IncomingMessage,
	response: ServerResponse,
	app: PlatformWorkerNativeMetadataGatewayAppV1,
) {
	try {
		const host = request.headers.host ?? "127.0.0.1";
		const method = request.method ?? "GET";
		const init: RequestInit & { duplex: "half" } = {
			method,
			headers: headers(request),
			duplex: "half",
			...(method === "GET" || method === "HEAD" ? {} : { body: request }),
		};
		const value = await app.fetch(
			new Request(`http://${host}${request.url ?? "/"}`, init),
		);
		await respond(response, value);
	} catch {
		if (response.headersSent) response.destroy();
		else {
			response.statusCode = 500;
			response.end();
		}
	}
}

/** Start the optional Worker internal gateway without changing the default Worker process. */
export function startPlatformWorkerNativeMetadataGatewayServerV1(
	options: PlatformWorkerNativeMetadataGatewayServerOptionsV1,
) {
	if (typeof options.app?.fetch !== "function")
		throw new TypeError(
			"Platform Worker native metadata gateway app is invalid",
		);
	if (
		options.port !== undefined &&
		(!Number.isInteger(options.port) ||
			options.port < 0 ||
			options.port > 65_535)
	)
		throw new TypeError(
			"Platform Worker native metadata gateway port is invalid",
		);
	const server: Server = createServer((request, response) => {
		void handle(request, response, options.app);
	});
	server.headersTimeout = 15_000;
	server.requestTimeout = 15_000;
	server.listen(options.port ?? 3_004, options.hostname);
	return {
		server,
		stop() {
			return new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (
						!error ||
						(error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
					)
						void Promise.resolve()
							.then(() => options.close?.())
							.then(resolve, reject);
					else reject(error);
				});
			});
		},
	};
}

/** Generic alias for additional authenticated Worker internal gateways. */
export type PlatformWorkerInternalGatewayAppV1 =
	PlatformWorkerNativeMetadataGatewayAppV1;
export type PlatformWorkerInternalGatewayServerOptionsV1 =
	PlatformWorkerNativeMetadataGatewayServerOptionsV1;
export const startPlatformWorkerInternalGatewayServerV1 =
	startPlatformWorkerNativeMetadataGatewayServerV1;
