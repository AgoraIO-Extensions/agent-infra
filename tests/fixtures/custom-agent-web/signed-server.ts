import { createPublicKey, verify } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import {
	runSnapshotBusiness,
	type SnapshotBusinessResult,
	snapshotBusinessInput,
	snapshotBusinessResult,
} from "./snapshot-business.ts";

export const ownEntryPage =
	'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>自定义应用</title></head><body><main><h1>自定义应用</h1><p>已通过应用身份验证</p><button id="check">读取服务状态</button><button id="events">接收流式状态</button><button id="socket">检查实时连接</button><button id="logout">退出登录</button><p id="result"></p></main><script src="/assets/protocols.js"></script><script>document.getElementById(\'check\').onclick=async()=>{const r=await fetch(\'/api/check\');if(r.ok)document.getElementById(\'result\').textContent=(await r.json()).message;};</script></body></html>';
export const ownEntryProtocolScript = `
let events, socket;
const result = document.getElementById('result');
document.getElementById('events').onclick = () => {
  events?.close();
  result.textContent = '等待流式状态';
  const current = new EventSource('/api/events');
  events = current;
  current.addEventListener('status', event => { if (events === current) result.textContent = JSON.parse(event.data).message; });
  current.addEventListener('complete', () => { current.close(); if (events === current) result.textContent = '流式状态完成'; });
  current.onerror = () => { current.close(); if (events === current) result.textContent = '流式连接失败'; };
};
document.getElementById('socket').onclick = () => {
  socket?.close();
  result.textContent = '等待实时连接';
  const url = new URL('/ws', location.href);
  url.protocol = 'wss:';
  const current = new WebSocket(url);
  socket = current;
  current.onopen = () => current.send('check');
  current.onmessage = event => { if (socket === current) result.textContent = JSON.parse(event.data).message; };
  current.onerror = () => { if (socket === current) result.textContent = '实时连接失败'; };
};
document.getElementById('logout').onclick = async () => {
  events?.close();
  socket?.close();
  const response = await fetch('/auth/logout', { method: 'POST' });
  if (response.ok) location.assign('/');
};
`;
const loginPage =
	"<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>登录自定义应用</title></head><body><form><label>应用访问凭证<input name=\"token\" type=\"password\" autocomplete=\"off\"></label><button>登录</button><p id=\"error\"></p></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:document.querySelector('input').value})});if(r.ok)location.assign('/app');else document.getElementById('error').textContent='无法登录';};</script></body></html>";
export const ownEntryResult = {
	status: "ready",
	message: "Hello from application service",
};

type Configuration = {
	issuer: string;
	audience: string;
	publicKey: string;
	role: "single" | "web" | "api";
	backend?: string;
	/** An in-process test may supply an isolated mounted-root substitute. */
	snapshotRoot?: string;
	basePath?: string;
};
type Identity = { status: 200; token: string } | { status: 401 | 403 };

