import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";
import { initializationFromResources } from "./database-initialization.ts";
import { privateBytes, privateJson } from "./private-input.ts";

type Kind = "Secret" | "ConfigMap";
type Requirement = { kind: Kind; name: string; keys: Set<string> };
type ObjectRecord = Record<string, any>;
type Kubectl = (args: string[], input?: string) => string;
const ownerLabel = "agent-infra.agora.io/bootstrap-id";
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const namePattern = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const uidPattern =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export function requiredInputs(rendered: string) {
	const requirements = new Map<string, Requirement>();
	const add = (kind: Kind, name: string, keys: string[] = []) => {
		assert(typeof name === "string" && namePattern.test(name));
		const key = `${kind}/${name}`;
		if (!requirements.has(key))
			requirements.set(key, { kind, name, keys: new Set() });
		for (const field of keys) {
			assert(typeof field === "string" && /^[A-Za-z0-9._-]+$/u.test(field));
			requirements.get(key)!.keys.add(field);
		}
	};
	const walk = (value: any): void => {
		if (!value || typeof value !== "object") return;
		if (value.secretKeyRef)
			add("Secret", value.secretKeyRef.name, [value.secretKeyRef.key]);
		if (value.configMapKeyRef)
			add("ConfigMap", value.configMapKeyRef.name, [value.configMapKeyRef.key]);
		if (value.secretRef) add("Secret", value.secretRef.name);
		if (value.configMapRef) add("ConfigMap", value.configMapRef.name);
		if (value.secret?.secretName)
			add(
				"Secret",
				value.secret.secretName,
				(value.secret.items ?? []).map((item: any) => item.key),
			);
		if (value.configMap?.name)
			add(
				"ConfigMap",
				value.configMap.name,
				(value.configMap.items ?? []).map((item: any) => item.key),
			);
		for (const entry of value.imagePullSecrets ?? [])
			add("Secret", entry.name, [".dockerconfigjson"]);
		for (const entry of value.tls ?? [])
			if (entry.secretName)
				add("Secret", entry.secretName, ["tls.crt", "tls.key"]);
		if (Array.isArray(value.volumes)) {
			for (const container of [
				...(value.containers ?? []),
				...(value.initContainers ?? []),
			]) {
				for (const mount of container.volumeMounts ?? []) {
					const volume = value.volumes.find(
						(item: any) => item.name === mount.name,
					);
					const source = volume?.secret ?? volume?.configMap;
					if (!source) continue;
					const requirePath = (path: string) => {
						const key = source.items
							? source.items.find((item: any) => item.path === path)?.key
							: path;
						assert(key);
						add(
							volume.secret ? "Secret" : "ConfigMap",
							source.secretName ?? source.name,
							[key],
						);
					};
					if (mount.subPath && !source.items) requirePath(mount.subPath);
					for (const entry of container.env ?? []) {
						if (typeof entry.value !== "string") continue;
						const path = entry.value.startsWith("file:///")
							? decodeURIComponent(new URL(entry.value).pathname)
							: entry.value;
						if (!path.startsWith("/")) continue;
						const normalized = posix.normalize(path);
						if (normalized.startsWith(`${mount.mountPath}/`)) {
							const relative = normalized.slice(mount.mountPath.length + 1);
							requirePath(
								mount.subPath ? `${mount.subPath}/${relative}` : relative,
							);
						}
					}
				}
			}
		}
		for (const child of Object.values(value)) walk(child);
	};
	for (const doc of parseAllDocuments(rendered)) {
		assert.equal(doc.errors.length, 0);
		walk(doc.toJSON());
	}
	return [...requirements.values()];
}

