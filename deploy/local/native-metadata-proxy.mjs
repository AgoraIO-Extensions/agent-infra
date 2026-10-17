import net from "node:net";

const [bindAddress, listenPortText, targetPortText, subnet] = process.argv.slice(2);
const port = Number(listenPortText);
const targetPort = Number(targetPortText);

function ipv4(value) {
	if (typeof value !== "string") return null;
	const normalized = value.startsWith("::ffff:") ? value.slice(7) : value;
	if (net.isIP(normalized) !== 4) return null;
	const octets = normalized.split(".").map(Number);
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
		return null;
	return octets;
}

function cidr(value) {
	const [address, prefixText] = value.split("/");
	const octets = ipv4(address);
	const prefix = Number(prefixText);
	if (!octets || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
	const integer =
		(octets[0] << 24) +
		(octets[1] << 16) +
		(octets[2] << 8) +
		octets[3];
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return { network: (integer & mask) >>> 0, mask };
}

if (!bindAddress || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || !Number.isSafeInteger(targetPort) ||
	targetPort < 1 || targetPort > 65_535) {
	throw new Error("LOCAL_NATIVE_METADATA_PROXY_CONFIGURATION_INVALID");
}
const network = cidr(subnet);
if (!network) throw new Error("LOCAL_NATIVE_METADATA_PROXY_CONFIGURATION_INVALID");

const server = net.createServer((client) => {
	const source = ipv4(client.remoteAddress);
	const sourceInteger = source
		? ((source[0] << 24) + (source[1] << 16) + (source[2] << 8) + source[3]) >>> 0
		: null;
	if (sourceInteger === null || ((sourceInteger & network.mask) >>> 0) !== network.network) {
		client.destroy();
		return;
	}
	const target = net.connect({ host: "127.0.0.1", port: targetPort });
	client.on("error", () => target.destroy());
	target.on("error", () => client.destroy());
	client.pipe(target);
	target.pipe(client);
});
server.on("error", (error) => {
	console.error(error instanceof Error ? error.message : "LOCAL_NATIVE_METADATA_PROXY_UNAVAILABLE");
	process.exitCode = 1;
});
server.listen(port, bindAddress);
