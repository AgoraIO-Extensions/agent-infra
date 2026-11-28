import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

type Files = Record<string, string>;
type ChangedFile = { path: string; sha256: string };
export type BaselineChanges = { updated: ChangedFile[]; removed: ChangedFile[] };

const name = "production-secret-baseline";
const filePath = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const measured = /^(?:config|release-config\/[a-f0-9]{40})\/(?:api\/template-validation-[\w-]+\.json|worker\/execution-capacity-profiles\.json)$/u;
const evidence = /^(?:release-config\/[a-f0-9]{40}\/)?evidence(?:\/|$)/u;
const managed = (path: string) => filePath.test(path) && !evidence.test(path) && !measured.test(path);

function baselineFiles(root: string): Files {
	if (!lstatSync(join(root, "..")).isDirectory() || !lstatSync(root).isDirectory())
		throw new Error("secret baseline must be a directory");
	const files: Files = Object.create(null);
	const physicalRoot = realpathSync(root);
	function visit(directory: string) {
		for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (!filePath.test(path)) throw new Error("unsupported secret baseline path");
			if (!managed(path)) continue;
			if (entry.isDirectory()) {
				visit(path);
				continue;
			}
			const file = realpathSync(join(root, path));
			const target = relative(physicalRoot, file);
			if (!managed(target) || !statSync(file).isFile())
				throw new Error("secret baseline links must resolve to files inside the baseline");
			files[path] = readFileSync(file).toString("base64");
		}
	}
	visit("");
	if (!Object.keys(files).length) throw new Error("secret baseline is empty");
	return files;
}

// kubectl receives manifests on stdin. Both its output and parser diagnostics can contain data.
type Kubectl = (args: string[], manifest?: string) => string;
function readCluster(kubectl: Kubectl): { files: Files; resourceVersion?: string } | undefined {
	const raw = kubectl(["get", "secret", name, "--ignore-not-found", "-o", "json"]).trim();
	if (!raw) return undefined;
	try {
		const secret = JSON.parse(raw);
		const files = JSON.parse(Buffer.from(secret.data["files.json"], "base64").toString("utf8"));
		if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(secret.data).length !== 1 ||
			Object.entries(files).some(([path, bytes]) => !managed(path) || typeof bytes !== "string" || Buffer.from(bytes, "base64").toString("base64") !== bytes))
			throw new Error();
		return { files, resourceVersion: secret.metadata.resourceVersion };
	} catch {
		throw new Error("cluster secret baseline is invalid");
	}
}

export function syncSecretBaseline(root: string, namespace: string, kubectl: Kubectl, beforeWrite: () => void): BaselineChanges {
	const wanted = baselineFiles(root);
	const stored = readCluster(kubectl);
	const oldFiles = stored?.files ?? {};
	const digest = (path: string, bytes: string): ChangedFile => ({ path, sha256: createHash("sha256").update(Buffer.from(bytes, "base64")).digest("hex") });
	const updated = Object.keys(wanted).sort().filter(path => wanted[path] !== oldFiles[path]).map(path => digest(path, wanted[path]!));
	const removed = Object.keys(oldFiles).sort().filter(path => !Object.hasOwn(wanted, path)).map(path => digest(path, oldFiles[path]!));
	let live = stored?.files;
	if (updated.length || removed.length) {
		const packed = Buffer.from(JSON.stringify(wanted));
		if (packed.length > 1024 * 1024) throw new Error("secret baseline exceeds Kubernetes Secret size limit");
		beforeWrite();
		kubectl(["apply", "--server-side", "--field-manager=secret-baseline", "-f", "-"], JSON.stringify({
			apiVersion: "v1", kind: "Secret", type: "Opaque",
			metadata: { name, namespace, ...(stored ? { resourceVersion: stored.resourceVersion } : {}) },
			data: { "files.json": packed.toString("base64") },
		}));
		live = readCluster(kubectl)?.files;
	}
	if (!live || Object.keys(live).length !== Object.keys(wanted).length || Object.keys(wanted).some(path => wanted[path] !== live[path]))
		throw new Error("cluster secret baseline differs from the deployment repository");
	// Replace the checkout's files with verified cluster bytes. The renderer consumes these paths;
	// unlink first so an existing alias is materialized without changing its target.
	for (const [path, bytes] of Object.entries(live)) {
		const file = join(root, path);
		unlinkSync(file);
		writeFileSync(file, Buffer.from(bytes, "base64"), { mode: 0o600, flag: "wx" });
	}
	return { updated, removed };
}