export async function prepareBootstrapInputs(config: any, rendered: string) {
	assert(
		config &&
			Object.keys(config).every((key) =>
				[
					"schemaVersion",
					"installationId",
					"initializeDatabase",
					"clusterUid",
					"namespace",
					"objects",
				].includes(key),
			),
	);
	assert(
		config?.schemaVersion === 1 &&
			uidPattern.test(config.installationId) &&
			uidPattern.test(config.clusterUid),
	);
	assert(
		typeof config.namespace === "string" &&
			/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(config.namespace),
	);
	assert(
		!["default", "kube-system", "kube-public", "kube-node-lease"].includes(
			config.namespace,
		),
	);
	assert(
		Array.isArray(config.objects) &&
			config.objects.length > 0 &&
			config.objects.length <= 64,
	);
	const seen = new Set();
	const objects: ObjectRecord[] = [];
	let bytes = 0;
	for (const entry of config.objects) {
		assert(
			entry &&
				Object.keys(entry).every((key) =>
					["kind", "name", "secretType", "files"].includes(key),
				),
		);
		assert(["Secret", "ConfigMap"].includes(entry.kind));
		assert(typeof entry.name === "string" && namePattern.test(entry.name));
		const id = `${entry.kind}/${entry.name}`;
		assert(!seen.has(id));
		seen.add(id);
		assert(
			entry.files &&
				typeof entry.files === "object" &&
				!Array.isArray(entry.files),
		);
		assert(
			Object.keys(entry.files).length > 0 &&
				Object.keys(entry.files).length <= 64,
		);
		const data: Record<string, string> = {};
		for (const [key, file] of Object.entries(entry.files)) {
			assert(/^[A-Za-z0-9._-]+$/u.test(key) && typeof file === "string");
			const buffer = await privateBytes(file);
			bytes += buffer.length;
			assert(bytes <= 16 * 1024 * 1024);
			data[key] =
				entry.kind === "Secret"
					? buffer.toString("base64")
					: new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		}
		const type = entry.secretType ?? "Opaque";
		assert(
			[
				"Opaque",
				"kubernetes.io/tls",
				"kubernetes.io/dockerconfigjson",
			].includes(type),
		);
		if (entry.kind === "Secret" && type === "kubernetes.io/tls")
			assert(data["tls.crt"] && data["tls.key"]);
		if (entry.kind === "Secret" && type === "kubernetes.io/dockerconfigjson") {
			assert(data[".dockerconfigjson"]);
			assert(
				JSON.parse(Buffer.from(data[".dockerconfigjson"], "base64").toString())
					.auths,
			);
		}
		objects.push({
			apiVersion: "v1",
			kind: entry.kind,
			metadata: {
				name: entry.name,
				namespace: config.namespace,
				labels: { [ownerLabel]: config.installationId },
			},
			...(entry.kind === "Secret" ? { type } : {}),
			data,
		});
	}
	if (config.initializeDatabase !== undefined)
		assert(typeof config.initializeDatabase === "boolean");
	if (config.initializeDatabase) {
		const documents = parseAllDocuments(rendered)
			.map((doc) => {
				assert.equal(doc.errors.length, 0);
				return doc.toJSON();
			})
			.filter(Boolean);
		const initialization = initializationFromResources(
			documents,
			objects,
			config.namespace,
			config.installationId,
		);
		assert(
			namePattern.test(initialization.secretName) &&
				!seen.has(`Secret/${initialization.secretName}`),
		);
		objects.push({
			apiVersion: "v1",
			kind: "Secret",
			type: "Opaque",
			metadata: {
				name: initialization.secretName,
				namespace: config.namespace,
				labels: { [ownerLabel]: config.installationId },
			},
			data: {
				"01-roles.sql": Buffer.from(initialization.sql).toString("base64"),
			},
		});
	}
	for (const required of requiredInputs(rendered)) {
		const supplied = objects.find(
			(object) =>
				object.kind === required.kind && object.metadata.name === required.name,
		);
		assert(
			supplied &&
				[...required.keys].every((key) => Object.hasOwn(supplied.data, key)),
		);
	}
	return objects;
}

function sameData(current: ObjectRecord, desired: ObjectRecord) {
	assert(
		current.kind === desired.kind &&
			current.metadata?.name === desired.metadata.name &&
			current.metadata?.namespace === desired.metadata.namespace,
	);
	assert.deepEqual(current.data ?? {}, desired.data);
	assert.deepEqual(current.binaryData ?? {}, {});
	if (desired.kind === "Secret") assert.equal(current.type, desired.type);
}

