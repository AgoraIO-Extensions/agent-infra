import {
	createDirectoryClient,
	resolveActiveMemberByEmail,
} from "@agent-infra/enterprise-directory";
import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import { PostgresOidcIdentityStore } from "./oidc-identity-store.js";

async function stage() {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of process.stdin) {
		const bytes = Buffer.from(chunk);
		length += bytes.length;
		if (length > 8192) throw new Error();
		chunks.push(bytes);
	}
	const row = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (
		!row ||
		typeof row.email !== "string" ||
		typeof row.source !== "string" ||
		typeof row.employeeId !== "string"
	)
		throw new Error();
	if (row.kind === "confirmed-new") {
		if (row.userId !== undefined) throw new Error();
	} else if (
		(row.kind !== undefined && row.kind !== "legacy") ||
		typeof row.userId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			row.userId,
		)
	) {
		throw new Error();
	}

	const moduleUrl = new URL(
		process.env.PLATFORM_API_CONFIGURATION_MODULE ?? "",
	);
	if (moduleUrl.protocol !== "file:") throw new Error();
	const { directorySnapshot } = await import(moduleUrl.href);
	const directory = createDirectoryClient(directorySnapshot);
	const snapshot = await directory.loadCurrent();
	const employee = resolveActiveMemberByEmail(snapshot, row.email);
	if (
		snapshot.source !== row.source ||
		!employee ||
		employee.userId !== row.employeeId
	)
		throw new Error();

	const store = new PostgresOidcIdentityStore(
		platformDatabaseUrlFromEnvironment(),
	);
	try {
		const identity = {
			email: employee.email,
			employeeId: JSON.stringify([snapshot.source, employee.userId]),
		};
		if (row.kind === "confirmed-new") await store.stageNewAccount(identity);
		else await store.stageLegacyAccount({ ...identity, userId: row.userId });
	} finally {
		await store.close();
	}
}

try {
	await stage();
	process.stdout.write("OIDC legacy mapping staged\n");
} catch {
	process.stderr.write("OIDC legacy mapping unavailable\n");
	process.exitCode = 1;
}
