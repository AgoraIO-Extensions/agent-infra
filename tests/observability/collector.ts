import { execFile as callback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(callback);
export const collectorImage = "otel/opentelemetry-collector-contrib:0.133.0";

const minimumDockerAvailableKiB = 5_242_880;

function availableKiB(disk: string) {
	return Number(disk.trim().split("\n").at(-1)?.trim().split(/\s+/)[3]);
}

export async function assertDockerCapacity() {
	// This standalone acceptance command is not a cached Turbo task.
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone acceptance resource ownership
	const session = process.env.AO_SESSION_ID;
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit hosted acceptance mode
	const mode = process.env.OBSERVABILITY_DOCKER_MODE;
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicitly selected local Docker VM
	const profile = process.env.COLIMA_PROFILE;
	if (!session) throw new Error("AO_SESSION_ID is required");
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone Docker environment gate
	const dockerHost = process.env.DOCKER_HOST;
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: Docker context overrides DOCKER_HOST
	const dockerContext = process.env.DOCKER_CONTEXT;
	if (mode === "hosted-linux") {
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub hosted runner identity gate
		const githubActions = process.env.GITHUB_ACTIONS;
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub hosted runner identity gate
		const runnerOs = process.env.RUNNER_OS;
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub hosted runner identity gate
		const runnerEnvironment = process.env.RUNNER_ENVIRONMENT;
		if (
			process.platform !== "linux" ||
			githubActions !== "true" ||
			runnerOs !== "Linux" ||
			runnerEnvironment !== "github-hosted"
		)
			throw new Error("hosted-linux mode requires a GitHub Linux runner");
		if (
			dockerContext !== undefined ||
			dockerHost !== "unix:///var/run/docker.sock"
		)
			throw new Error(
				"hosted-linux mode requires the native /var/run/docker.sock and no Docker context",
			);
		const socket = await stat("/var/run/docker.sock").catch(() => undefined);
		if (!socket?.isSocket())
			throw new Error("hosted-linux mode requires a native Docker socket");
		const { stdout: daemon } = await execFile("docker", [
			"info",
			"--format",
			"{{json .}}",
		]);
		let dockerRootDir: unknown;
		try {
			dockerRootDir = (JSON.parse(daemon) as { DockerRootDir?: unknown })
				.DockerRootDir;
		} catch (error) {
			throw new Error("Docker daemon info was not valid JSON", {
				cause: error,
			});
		}
		if (typeof dockerRootDir !== "string" || !dockerRootDir.startsWith("/"))
			throw new Error("Docker daemon did not report an absolute DockerRootDir");
		const { stdout: disk } = await execFile("df", ["-Pk", dockerRootDir]);
		const available = availableKiB(disk);
		if (
			!Number.isSafeInteger(available) ||
			available < minimumDockerAvailableKiB
		)
			throw new Error("Docker disk Available must be at least 5242880 KiB");
		return {
			session,
			availableKiB: available,
			mode,
			dockerRootDir,
		};
	}
	if (mode && mode !== "colima")
		throw new Error(`Unsupported observability Docker mode: ${mode}`);
	if (!profile) throw new Error("COLIMA_PROFILE is required for local Docker");
	if (
		!/^[a-zA-Z0-9_-]+$/.test(profile) ||
		dockerContext ||
		dockerHost !== `unix://${homedir()}/.colima/${profile}/docker.sock`
	)
		throw new Error(
			"DOCKER_HOST must match the selected Colima profile and DOCKER_CONTEXT must be unset",
		);
	const { stdout: disk } = await execFile("colima", [
		"ssh",
		"--profile",
		profile,
		"--",
		"df",
		"-Pk",
		"/var/lib/docker",
	]);
	const available = availableKiB(disk);
	if (!Number.isSafeInteger(available) || available < minimumDockerAvailableKiB)
		throw new Error("Docker disk Available must be at least 5242880 KiB");
	return { session, availableKiB: available, mode: "colima" as const };
}

async function availablePort() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	if (!address || typeof address === "string")
		throw new Error("No local port available");
	return address.port;
}

