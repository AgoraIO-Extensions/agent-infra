import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import ssh2, { type Connection } from "ssh2";
import type { MaintenanceTerminalTransport } from "./http/maintenance-terminal.js";
import { attachMaintenanceTerminal } from "./maintenance-terminal-connection.js";

export interface SshMaintenanceScope {
	agentId: string;
	actorId: string;
}
export interface SshMaintenanceGrants {
	issue: (
		input: SshMaintenanceScope & { tokenDigest: string; expiresAt: Date },
	) => Promise<void>;
	redeem: (tokenDigest: string) => Promise<SshMaintenanceScope | null>;
	current: (scope: SshMaintenanceScope) => Promise<string | null>;
}
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

export function maintenanceSshEndpoint(
	config: {
		host: string;
		publicPort: number;
		listenPort: number;
		hostKey: Buffer;
	},
	grants: SshMaintenanceGrants,
	transport: MaintenanceTerminalTransport,
) {
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(config.host) ||
		!Number.isInteger(config.publicPort) ||
		config.publicPort < 1 ||
		config.publicPort > 65535 ||
		!Number.isInteger(config.listenPort) ||
		config.listenPort < 0 ||
		config.listenPort > 65535
	)
		throw new Error("Invalid maintenance SSH endpoint");
	const key = ssh2.utils.parseKey(config.hostKey);
	if (key instanceof Error || !key.isPrivateKey())
		throw new Error("Invalid maintenance SSH host key");
	const fingerprint =
		"SHA256:" +
		createHash("sha256")
			.update(key.getPublicSSH())
			.digest("base64")
			.replace(/=+$/, "");
	return {
		async issue(scope: SshMaintenanceScope) {
			const password = randomBytes(32).toString("base64url");
			const expiresAt = new Date(Date.now() + 120_000);
			await grants.issue({
				...scope,
				tokenDigest: digest(password),
				expiresAt,
			});
			return {
				command: `ssh -p ${config.publicPort} maintenance@${config.host}`,
				fingerprint,
				password,
				expiresAt: expiresAt.toISOString(),
			};
		},
		start(hostname?: string) {
			const clients = new Set<Connection>();
			const server = new ssh2.Server(
				{ hostKeys: [config.hostKey], banner: undefined },
				(client) => {
					clients.add(client);
					let scope: SshMaintenanceScope | null = null;
					let directory: string | null = null;
					let assigned = false;
					let connection:
						| ReturnType<typeof attachMaintenanceTerminal>
						| undefined;
					const deadline = setTimeout(() => client.end(), 15_000);
					client.on("authentication", (ctx) => {
						if (
							ctx.method !== "password" ||
							ctx.username !== "maintenance" ||
							!/^[A-Za-z0-9_-]{43}$/.test(ctx.password)
						) {
							ctx.reject(["password"]);
							return;
						}
						void (async () => {
							const binding = await grants.redeem(digest(ctx.password));
							const current = binding && (await grants.current(binding));
							if (!current) {
								ctx.reject(["password"]);
								return;
							}
							scope = binding;
							directory = current;
							ctx.accept();
						})().catch(() => ctx.reject(["password"]));
					});
					client.on("ready", () => {
						client.on("session", (accept, reject) => {
							if (assigned || !scope || !directory) {
								reject();
								return;
							}
							assigned = true;
							const bound = scope;
							const dir = directory;
							const session = accept();
							let size = { cols: 80, rows: 24 };
							const resize = (cols: number, rows: number) => {
								size = {
									cols: Math.max(2, Math.min(cols, 500)),
									rows: Math.max(1, Math.min(rows, 200)),
								};
							};
							session.on("pty", (ok, _reject, info) => {
								resize(info.cols, info.rows);
								ok?.();
							});
							session.on("window-change", (ok, _reject, info) => {
								resize(info.cols, info.rows);
								if (connection) connection.send(JSON.stringify(size));
								ok?.();
							});
							session.once("shell", (open) => {
								const channel = open();
								clearTimeout(deadline);
								channel.pause();
								try {
									connection = attachMaintenanceTerminal({
										connect: () => transport.connect(dir),
										authorized: async () =>
											(await grants.current(bound)) === dir,
										output: (data, binary) => {
											if (binary) {
												if (channel.writableLength > 262144)
													throw new Error("Slow SSH client");
												channel.write(data);
											} else if (data.toString() === "ready") {
												connection?.send(JSON.stringify(size));
												channel.resume();
											}
										},
										close: () => {
											channel.end();
											client.end();
										},
									});
								} catch {
									client.end();
									return;
								}
								channel.on("data", (data: Buffer) => {
									for (let i = 0; i < data.length; i += 16384)
										connection?.send(data.subarray(i, i + 16384));
								});
								channel.on("close", () => connection?.close());
								channel.on("error", () => connection?.close());
							});
						});
					});
					client.on("error", () => client.end());
					client.on("close", () => {
						clearTimeout(deadline);
						clients.delete(client);
						connection?.close();
					});
				},
			);
			server.listen(config.listenPort, hostname);
			return {
				server,
				close() {
					for (const client of clients) client.end();
					server.close();
				},
			};
		},
	};
}

export function maintenanceSshFromEnvironment(
	grants: SshMaintenanceGrants,
	transport?: MaintenanceTerminalTransport,
) {
	const host = process.env.PLATFORM_MAINTENANCE_SSH_HOST;
	if (!host) return undefined;
	if (!transport)
		throw new Error("Maintenance SSH requires the Worker transport");
	return maintenanceSshEndpoint(
		{
			host,
			publicPort: Number(process.env.PLATFORM_MAINTENANCE_SSH_PUBLIC_PORT),
			listenPort: 2222,
			hostKey: readFileSync(
				process.env.PLATFORM_MAINTENANCE_SSH_HOST_KEY_FILE ?? "",
			),
		},
		grants,
		transport,
	);
}
