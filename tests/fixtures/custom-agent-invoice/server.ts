import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface InvoiceConfiguration {
	appToken: string;
	modelApiKey: string;
	modelBaseUrl: string;
	modelId: string;
	dataDirectory: string;
	version: string;
}

const requestLimit = 16_384;
const responseLimit = 65_536;
const digest = (value: string) => createHash("sha256").update(value).digest();

function requestBody(request: IncomingMessage): Promise<unknown> {
	return new Promise((accept, reject) => {
		let bytes = 0;
		const parts: Buffer[] = [];
		request.on("data", (part: Buffer) => {
			bytes += part.length;
			if (bytes > requestLimit) {
				parts.length = 0;
				reject(new Error("BODY_TOO_LARGE"));
			} else parts.push(part);
		});
		request.on("error", reject);
		request.on("end", () => {
			if (bytes > requestLimit) return;
			try {
				accept(JSON.parse(Buffer.concat(parts).toString("utf8")));
			} catch {
				reject(new Error("INVALID_INPUT"));
			}
		});
	});
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invoiceInput(value: unknown) {
	const number = (input: unknown, maximum: number) =>
		typeof input === "number" &&
		Number.isFinite(input) &&
		input >= 0 &&
		input <= maximum;
	if (
		!object(value) ||
		Object.keys(value).sort().join() !== "discountPercent,items,taxPercent" ||
		!number(value.discountPercent, 100) ||
		!number(value.taxPercent, 100) ||
		!Array.isArray(value.items) ||
		value.items.length < 1 ||
		value.items.length > 50 ||
		!value.items.every(
			(item) =>
				object(item) &&
				Object.keys(item).sort().join() === "quantity,unitPrice" &&
				number(item.quantity, 1_000_000) &&
				Number.isInteger(item.quantity) &&
				Number(item.quantity) > 0 &&
				number(item.unitPrice, 1_000_000),
		)
	)
		throw new Error("INVALID_INPUT");
	return value;
}

async function modelText(response: Response) {
	if (
		!response.ok ||
		!response.headers.get("content-type")?.includes("application/json") ||
		!response.body
	) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error("MODEL_UNAVAILABLE");
	}
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.length;
			if (bytes > responseLimit) throw new Error("MODEL_UNAVAILABLE");
			parts.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
	if (!Array.isArray(body.content)) throw new Error("MODEL_UNAVAILABLE");
	const text = body.content
		.filter(
			(block: { type?: string; text?: unknown }) =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block: { text: string }) => block.text)
		.join("\n");
	if (!text.trim()) throw new Error("MODEL_UNAVAILABLE");
	return text;
}

export function createInvoiceServer(configuration: InvoiceConfiguration) {
	const config = { ...configuration };
	const endpoint = new URL(config.modelBaseUrl);
	if (
		!/^[\x21-\x7e]{16,8192}$/.test(config.appToken) ||
		!/^[\x21-\x7e]{16,8192}$/.test(config.modelApiKey) ||
		!isAbsolute(config.dataDirectory) ||
		!/^[A-Za-z0-9._/-]{1,128}$/.test(config.modelId) ||
		!/^[A-Za-z0-9._-]{1,64}$/.test(config.version) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		(endpoint.protocol !== "https:" &&
			!(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"))
	)
		throw new Error("CONFIGURATION_INVALID");
	endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/v1/messages`;
	const expectedToken = digest(`Bearer ${config.appToken}`);
	return createServer(
		{ requestTimeout: 10_000, headersTimeout: 10_000 },
		async (request, response) => {
			response.setHeader("Cache-Control", "no-store");
			const send = (status: number, body?: unknown) => {
				response.statusCode = status;
				if (body !== undefined)
					response.setHeader("Content-Type", "application/json");
				response.end(body === undefined ? undefined : JSON.stringify(body));
			};
			if (request.method === "GET" && request.url === "/healthz")
				return send(200, { status: "ready", version: config.version });
			if (!request.headers.authorization) return send(401);
			if (
				!timingSafeEqual(digest(request.headers.authorization), expectedToken)
			)
				return send(403);
			try {
				if (request.method === "POST" && request.url === "/api/invoices") {
					if (
						request.headers["content-type"]?.split(";", 1)[0] !==
						"application/json"
					)
						return send(415);
					const input = invoiceInput(await requestBody(request));
					const model = await fetch(endpoint, {
						method: "POST",
						redirect: "error",
						signal: AbortSignal.timeout(30_000),
						headers: {
							"Content-Type": "application/json",
							"x-api-key": config.modelApiKey,
							"anthropic-version": "2023-06-01",
						},
						body: JSON.stringify({
							model: config.modelId,
							max_tokens: 1024,
							messages: [
								{
									role: "user",
									content: `Calculate this invoice. Sum quantity times unitPrice. Apply discountPercent to subtotal, round discount to two decimals, then apply taxPercent to discounted subtotal and round tax to two decimals. Show subtotal, discount, tax, and final total; finish with TOTAL=<amount>. Input: ${JSON.stringify(input)}`,
								},
							],
						}),
					});
					const result = {
						id: randomUUID(),
						result: await modelText(model),
						version: config.version,
					};
					const serialized = JSON.stringify(result);
					if (Buffer.byteLength(serialized) > responseLimit)
						throw new Error("MODEL_UNAVAILABLE");
					await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
					await writeFile(
						join(config.dataDirectory, `${result.id}.json`),
						serialized,
						{ flag: "wx", mode: 0o600 },
					);
					return send(201, result);
				}
				const match =
					/^\/api\/invoices\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
						request.url ?? "",
					);
				if (request.method === "GET" && match) {
					const file = await open(
						join(config.dataDirectory, `${match[1]}.json`),
						constants.O_RDONLY | constants.O_NOFOLLOW,
					);
					try {
						const stat = await file.stat();
						if (!stat.isFile() || stat.size > responseLimit)
							throw new Error("STORAGE_UNAVAILABLE");
						return send(200, JSON.parse(await file.readFile("utf8")));
					} finally {
						await file.close();
					}
				}
				return send(404);
			} catch (error) {
				if (error instanceof Error && error.message === "BODY_TOO_LARGE")
					return send(413);
				if (error instanceof Error && error.message === "INVALID_INPUT")
					return send(400);
				if (object(error) && error.code === "ENOENT") return send(404);
				return send(502, { code: "INVOICE_UNAVAILABLE" });
			}
		},
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		const required = (name: string) => {
			const value = process.env[name];
			if (!value) throw new Error("CONFIGURATION_INVALID");
			return value;
		};
		const app = createInvoiceServer({
			appToken: required("APP_TOKEN"),
			modelApiKey: required("MODEL_API_KEY"),
			modelBaseUrl: required("MODEL_BASE_URL"),
			modelId: required("MODEL_ID"),
			dataDirectory: required("DATA_DIR"),
			version: required("APP_VERSION"),
		});
		app.listen(8080, "0.0.0.0");
	} catch {
		process.stderr.write("INVOICE_CONFIGURATION_INVALID\n");
		process.exitCode = 1;
	}
}