export async function startCollector() {
	const { session } = await assertDockerCapacity();
	const name = `agent-infra-441-${randomUUID()}`;
	const folder = await mkdtemp(join(tmpdir(), "collector-441-"));
	const docker = (...args: string[]) => execFile("docker", args);
	const stop = async () => {
		try {
			await docker("rm", "--force", name);
		} finally {
			await rm(folder, { recursive: true });
		}
	};
	try {
		const { stdout: imageId } = await docker(
			"image",
			"inspect",
			collectorImage,
			"--format",
			"{{.Id}}",
		);
		const [otlpPort, metricsPort, healthPort] = await Promise.all([
			availablePort(),
			availablePort(),
			availablePort(),
		]);
		await docker(
			"create",
			"--pull=never",
			"--name",
			name,
			"--label",
			`ao.session=${session}`,
			"--memory",
			"192m",
			"--cpus",
			"0.5",
			"--publish",
			`127.0.0.1:${otlpPort}:4318`,
			"--publish",
			`127.0.0.1:${metricsPort}:9464`,
			"--publish",
			`127.0.0.1:${healthPort}:13133`,
			imageId.trim(),
			"--config=/etc/collector.yaml",
		);
		await docker(
			"cp",
			fileURLToPath(new URL("./collector.yaml", import.meta.url)),
			`${name}:/etc/collector.yaml`,
		);
		const output = join(folder, "output");
		await mkdir(output);
		await chmod(output, 0o777);
		await docker("cp", output, `${name}:/output`);
		await docker("start", name);
		const endpoint = async (port: number) => {
			const { stdout } = await docker("port", name, `${port}/tcp`);
			const match = stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);
			if (!match) throw new Error("Collector must bind only loopback");
			return `http://127.0.0.1:${match[1]}`;
		};
		const health = await endpoint(13133);
		let ready = false;
		for (let attempt = 0; attempt < 40; attempt++) {
			ready = await fetch(health, { signal: AbortSignal.timeout(500) }).then(
				(r) => r.ok,
				() => false,
			);
			if (ready) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		if (!ready)
			throw new Error(
				`Collector failed: ${(await docker("logs", name)).stderr}`,
			);
		const metrics = await endpoint(9464);
		const otlpEndpoint = await endpoint(4318);
		return {
			imageId: imageId.trim(),
			otlpEndpoint,
			query: async () => {
				const response = await fetch(`${metrics}/metrics`, {
					signal: AbortSignal.timeout(2000),
				});
				if (!response.ok) throw new Error("Collector query failed");
				return response.text();
			},
			read: async () => {
				const path = join(folder, "observations.json");
				try {
					await docker("cp", `${name}:/output/observations.json`, path);
				} catch (error) {
					const diagnostic = await docker("logs", name);
					throw new Error(`Collector file read failed: ${diagnostic.stderr}`, {
						cause: error,
					});
				}
				return readFile(path, "utf8");
			},
			disconnect: () => docker("stop", "--time", "2", name),
			reconnect: async () => {
				await docker("start", name);
				const restored = await endpoint(4318);
				const restoredMetrics = await endpoint(9464);
				if (restored !== otlpEndpoint || restoredMetrics !== metrics)
					throw new Error(
						`Collector restart changed ports: ${otlpEndpoint} -> ${restored}; ${metrics} -> ${restoredMetrics}`,
					);
			},
			stop,
		};
	} catch (error) {
		await stop().catch(() => {});
		throw error;
	}
}

export function metricValue(
	text: string,
	name: string,
	labels: Record<string, string>,
) {
	const values = text
		.split("\n")
		.filter(
			(line) =>
				line.startsWith(`${name}{`) &&
				Object.entries(labels).every(([key, value]) =>
					line.includes(`${key}="${value}"`),
				),
		)
		.map((line) => Number(line.slice(line.lastIndexOf(" ") + 1)));
	return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
}
