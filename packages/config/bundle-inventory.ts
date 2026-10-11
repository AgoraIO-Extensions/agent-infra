import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type Bundle = Record<
	string,
	{ type: string; modules?: Record<string, unknown> }
>;
const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/** Records inputs in emitted chunks, including packages hidden by bundling. */
export function bundleInventory(
	application: "connection-api" | "connection-web",
	sourceRoot: string,
) {
	const root = realpathSync(sourceRoot);
	return {
		name: "connection-bundle-inventory",
		generateBundle(_options: unknown, bundle: Bundle) {
			const components = new Map<
				string,
				{
					name: string;
					version?: string;
					license?: string;
					inputs: { path: string; sha256: string }[];
				}
			>();
			const inputs = [
				...new Set(
					Object.values(bundle)
						.filter((item) => item.type === "chunk")
						.flatMap((item) => Object.keys(item.modules ?? {})),
				),
			].sort();
			let generatedModules = 0;
			for (const id of inputs) {
				if (id.startsWith("\0")) {
					generatedModules++;
					continue;
				}
				const file = id.split("?")[0] ?? "";
				if (!isAbsolute(file) || !existsSync(file))
					throw new Error("Unknown bundled input");
				const real = realpathSync(file);
				const path = relative(root, real);
				if (path.startsWith("..") || isAbsolute(path))
					throw new Error("Bundled input outside source root");
				let directory = dirname(real);
				let metadata:
					| { name: string; version?: string; license?: string }
					| undefined;
				while (!metadata) {
					if (existsSync(join(directory, "package.json"))) {
						const candidate = JSON.parse(
							readFileSync(join(directory, "package.json"), "utf8"),
						);
						if (typeof candidate.name === "string") metadata = candidate;
					}
					if (metadata) break;
					if (directory === root)
						throw new Error("Bundled input lacks package identity");
					directory = dirname(directory);
				}
				const key = `${metadata.name}@${metadata.version ?? "workspace"}`;
				const component = components.get(key) ?? {
					name: metadata.name,
					...(typeof metadata.version === "string"
						? { version: metadata.version }
						: {}),
					...(typeof metadata.license === "string"
						? { license: metadata.license }
						: {}),
					inputs: [],
				};
				component.inputs.push({
					path: path.replaceAll("\\", "/"),
					sha256: hash(readFileSync(real)),
				});
				components.set(key, component);
			}
			if (!components.size) throw new Error("Empty bundle inventory");
			const directory = resolve(root, "build-evidence", application);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "bundle-inventory.json"),
				`${JSON.stringify({ version: 1, application, generatedModules, buildRuntime: { name: "node", version: process.version, sha256: hash(readFileSync(process.execPath)) }, components: [...components.values()] }, null, 2)}\n`,
			);
		},
	};
}
