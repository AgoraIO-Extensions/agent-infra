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
			response.write(Buffer.from(next.value));
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
						resolve();
					else reject(error);
				});
			});
		},
	};
}