export function createOwnEntryServer(configuration: Configuration) {
	const configuredBasePath = configuration.basePath ?? "/";
	const basePath = configuration.role === "api" ? "/" : configuredBasePath;
	if (basePath !== "/" && !/^\/a\/agent-[a-f0-9]{32}\/$/.test(basePath))
		throw new Error("OWN_ENTRY_BASE_PATH_INVALID");
	const cookieName =
		basePath === "/"
			? "__Host-custom-entry"
			: `__Secure-custom-entry-${basePath.split("/")[2]}`;
	const pageAt = (text: string) => {
		if (basePath === "/") return text;
		let result = text;
		for (const path of [
			"/auth/login",
			"/auth/logout",
			"/app",
			"/api/check",
			"/api/events",
			"/ws",
			"/assets/protocols.js",
			"/",
		]) {
			for (const quote of ["'", '"'])
				result = result.replaceAll(
					`${quote}${path}${quote}`,
					JSON.stringify(basePath + path.slice(1)),
				);
		}
		return result;
	};
	function applicationPath(pathname: string) {
		if (basePath === "/" || pathname === "/healthz") return pathname;
		return pathname.startsWith(basePath)
			? `/${pathname.slice(basePath.length)}`
			: undefined;
	}

	const key = createPublicKey(configuration.publicKey);
	if (
		key.asymmetricKeyType !== "ed25519" ||
		!configuration.issuer ||
		!configuration.audience
	)
		throw new Error("OWN_ENTRY_CONFIGURATION_INVALID");
	if (
		configuration.role === "web" &&
		(!configuration.backend ||
			!/^http:\/\/agent-[a-f0-9]{32}-api:3003$/u.test(configuration.backend))
	)
		throw new Error("OWN_ENTRY_BACKEND_INVALID");
	function identity(token: unknown): Identity {
		if (
			typeof token !== "string" ||
			token.length > 8192 ||
			!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
		)
			return { status: 401 };
		try {
			const [header, body, signature] = token.split(".");
			const algorithm = JSON.parse(
				Buffer.from(header, "base64url").toString("utf8"),
			);
			if (
				algorithm.alg !== "EdDSA" ||
				algorithm.typ !== "JWT" ||
				Object.keys(algorithm).length !== 2 ||
				!verify(
					null,
					Buffer.from(`${header}.${body}`),
					key,
					Buffer.from(signature, "base64url"),
				)
			)
				return { status: 401 };
			const claims = JSON.parse(
				Buffer.from(body, "base64url").toString("utf8"),
			);
			const now = Math.floor(Date.now() / 1000);
			if (
				claims.iss !== configuration.issuer ||
				claims.aud !== configuration.audience ||
				typeof claims.sub !== "string" ||
				!claims.sub ||
				!Number.isSafeInteger(claims.iat) ||
				!Number.isSafeInteger(claims.exp) ||
				claims.iat > now ||
				claims.exp <= now ||
				claims.exp - claims.iat > 3600 ||
				!Array.isArray(claims.permissions)
			)
				return { status: 401 };
			return claims.permissions.includes("web:read")
				? { status: 200, token }
				: { status: 403 };
		} catch {
			return { status: 401 };
		}
	}
	function credential(request: IncomingMessage): string | undefined {
		if (request.headers.authorization !== undefined)
			return /^Bearer ([A-Za-z0-9_.-]+)$/u.exec(
				request.headers.authorization,
			)?.[1];
		const cookies = (request.headers.cookie ?? "")
			.split(";")
			.map((value) => value.trim())
			.filter((value) => value.startsWith(`${cookieName}=`));
		return cookies.length === 1
			? cookies[0].slice(cookieName.length + 1)
			: undefined;
	}
	function send(
		response: ServerResponse,
		status: number,
		body = "",
		type = "text/plain",
	) {
		response.writeHead(status, {
			"content-type": type,
			"content-length": Buffer.byteLength(body),
			"cache-control": "no-store",
		});
		response.end(body);
	}
	async function serviceResult(token: string) {
		if (configuration.role !== "web") return ownEntryResult;
		const upstream = await fetch(`${configuration.backend}/api/check`, {
			headers: { authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		});
		if (upstream.status !== 200) return undefined;
		const result: unknown = await upstream.json();
		return JSON.stringify(result) === JSON.stringify(ownEntryResult)
			? ownEntryResult
			: undefined;
	}
	async function handle(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? "/", "http://application");
		const pathname = applicationPath(url.pathname);
		if (pathname === undefined) {
			send(response, 404);
			return;
		}
		if (request.method === "GET" && pathname === "/healthz") {
			send(response, 200, '{"status":"ready"}', "application/json");
			return;
		}
		if (
			request.method === "GET" &&
			pathname === "/" &&
			configuration.role !== "api"
		) {
			send(response, 200, pageAt(loginPage), "text/html; charset=utf-8");
			return;
		}
		if (
			request.method === "POST" &&
			pathname === "/auth/login" &&
			configuration.role !== "api"
		) {
			const origin = request.headers.origin;
			if (origin !== `https://${request.headers.host}`) {
				send(response, 403);
				return;
			}
			let bytes = "";
			for await (const part of request) {
				bytes += part.toString();
				if (Buffer.byteLength(bytes) > 8192) {
					send(response, 413);
					return;
				}
			}
			let token: unknown;
			try {
				token = JSON.parse(bytes).token;
			} catch {
				send(response, 400);
				return;
			}
			const authenticated = identity(token);
			if (authenticated.status !== 200) {
				send(response, authenticated.status);
				return;
			}
			response.setHeader(
				"set-cookie",
				`${cookieName}=${authenticated.token}; Path=${basePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
			);
			send(response, 204);
			return;
		}
		if (
			request.method === "POST" &&
			pathname === "/auth/logout" &&
			configuration.role !== "api"
		) {
			if (request.headers.origin !== `https://${request.headers.host}`) {
				send(response, 403);
				return;
			}
			request.resume();
			response.setHeader(
				"set-cookie",
				`${cookieName}=; Path=${basePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
			);
			send(response, 204);
			return;
		}
		if (request.method !== "GET") {
			send(response, 405);
			return;
		}
		const authenticated = identity(credential(request));
		if (authenticated.status !== 200) {
			send(response, authenticated.status);
			return;
		}
		if (pathname === "/app" && configuration.role !== "api") {
			send(response, 200, pageAt(ownEntryPage), "text/html; charset=utf-8");
			return;
		}
		if (pathname === "/assets/protocols.js" && configuration.role !== "api") {
			send(
				response,
				200,
				pageAt(ownEntryProtocolScript),
				"text/javascript; charset=utf-8",
			);
			return;
		}
		if (pathname === "/api/events") {
			const result = await serviceResult(authenticated.token);
			if (!result) {
				send(response, 502);
				return;
			}
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			});
			response.flushHeaders();
			response.write(
				`id: 1\nevent: status\ndata: ${JSON.stringify(result)}\n\n`,
			);
			const timer = setTimeout(() => {
				if (identity(authenticated.token).status !== 200) {
					response.destroy();
					return;
				}
				response.end(
					`id: 2\nevent: complete\ndata: ${JSON.stringify(result)}\n\n`,
				);
			}, 100);
			response.once("close", () => clearTimeout(timer));
			return;
		}
		if (pathname === "/api/snapshot-check") {
			let input: number;
			try {
				if (
					[...url.searchParams.keys()].some((name) => name !== "input") ||
					url.searchParams.getAll("input").length > 1
				)
					throw new Error();
				input = snapshotBusinessInput(url.searchParams.get("input"));
			} catch {
				send(response, 400);
				return;
			}
			let result: SnapshotBusinessResult;
			if (configuration.role === "web") {
				const upstream = await fetch(
					`${configuration.backend}/api/snapshot-check?input=${input}`,
					{
						headers: { authorization: `Bearer ${authenticated.token}` },
						redirect: "error",
						signal: AbortSignal.timeout(6000),
					},
				);
				if (upstream.status !== 200) {
					send(response, 502);
					return;
				}
				result = snapshotBusinessResult(await upstream.json(), input);
			} else {
				result = await runSnapshotBusiness(
					configuration.snapshotRoot ?? "/opt/agent/workspaces",
					input,
				);
			}
			send(response, 200, JSON.stringify(result), "application/json");
			return;
		}
		if (pathname === "/api/check") {
			const result = await serviceResult(authenticated.token);
			if (!result) {
				send(response, 502);
				return;
			}
			send(response, 200, JSON.stringify(result), "application/json");
			return;
		}
		send(response, 404);
	}
	const server = createServer((request, response) => {
		void handle(request, response).catch(() => {
			if (!response.headersSent) send(response, 503);
			else response.destroy();
		});
	});
	const sockets = new WebSocketServer({
		noServer: true,
		maxPayload: 4096,
		perMessageDeflate: false,
	});
	server.on("upgrade", (request, transport, head) => {
		transport.on("error", () => {});
		const reject = (status: 400 | 401 | 403 | 404 | 405) => {
			transport.end(
				`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
			);
		};
		if (request.method !== "GET") {
			reject(405);
			return;
		}
		let pathname: string | undefined;
		try {
			pathname = applicationPath(
				new URL(request.url ?? "/", "http://application").pathname,
			);
		} catch {
			reject(400);
			return;
		}
		if (pathname !== "/ws") {
			reject(404);
			return;
		}
		if (request.headers.origin !== `https://${request.headers.host}`) {
			reject(403);
			return;
		}
		const token = credential(request);
		const authenticated = identity(token);
		if (authenticated.status !== 200) {
			reject(authenticated.status);
			return;
		}
		sockets.handleUpgrade(request, transport, head, (socket) => {
			let responded = false;
			const timeout = setTimeout(() => socket.terminate(), 5000);
			timeout.unref();
			socket.once("close", () => clearTimeout(timeout));
			socket.on("error", () => {});
			socket.on("message", (data, binary) => {
				if (
					responded ||
					binary ||
					data.toString() !== "check" ||
					identity(token).status !== 200
				) {
					socket.close(1008);
					return;
				}
				responded = true;
				void serviceResult(authenticated.token)
					.then((result) => {
						if (!result || identity(token).status !== 200) {
							socket.close(1008);
							return;
						}
						socket.send(JSON.stringify(result), () => socket.close(1000));
					})
					.catch(() => socket.close(1011));
			});
		});
	});
	server.once("close", () => {
		for (const socket of sockets.clients) socket.terminate();
		sockets.close();
	});
	return server;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const role = process.env.CUSTOM_ENTRY_ROLE ?? "single";
		if (!["single", "web", "api"].includes(role)) throw new Error();
		const prefix = /^(agent-[a-f0-9]{32})-web-/u.exec(
			process.env.HOSTNAME ?? "",
		)?.[1];
		const server = createOwnEntryServer({
			issuer: process.env.CUSTOM_ENTRY_ISSUER ?? "",
			audience: process.env.CUSTOM_ENTRY_AUDIENCE ?? "",
			publicKey: process.env.CUSTOM_ENTRY_PUBLIC_KEY ?? "",
			role: role as Configuration["role"],
			basePath: process.env.AGENT_INFRA_PUBLIC_BASE_PATH,
			backend: prefix ? `http://${prefix}-api:3003` : undefined,
		});
		server.listen(3003, "0.0.0.0");
	} catch {
		process.stderr.write("OWN_ENTRY_CONFIGURATION_INVALID\n");
		process.exitCode = 1;
	}
}
