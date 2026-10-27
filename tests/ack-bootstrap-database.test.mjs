import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { bootstrapDatabase } from "../deploy/ack/bootstrap-database.ts";
import {
	prepareBootstrapInputs,
	requiredInputs,
} from "../deploy/ack/bootstrap-inputs.ts";

const installationId = "11111111-1111-4111-8111-111111111111";
const clusterUid = "22222222-2222-4222-8222-222222222222";
const owner = "agent-infra.agora.io/bootstrap-id";
const namespace = "fresh-test";
const release = "agent-infra-ack";
function render(databaseOnly = false) {
	const args = [
		"template",
		release,
		join(import.meta.dirname, "../deploy/ack/chart"),
		"--namespace",
		namespace,
	];
	for (const entry of [
		"postgres.enabled=true",
		"postgres.adminUser=bootstrap_admin",
		"postgres.initialDatabase=postgres",
		"postgres.adminSecret=db-admin",
		"postgres.initializationSecret=db-init",
		`postgres.bootstrapInstallationId=${installationId}`,
		"migrations.enabled=true",
		"directory.runtimeDatabaseRole=directory_runtime",
		`images.postgres=registry.example/postgres@sha256:${"1".repeat(64)}`,
		`bootstrap.databaseOnly=${databaseOnly}`,
	])
		args.push("--set", entry);
	return execFileSync("helm", args, { encoding: "utf8" });
}
async function fixture() {
	const rendered = render();
	const documents = parseAllDocuments(rendered)
		.map((doc) => doc.toJSON())
		.filter(Boolean);
	const objects = [];
	const directory = await mkdtemp(join(tmpdir(), "ack-db-plan-"));
	for (const dep of requiredInputs(rendered)) {
		if (dep.name === "db-init") continue;
		const keys = dep.keys.size ? [...dep.keys] : ["configuration.mjs"];
		const files = {};
		for (const key of keys) {
			let value = "private-file-canary-value";
			if (key === ".dockerconfigjson")
				value = JSON.stringify({
					auths: { "registry.example": { auth: "fixture" } },
				});
			if (key === "url") {
				if (dep.name === "agent-infra-platform-database")
					value =
						"postgres://platform_user:platform-canary-password@agent-infra-postgres/platform_db";
				if (dep.name === "agent-infra-directory-migration-db")
					value =
						"postgres://directory_owner:migration-canary-password@agent-infra-postgres/directory_db";
				if (dep.name === "agent-infra-directory-db")
					value =
						"postgres://directory_runtime:runtime-canary-password@agent-infra-postgres/directory_db";
			}
			const file = join(directory, `${dep.name}-${key}`);
			await writeFile(file, value, { mode: 0o600 });
			files[key] = file;
		}
		objects.push({ kind: dep.kind, name: dep.name, files });
	}
	const config = {
		schemaVersion: 1,
		initializeDatabase: true,
		installationId,
		clusterUid,
		namespace,
		objects,
	};
	const prepared = await prepareBootstrapInputs(config, rendered);
	const store = new Map(
		prepared.map((object) => [
			`${object.kind.toLowerCase()}/${object.metadata.name}`,
			object,
		]),
	);
	store.set("namespace/kube-system", { metadata: { uid: clusterUid } });
	store.set(`namespace/${namespace}`, {
		metadata: { uid: "namespace-uid", labels: { [owner]: installationId } },
	});
	let installed = false;
	let platformInstalled = false;
	let verify = true;
	const upgrades = [];
	const kubectl = (args, input) => {
		const i = args.indexOf("get");
		if (i >= 0) {
			const found = store.get(`${args[i + 1].toLowerCase()}/${args[i + 2]}`);
			if (!found && !args.includes("--ignore-not-found"))
				throw new Error("missing");
			return found ? JSON.stringify(found) : "";
		}
		if (args.includes("rollout")) return "";
		if (args.includes("exec")) {
			assert(input.includes("pg_authid"));
			assert(!input.includes("platform-canary-password"));
			return verify ? "t\n" : "f\n";
		}
		throw new Error("unexpected kubectl mutation");
	};
	const helm = (args, input) => {
		if (args[0] === "template") return render(true);
		if (args[0] === "list")
			return JSON.stringify(installed ? [{ name: release }] : []);
		if (args[0] === "get")
			return JSON.stringify({
				postgres: { bootstrapInstallationId: installationId },
				bootstrap: { databaseOnly: !platformInstalled },
			});
		assert(
			args[0] === "upgrade" && args.includes("bootstrap.databaseOnly=true"),
		);
		assert.equal(input, "frozen-private-values");
		upgrades.push(args);
		installed = true;
		const desired = structuredClone(
			documents.find((doc) => doc.kind === "StatefulSet"),
		);
		desired.metadata.uid = "stateful-uid";
		store.set("statefulset/agent-infra-postgres", desired);
		store.set("pvc/data-agent-infra-postgres-0", {
			metadata: { labels: { [owner]: installationId } },
		});
		store.set("pod/agent-infra-postgres-0", {
			metadata: {
				uid: "pod-uid",
				ownerReferences: [{ kind: "StatefulSet", uid: "stateful-uid" }],
			},
			spec: desired.spec.template.spec,
			status: { containerStatuses: [{ ready: true }] },
		});
		return "";
	};
	const run = () =>
		bootstrapDatabase(config, rendered, {
			release,
			chart: "controlled-chart",
			values: "frozen-private-values",
			kubectl,
			helm,
		});
	return {
		store,
		upgrades,
		prepared,
		run,
		setPlatform: () => {
			platformInstalled = true;
		},
		setInvalid: () => {
			verify = false;
		},
	};
}

test("database-only Helm stage excludes platform and migrations; normal stage includes both migrations", () => {
	const only = parseAllDocuments(render(true))
		.map((doc) => doc.toJSON())
		.filter(Boolean);
	assert(!only.some((doc) => ["Deployment", "Job"].includes(doc.kind)));
	assert(only.some((doc) => doc.kind === "StatefulSet"));
	const full = parseAllDocuments(render())
		.map((doc) => doc.toJSON())
		.filter(Boolean);
	assert.equal(full.filter((doc) => doc.kind === "Job").length, 2);
	const postgres = full.find((doc) => doc.kind === "StatefulSet").spec.template
		.spec;
	assert.equal(postgres.automountServiceAccountToken, false);
	assert(
		postgres.containers[0].readinessProbe.exec.command.includes("127.0.0.1"),
	);
});
test("database bootstrap verifies owned resources and roles without switching an installed platform back to database-only", async () => {
	const f = await fixture();
	const receipt = await f.run();
	assert.equal(receipt.rolesVerified, 3);
	assert.equal(receipt.databasesVerified, 2);
	assert.equal(receipt.schemaMigrationsVerified, false);
	assert.equal(f.upgrades.length, 1);
	const initialization = f.prepared.find(
		(object) => object.metadata.name === "db-init",
	);
	assert(initialization.data["01-roles.sql"]);
	f.setPlatform();
	await f.run();
	assert.equal(f.upgrades.length, 1);
	f.setInvalid();
	await assert.rejects(f.run());
});
test("database bootstrap refuses a foreign retained PVC before Helm writes", async () => {
	const f = await fixture();
	f.store.set("pvc/data-agent-infra-postgres-0", { metadata: { labels: {} } });
	await assert.rejects(f.run());
	assert.equal(f.upgrades.length, 0);
});
