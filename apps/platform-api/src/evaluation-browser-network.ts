import { execFile as callback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(callback);
const networkReadyTimeoutMs = 10_000;

type OwnedContainer = { containerName: string };
type OwnedInterface = OwnedContainer & { hostIndex: number; hostName: string };
export type OwnedInterfaceNetworkState = {
	up: boolean;
	disableIpv6: boolean;
	linkLocal: readonly { tentative?: boolean; dadfailed?: boolean }[];
	procFlags: readonly number[];
};

export function isLocalDockerEndpoint(endpoint: string): boolean {
	return endpoint.startsWith("unix://");
}

export function isLocalLinuxDockerEndpoint(
	platform: NodeJS.Platform,
	endpoint: string,
): boolean {
	return platform === "linux" && isLocalDockerEndpoint(endpoint);
}

export function ownedInterfaceNetworkReady(
	state: OwnedInterfaceNetworkState,
): boolean {
	if (!state.up) return false;
	if (state.disableIpv6) return true;
	if (
		state.linkLocal.length === 0 ||
		state.linkLocal.some((address) => address.tentative || address.dadfailed)
	)
		return false;
	return (
		state.procFlags.length > 0 &&
		state.procFlags.every(
			(flags) =>
				Number.isInteger(flags) && flags >= 0 && (flags & (0x40 | 0x08)) === 0,
		)
	);
}

async function usesLocalLinuxDocker() {
	if (process.platform !== "linux") return false;
	// DOCKER_CONTEXT overrides DOCKER_HOST; otherwise inspect the selected context.
	const dockerContext = process.env.DOCKER_CONTEXT;
	const endpoint = dockerContext
		? (
				await command("docker", [
					"context",
					"inspect",
					dockerContext,
					"--format",
					"{{.Endpoints.docker.Host}}",
				])
			).trim()
		: process.env.DOCKER_HOST ||
			(
				await command("docker", [
					"context",
					"inspect",
					(await command("docker", ["context", "show"])).trim(),
					"--format",
					"{{.Endpoints.docker.Host}}",
				])
			).trim();
	return isLocalLinuxDockerEndpoint(process.platform, endpoint);
}

async function command(file: string, args: string[]) {
	return (
		await execFile(file, args, {
			encoding: "utf8",
			timeout: 2_000,
			maxBuffer: 1024 * 1024,
		})
	).stdout;
}

async function mapOwnedInterface(
	container: OwnedContainer,
): Promise<OwnedInterface> {
	const containerIfindex = Number.parseInt(
		(
			await command("docker", [
				"exec",
				container.containerName,
				"cat",
				"/sys/class/net/eth0/ifindex",
			])
		).trim(),
		10,
	);
	const iflink = Number.parseInt(
		(
			await command("docker", [
				"exec",
				container.containerName,
				"cat",
				"/sys/class/net/eth0/iflink",
			])
		).trim(),
		10,
	);
	if (
		!Number.isInteger(containerIfindex) ||
		containerIfindex <= 0 ||
		!Number.isInteger(iflink) ||
		iflink <= 0
	)
		throw new Error("Owned fixture container eth0 iflink is unavailable");
	const links = JSON.parse(
		await command("ip", ["-j", "link", "show"]),
	) as Array<{ ifindex?: number; ifname?: string; link_index?: number }>;
	const host = links.find((link) => link.ifindex === iflink);
	if (
		!host ||
		typeof host.ifname !== "string" ||
		!host.ifname.startsWith("veth") ||
		host.link_index !== containerIfindex
	)
		throw new Error(
			"Owned fixture container eth0 is not mapped to a veth peer",
		);
	return { ...container, hostIndex: iflink, hostName: host.ifname };
}

async function isReady(iface: OwnedInterface) {
	const links = JSON.parse(
		await command("ip", ["-j", "address", "show", "dev", iface.hostName]),
	) as Array<{
		flags?: string[];
		addr_info?: Array<{
			family?: string;
			scope?: string;
			tentative?: boolean;
			dadfailed?: boolean;
		}>;
	}>;
	const link = links[0];
	if (!link?.flags?.includes("UP")) return false;
	const disableIpv6 = Number(
		(
			await readFile(
				`/proc/sys/net/ipv6/conf/${iface.hostName}/disable_ipv6`,
				"utf8",
			)
		).trim(),
	);
	if (disableIpv6 === 1) return true;
	const linkLocal =
		link.addr_info?.filter(
			(address) => address.family === "inet6" && address.scope === "link",
		) ?? [];
	const procAddresses = (await readFile("/proc/net/if_inet6", "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => line.trim().split(/\s+/))
		.filter(
			(parts) =>
				Number.parseInt(parts[1] ?? "", 16) === iface.hostIndex &&
				parts[5] === iface.hostName,
		)
		.filter((parts) => Number.parseInt(parts[3] ?? "", 16) === 0x20);
	return ownedInterfaceNetworkReady({
		up: true,
		disableIpv6: disableIpv6 === 1,
		linkLocal,
		procFlags: procAddresses.map((parts) =>
			Number.parseInt(parts[4] ?? "", 16),
		),
	});
}

/** Wait for only this fixture's Docker veth peers to finish IPv6 address setup. */
export async function waitForOwnedContainerNetworkReady(
	containers: readonly OwnedContainer[],
): Promise<void> {
	if (containers.length === 0 || !(await usesLocalLinuxDocker())) return;
	// A local Unix socket can forward to another VM; do not compare its ifindexes.
	const bootId = (
		await readFile("/proc/sys/kernel/random/boot_id", "utf8")
	).trim();
	for (const container of containers) {
		const containerBootId = (
			await command("docker", [
				"exec",
				container.containerName,
				"cat",
				"/proc/sys/kernel/random/boot_id",
			])
		).trim();
		if (containerBootId !== bootId) return;
	}
	const interfaces = await Promise.all(containers.map(mapOwnedInterface));
	const deadline = Date.now() + networkReadyTimeoutMs;
	while (true) {
		const ready = await Promise.all(interfaces.map(isReady));
		if (ready.every(Boolean)) return;
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			const pending = interfaces.filter((_, index) => !ready[index]);
			throw new Error(
				`Owned fixture network did not become ready within ${networkReadyTimeoutMs}ms: ${pending.map((iface) => `${iface.containerName}/${iface.hostName}`).join(", ")}`,
			);
		}
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(100, remaining)),
		);
	}
}