export function checkExistingInputs(
	rendered: string,
	kubectl: Kubectl,
	namespace: string,
) {
	const requirements = requiredInputs(rendered);
	for (const required of requirements) {
		const raw = kubectl([
			"-n",
			namespace,
			"get",
			required.kind,
			required.name,
			"-o",
			"json",
		]);
		const observed = JSON.parse(raw);
		assert(
			observed.kind === required.kind &&
				observed.metadata?.namespace === namespace &&
				observed.metadata?.name === required.name,
		);
		assert(
			[...required.keys].every((key) =>
				Object.hasOwn(observed.data ?? {}, key),
			),
		);
	}
	return {
		schemaVersion: 1,
		kind: "ack-dependency-readback",
		objectCount: requirements.length,
	};
}

export async function bootstrapInputs(
	config: unknown,
	rendered: string,
	kubectl: Kubectl,
	apply = false,
) {
	const input = config as ObjectRecord;
	const objects = await prepareBootstrapInputs(input, rendered);
	const read = (kind: string, name: string, namespace?: string) => {
		const raw = kubectl([
			...(namespace ? ["-n", namespace] : []),
			"get",
			kind,
			name,
			"--ignore-not-found",
			"-o",
			"json",
		]);
		return raw.trim() ? JSON.parse(raw) : undefined;
	};
	const cluster = read("namespace", "kube-system");
	assert(cluster?.metadata?.uid === input.clusterUid);
	const namespace = read("namespace", input.namespace);
	const assertOwner = (object: ObjectRecord) =>
		assert(object.metadata?.labels?.[ownerLabel] === input.installationId);
	if (namespace) assertOwner(namespace);
	// Read every existing object before the first write; never adopt or overwrite another deployment.
	const existing = objects.map((object) =>
		read(object.kind, object.metadata.name, input.namespace),
	);
	existing.forEach((object, index) => {
		if (object) {
			assertOwner(object);
			sameData(object, objects[index]);
		}
	});
	if (apply) {
		if (!namespace) {
			kubectl(
				["create", "-f", "-"],
				JSON.stringify({
					apiVersion: "v1",
					kind: "Namespace",
					metadata: {
						name: input.namespace,
						labels: { [ownerLabel]: input.installationId },
					},
				}),
			);
		}
		const selectedNamespace = read("namespace", input.namespace);
		assert(selectedNamespace?.metadata?.uid);
		if (namespace)
			assert.equal(selectedNamespace.metadata.uid, namespace.metadata.uid);
		assertOwner(selectedNamespace);
		for (const [index, object] of objects.entries()) {
			// Namespace recreation invalidates the plan even when it has the same name.
			const currentNamespace = read("namespace", input.namespace);
			assert.equal(
				currentNamespace?.metadata?.uid,
				selectedNamespace.metadata.uid,
			);
			assertOwner(currentNamespace);
			if (!existing[index])
				kubectl(
					["-n", input.namespace, "create", "-f", "-"],
					JSON.stringify(object),
				);
			const observed = read(object.kind, object.metadata.name, input.namespace);
			assert(observed);
			assertOwner(observed);
			sameData(observed, object);
		}
	}
	return {
		schemaVersion: 1,
		kind: "ack-private-inputs",
		mode: apply ? "applied-and-read-back" : "read-only-plan",
		clusterHash: hash(input.clusterUid),
		namespaceHash: hash(input.namespace),
		objectCount: objects.length,
		createCount: existing.filter((object) => !object).length,
		deploymentVerified: false,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const [mode, configFile, renderedFile] = process.argv.slice(2);
		assert(["plan", "apply", "existing"].includes(mode));
		const namespace = process.env.ACK_NAMESPACE;
		assert(namespace);
		const kubeconfig = process.env.ACK_KUBECONFIG;
		assert(kubeconfig);
		const run: Kubectl = (args, input) =>
			execFileSync(
				"kubectl",
				["--kubeconfig", kubeconfig, "--request-timeout=20s", ...args],
				{
					input,
					encoding: "utf8",
					timeout: 30_000,
					maxBuffer: 16 * 1024 * 1024,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
		let receipt;
		if (mode === "existing") {
			receipt = checkExistingInputs(
				await readFile(configFile, "utf8"),
				run,
				namespace,
			);
		} else {
			const config = await privateJson(configFile);
			assert(config.namespace === namespace);
			receipt = await bootstrapInputs(
				config,
				await readFile(renderedFile, "utf8"),
				run,
				mode === "apply",
			);
		}
		process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
	} catch {
		process.stderr.write("ACK_BOOTSTRAP_INPUTS_FAILED\n");
		process.exitCode = 1;
	}
}
