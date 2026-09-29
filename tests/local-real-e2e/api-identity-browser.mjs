import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

const requireWebDependency = createRequire(
	new URL("../../apps/web/package.json", import.meta.url),
);

let chromium;

function loadBrowserDependency() {
	if (chromium) return;
	({ chromium } = requireWebDependency("@playwright/test"));
}

function digest(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function nonEmptyString(value, message) {
	assert(typeof value === "string" && value.trim().length > 0, message);
	return value;
}

function record(value, message) {
	assert(value && typeof value === "object" && !Array.isArray(value), message);
	return value;
}

function loopbackOrHttpsOrigin(value) {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "https:" ||
				(url.protocol === "http:" &&
					["127.0.0.1", "[::1]"].includes(url.hostname))) &&
			url.origin === value &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

async function privateFile(path, label) {
	assert(isAbsolute(path), `${label} must be an absolute path`);
	const file = await stat(path);
	assert(file.isFile(), `${label} must be a regular file`);
	assert((file.mode & 0o077) === 0, `${label} must have mode 0600`);
	if (process.getuid !== undefined) {
		assert(file.uid === process.getuid(), `${label} must belong to this user`);
	}
}

async function privateDirectory(path) {
	assert(isAbsolute(path), "outputDirectory must be an absolute path");
	try {
		const existing = await stat(path);
		assert(existing.isDirectory(), "outputDirectory must be a directory");
		assert((existing.mode & 0o077) === 0, "outputDirectory must be private");
		if (process.getuid !== undefined)
			assert(
				existing.uid === process.getuid(),
				"outputDirectory owner mismatch",
			);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		await mkdir(path, { recursive: true, mode: 0o700 });
	}
	await chmod(path, 0o700);
}

function stateShape(value, label) {
	const parsed = record(value, `${label} must contain a JSON object`);
	assert(Array.isArray(parsed.cookies), `${label} must contain cookies`);
	assert(Array.isArray(parsed.origins), `${label} must contain origins`);
}

async function validateState(path, label) {
	await privateFile(path, label);
	let parsed;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		assert.fail(`${label} must contain valid JSON`);
	}
	stateShape(parsed, label);
}

function subject(value, label) {
	const candidate = record(value, `${label} is required`);
	assert(
		typeof candidate.userId === "string" &&
			candidate.userId.length > 0 &&
			!candidate.userId.includes("\0"),
		`${label}.userId is required`,
	);
	assert(
		typeof candidate.stateFile === "string" && isAbsolute(candidate.stateFile),
		`${label}.stateFile must be absolute`,
	);
	if (candidate.expectRole !== undefined) {
		assert(
			candidate.expectRole === "system_admin" ||
				candidate.expectRole === "employee",
			`${label}.expectRole is invalid`,
		);
	}
	return candidate;
}

function configuration(value) {
	const input = record(value, "configuration must be an object");
	assert(input.schemaVersion === 1, "schemaVersion must be 1");
	assert(input.mode === "api-identity-real", "mode must be api-identity-real");
	assert(
		loopbackOrHttpsOrigin(input.origin),
		"origin must be HTTPS or loopback HTTP",
	);
	const outputDirectory =
		typeof input.outputDirectory === "string"
			? input.outputDirectory
			: join(process.cwd(), "api-identity-evidence");
	assert(isAbsolute(outputDirectory), "outputDirectory must be absolute");
	const logFiles = input.logFiles ?? [];
	assert(
		Array.isArray(logFiles) && logFiles.length <= 8,
		"logFiles must be an array of at most eight paths",
	);
	for (const path of logFiles) {
		assert(
			typeof path === "string" && isAbsolute(path),
			"logFiles must contain absolute paths",
		);
	}
	const subjects = {
		admin: subject(input.admin, "admin"),
		owner: subject(input.owner, "owner"),
		other: subject(input.other, "other"),
	};
	assert(
		new Set(Object.values(subjects).map(({ userId }) => userId)).size === 3,
		"admin, owner and other must be distinct users",
	);
	assert(
		subjects.admin.expectRole === "system_admin",
		"admin must expect system_admin",
	);
	assert(
		subjects.owner.expectRole !== "system_admin",
		"owner must be non-admin",
	);
	assert(
		subjects.other.expectRole !== "system_admin",
		"other must be non-admin",
	);
	nonEmptyString(input.agentId, "agentId is required");
	const bearer = record(input.bearer, "bearer route contract is required");
	for (const key of ["readPath", "grantPath"]) {
		nonEmptyString(bearer[key], `bearer.${key} is required`);
		assert(bearer[key].startsWith("/"), `bearer.${key} must be a path`);
	}
	assert.equal(
		bearer.readPath,
		"/api/v2/agents/{agentId}",
		"bearer.readPath must use the formal V2 Agent detail route",
	);
	assert.equal(
		bearer.grantPath,
		"/api/v1/agents/{agentId}/grants",
		"bearer.grantPath must use the mounted API identity grant route",
	);
	const grantPrincipal = record(
		bearer.grantPrincipal ?? { kind: "user", id: subjects.other.userId },
		"bearer.grantPrincipal must be an object",
	);
	assert(
		grantPrincipal.kind === "user",
		"bearer.grantPrincipal must be a user",
	);
	nonEmptyString(grantPrincipal.id, "bearer.grantPrincipal.id is required");
	const config = {
		schemaVersion: 1,
		mode: "api-identity-real",
		origin: input.origin,
		outputDirectory,
		logFiles: [...logFiles],
		agentId: input.agentId,
		subjects,
		bearer: {
			readPath: bearer.readPath,
			grantPath: bearer.grantPath,
			grantPrincipal: { kind: "user", id: grantPrincipal.id },
		},
	};
	return config;
}

function pathFor(template, agentId) {
	return template.replaceAll("{agentId}", encodeURIComponent(agentId));
}

function responseCode(raw) {
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed?.code === "string" ? parsed.code : null;
	} catch {
		return null;
	}
}

function assertNoSecrets(raw, secrets, label) {
	for (const secret of secrets) {
		if (secret && raw.includes(secret)) {
			assert.fail(`${label} exposed a credential value`);
		}
	}
}

async function request(
	context,
	origin,
	method,
	path,
	body,
	secrets,
	options = {},
) {
	const headers = {};
	if (body !== undefined) headers["content-type"] = "application/json";
	if (options.authorization)
		headers.authorization = `Bearer ${options.authorization}`;
	const response = await context.request.fetch(`${origin}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { data: body }),
	});
	const raw = await response.text();
	assertNoSecrets(raw, secrets, `${method} ${path}`);
	let json = null;
	try {
		json = raw.length === 0 ? null : JSON.parse(raw);
	} catch {
		json = null;
	}
	return {
		status: response.status(),
		code: responseCode(raw),
		json,
		raw,
	};
}

async function listAll(context, origin, path, secrets) {
	const items = [];
	let cursor;
	let pages = 0;
	let last;
	do {
		const separator = path.includes("?") ? "&" : "?";
		const query = `${path}${separator}limit=100${
			cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`
		}`;
		last = await request(context, origin, "GET", query, undefined, secrets);
		expectStatus(last, 200, `${path} page`);
		assert(Array.isArray(last.json?.items), `${path} must return items`);
		assert(
			last.json && Object.hasOwn(last.json, "nextCursor"),
			`${path} must return nextCursor`,
		);
		items.push(...metadataItems(last));
		cursor = last.json?.nextCursor ?? null;
		pages += 1;
		assert(pages <= 100, `${path} pagination exceeded the acceptance limit`);
	} while (cursor !== null);
	return {
		...last,
		json: { items, nextCursor: null },
		pages,
	};
}

function expectStatus(result, expected, label) {
	const statuses = Array.isArray(expected) ? expected : [expected];
	assert(
		statuses.includes(result.status),
		`${label} returned unexpected status`,
	);
}

function applicationId(result, label) {
	assert(
		result.json && typeof result.json.applicationId === "string",
		`${label} did not return applicationId`,
	);
	return result.json.applicationId;
}

function credential(result, label) {
	assert(
		result.json && typeof result.json.credential === "string",
		`${label} did not return credential`,
	);
	assert(
		result.json.credential.length > 0,
		`${label} returned an empty credential`,
	);
	return result.json.credential;
}

function credentialId(result, label) {
	assert(
		result.json?.metadata?.credentialId,
		`${label} did not return credential metadata`,
	);
	return result.json.metadata.credentialId;
}

function metadataItems(result) {
	return Array.isArray(result.json?.items) ? result.json.items : [];
}

async function session(context, input, label) {
	const result = await request(
		context,
		input.origin,
		"GET",
		"/api/v1/session",
		undefined,
		[],
	);
	expectStatus(result, 200, `${label} session`);
	assert.equal(result.json?.user?.userId, input.subjects[label].userId);
	if (input.subjects[label].expectRole !== undefined) {
		assert(
			result.json?.user?.roles?.includes(input.subjects[label].expectRole),
			`${label} session role mismatch`,
		);
	}
	return {
		status: result.status,
		userHash: digest(input.subjects[label].userId),
		roles: result.json?.user?.roles ?? [],
	};
}

async function run(input) {
	await privateDirectory(input.outputDirectory);
	for (const [label, value] of Object.entries(input.subjects))
		await validateState(value.stateFile, `${label}.stateFile`);
	loadBrowserDependency();
	const browser = await chromium.launch();
	const contexts = {};
	const secrets = [];
	const deliveryApproval = (userId, scopes, expiresAt = null) => ({
		schemaVersion: 1,
		principal: { kind: "user", id: userId },
		scopes,
		expiresAt,
	});
	const evidence = {
		schemaVersion: 1,
		mode: "api-identity-real",
		endpointChecked: true,
		origin: input.origin,
		subjectHashes: Object.fromEntries(
			Object.entries(input.subjects).map(([label, value]) => [
				label,
				digest(value.userId),
			]),
		),
		steps: [],
	};
	const step = async (name, work) => {
		const result = await work();
		evidence.steps.push({ name, ...result });
		return result;
	};
	try {
		for (const [label, value] of Object.entries(input.subjects)) {
			contexts[label] = await browser.newContext({
				storageState: value.stateFile,
			});
			evidence[`${label}Session`] = await session(
				contexts[label],
				input,
				label,
			);
		}

		await step("retired-v1-management-rejected", async () => {
			const result = await request(
				contexts.owner,
				input.origin,
				"GET",
				"/api/v1/agents",
				undefined,
				secrets,
			);
			expectStatus(result, 400, "retired V1 management route");
			assert.equal(result.code, "INVALID_REQUEST");
			assert.match(result.json?.message ?? "", /API version is retired/i);
			return { status: result.status, code: result.code };
		});

		let applicationIdValue;
		await step("owner-creates-application", async () => {
			const result = await request(
				contexts.owner,
				input.origin,
				"POST",
				"/api/v1/applications",
				{ schemaVersion: 1, name: `#481 acceptance ${Date.now()}` },
				secrets,
			);
			expectStatus(result, 201, "application creation");
			const id = applicationId(result, "application creation");
			applicationIdValue = id;
			assert.equal(result.json.responsibleUserId, input.subjects.owner.userId);
			return {
				status: result.status,
				applicationHash: digest(id),
				responsibleUserHash: digest(result.json.responsibleUserId),
			};
		});
		assert(applicationIdValue, "created application must return an ID");

		await step("application-list-isolation", async () => {
			const [ownerList, adminList, otherList] = await Promise.all([
				listAll(contexts.owner, input.origin, "/api/v1/applications", secrets),
				listAll(contexts.admin, input.origin, "/api/v1/applications", secrets),
				listAll(contexts.other, input.origin, "/api/v1/applications", secrets),
			]);
			expectStatus(ownerList, 200, "owner application list");
			expectStatus(adminList, 200, "admin application list");
			expectStatus(otherList, 200, "other application list");
			assert(
				metadataItems(ownerList).some(
					(item) => item.applicationId === applicationIdValue,
				),
			);
			assert(
				metadataItems(adminList).some(
					(item) => item.applicationId === applicationIdValue,
				),
			);
			assert(
				!metadataItems(otherList).some(
					(item) => item.applicationId === applicationIdValue,
				),
			);
			return {
				owner: ownerList.status,
				admin: adminList.status,
				other: otherList.status,
			};
		});

		await step("delivery-failure-paths", async () => {
			const self = await request(
				contexts.owner,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credential-delivery`,
				deliveryApproval(input.subjects.owner.userId, ["agent:read"]),
				secrets,
			);
			const missing = await request(
				contexts.owner,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credential-delivery`,
				deliveryApproval(`missing-${Date.now()}`, ["agent:read"]),
				secrets,
			);
			expectStatus(self, 403, "self delivery grant");
			expectStatus(missing, 404, "missing recipient delivery grant");
			return { self: self.status, missing: missing.status };
		});

		await step("admin-grants-owner-delivery", async () => {
			const result = await request(
				contexts.admin,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credential-delivery`,
				deliveryApproval(input.subjects.owner.userId, ["agent:read"]),
				secrets,
			);
			expectStatus(result, 204, "admin delivery grant");
			return { status: result.status };
		});

		await step("owner-user-credential-lifecycle", async () => {
			const issued = await request(
				contexts.owner,
				input.origin,
				"POST",
				"/api/v1/api-credentials",
				{ schemaVersion: 1, scopes: ["agent:read"], expiresAt: null },
				secrets,
				{},
			);
			expectStatus(issued, 201, "user credential issue");
			const value = credential(issued, "user credential issue");
			secrets.push(value);
			const id = credentialId(issued, "user credential issue");
			assert.deepEqual(issued.json.metadata.principal, {
				kind: "user",
				id: input.subjects.owner.userId,
			});
			assert.deepEqual(issued.json.metadata.scopes, ["agent:read"]);
			const listed = await listAll(
				contexts.owner,
				input.origin,
				"/api/v1/api-credentials",
				secrets,
			);
			assert(metadataItems(listed).some((item) => item.credentialId === id));
			assert(!listed.raw.includes(value));
			const revoked = await request(
				contexts.owner,
				input.origin,
				"DELETE",
				`/api/v1/api-credentials/${encodeURIComponent(id)}`,
				undefined,
				secrets,
			);
			expectStatus(revoked, 204, "user credential revoke");
			const after = await listAll(
				contexts.owner,
				input.origin,
				"/api/v1/api-credentials",
				secrets,
			);
			const metadata = metadataItems(after).find(
				(item) => item.credentialId === id,
			);
			assert(
				metadata?.revokedAt,
				"revoked user credential must expose revokedAt metadata",
			);
			return {
				issueStatus: issued.status,
				revokeStatus: revoked.status,
				credentialHash: digest(value),
			};
		});

		await step("owner-grants-other-delivery", async () => {
			const result = await request(
				contexts.owner,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credential-delivery`,
				deliveryApproval(input.subjects.other.userId, ["agent:read"]),
				secrets,
			);
			expectStatus(result, 204, "other delivery grant");
			return { status: result.status };
		});

		await step("other-issues-read-credential", async () => {
			const crossSubject = await request(
				contexts.other,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				{
					schemaVersion: 1,
					scopes: ["agent:read"],
					expiresAt: null,
					recipient: { kind: "user", id: input.subjects.admin.userId },
				},
				secrets,
			);
			expectStatus(
				crossSubject,
				404,
				"cross-subject application credential issue",
			);
			const issued = await request(
				contexts.other,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				{ schemaVersion: 1, scopes: ["agent:read"], expiresAt: null },
				secrets,
				{},
			);
			expectStatus(issued, 201, "application read credential issue");
			const value = credential(issued, "application read credential issue");
			secrets.push(value);
			const id = credentialId(issued, "application read credential issue");
			assert.deepEqual(issued.json.metadata.principal, {
				kind: "application",
				id: applicationIdValue,
			});
			assert.deepEqual(issued.json.metadata.scopes, ["agent:read"]);
			return {
				status: issued.status,
				credentialHash: digest(value),
				credentialHashId: digest(id),
				crossSubjectStatus: crossSubject.status,
			};
		});
		const readCredentialValue = secrets[secrets.length - 1];

		await step("owner-grants-application-use-and-manage", async () => {
			const body = (grantType) => ({
				schemaVersion: 1,
				principal: { kind: "application", id: applicationIdValue },
				grantType,
			});
			const use = await request(
				contexts.owner,
				input.origin,
				"POST",
				`/api/v1/agents/${encodeURIComponent(input.agentId)}/grants`,
				body("use"),
				secrets,
			);
			const manage = await request(
				contexts.owner,
				input.origin,
				"POST",
				`/api/v1/agents/${encodeURIComponent(input.agentId)}/grants`,
				body("manage"),
				secrets,
			);
			expectStatus(use, 200, "application use grant");
			expectStatus(manage, 200, "application manage grant");
			return { useStatus: use.status, manageStatus: manage.status };
		});

		await step("read-scope-and-cross-subject-isolation", async () => {
			const read = await request(
				contexts.other,
				input.origin,
				"GET",
				pathFor(input.bearer.readPath, input.agentId),
				undefined,
				secrets,
				{ authorization: readCredentialValue },
			);
			expectStatus(read, 200, "read-scoped bearer read");
			const grant = await request(
				contexts.other,
				input.origin,
				"POST",
				pathFor(input.bearer.grantPath, input.agentId),
				{
					schemaVersion: 1,
					principal: input.bearer.grantPrincipal,
					grantType: "use",
				},
				secrets,
				{ authorization: readCredentialValue },
			);
			expectStatus(grant, 403, "read-scoped bearer manage operation");
			const browserBearer = await request(
				contexts.owner,
				input.origin,
				"GET",
				"/api/v1/applications",
				undefined,
				secrets,
				{ authorization: readCredentialValue },
			);
			expectStatus(browserBearer, 401, "browser identity route with bearer");
			const browserIsolation = await request(
				contexts.other,
				input.origin,
				"GET",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				undefined,
				secrets,
			);
			expectStatus(browserIsolation, 404, "other application credential list");
			return {
				readStatus: read.status,
				manageStatus: grant.status,
				crossSubjectStatus: browserIsolation.status,
			};
		});

		await step("other-issues-manage-credential", async () => {
			const unapproved = await request(
				contexts.other,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				{ schemaVersion: 1, scopes: ["agent:manage"], expiresAt: null },
				secrets,
			);
			expectStatus(unapproved, 404, "unapproved application credential scope");
			const approved = await request(
				contexts.owner,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credential-delivery`,
				deliveryApproval(input.subjects.other.userId, ["agent:manage"]),
				secrets,
			);
			expectStatus(approved, 204, "application manage credential approval");
			const issued = await request(
				contexts.other,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				{ schemaVersion: 1, scopes: ["agent:manage"], expiresAt: null },
				secrets,
				{},
			);
			expectStatus(issued, 201, "application manage credential issue");
			const value = credential(issued, "application manage credential issue");
			secrets.push(value);
			assert.deepEqual(issued.json.metadata.scopes, ["agent:manage"]);
			return {
				status: issued.status,
				unapprovedStatus: unapproved.status,
				credentialHash: digest(value),
				credentialIdHash: digest(
					credentialId(issued, "application manage credential issue"),
				),
			};
		});
		const manageCredentialValue = secrets[secrets.length - 1];

		await step("manage-scope-grant-and-revoke", async () => {
			const body = {
				schemaVersion: 1,
				principal: input.bearer.grantPrincipal,
				grantType: "use",
			};
			const granted = await request(
				contexts.other,
				input.origin,
				"POST",
				pathFor(input.bearer.grantPath, input.agentId),
				body,
				secrets,
				{ authorization: manageCredentialValue },
			);
			expectStatus(granted, 200, "manage-scoped bearer grant");
			const revoked = await request(
				contexts.other,
				input.origin,
				"DELETE",
				pathFor(input.bearer.grantPath, input.agentId),
				body,
				secrets,
				{ authorization: manageCredentialValue },
			);
			expectStatus(revoked, 204, "manage-scoped bearer grant revoke");
			return { grantStatus: granted.status, revokeStatus: revoked.status };
		});

		await step("expiring-credential-rejected", async () => {
			const expiresAt = new Date(Date.now() + 5_000);
			const approved = await request(
				contexts.owner,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credential-delivery`,
				deliveryApproval(
					input.subjects.other.userId,
					["agent:manage"],
					expiresAt.toISOString(),
				),
				secrets,
			);
			expectStatus(approved, 204, "expiring credential approval");
			const issued = await request(
				contexts.other,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				{
					schemaVersion: 1,
					scopes: ["agent:manage"],
					expiresAt: expiresAt.toISOString(),
				},
				secrets,
				{},
			);
			expectStatus(issued, 201, "expiring credential issue");
			const value = credential(issued, "expiring credential issue");
			secrets.push(value);
			assert.equal(issued.json.metadata.expiresAt, expiresAt.toISOString());
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					Math.max(0, expiresAt.getTime() - Date.now() + 250),
				),
			);
			const probe = await request(
				contexts.other,
				input.origin,
				"POST",
				pathFor(input.bearer.grantPath, input.agentId),
				{
					schemaVersion: 1,
					principal: input.bearer.grantPrincipal,
					grantType: "use",
				},
				secrets,
				{ authorization: value },
			);
			expectStatus(probe, 403, "expired bearer credential");
			return {
				issueStatus: issued.status,
				expiredStatus: probe.status,
				credentialHash: digest(value),
			};
		});

		await step("revoked-credential-rejected", async () => {
			const approved = await request(
				contexts.owner,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credential-delivery`,
				deliveryApproval(input.subjects.other.userId, ["agent:read"]),
				secrets,
			);
			expectStatus(approved, 204, "revocable credential approval");
			const issued = await request(
				contexts.other,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				{ schemaVersion: 1, scopes: ["agent:read"], expiresAt: null },
				secrets,
				{},
			);
			expectStatus(issued, 201, "revocable credential issue");
			const value = credential(issued, "revocable credential issue");
			secrets.push(value);
			const id = credentialId(issued, "revocable credential issue");
			const listed = await listAll(
				contexts.owner,
				input.origin,
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				secrets,
			);
			assert(metadataItems(listed).some((item) => item.credentialId === id));
			assert(!listed.raw.includes(value));
			const revoked = await request(
				contexts.owner,
				input.origin,
				"DELETE",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials/${encodeURIComponent(id)}`,
				undefined,
				secrets,
			);
			expectStatus(revoked, 204, "application credential revoke");
			const after = await listAll(
				contexts.owner,
				input.origin,
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				secrets,
			);
			assert(
				metadataItems(after).find((item) => item.credentialId === id)
					?.revokedAt,
				"revoked application credential must expose revokedAt metadata",
			);
			const probe = await request(
				contexts.other,
				input.origin,
				"GET",
				pathFor(input.bearer.readPath, input.agentId),
				undefined,
				secrets,
				{ authorization: value },
			);
			expectStatus(probe, 403, "revoked bearer credential");
			return {
				issueStatus: issued.status,
				revokeStatus: revoked.status,
				rejectedStatus: probe.status,
				credentialHash: digest(value),
			};
		});

		await step("delivery-revoke-blocks-new-issue", async () => {
			const revoked = await request(
				contexts.owner,
				input.origin,
				"DELETE",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credential-delivery`,
				{ kind: "user", id: input.subjects.other.userId },
				secrets,
			);
			expectStatus(revoked, 204, "other delivery revoke");
			const existing = await request(
				contexts.other,
				input.origin,
				"GET",
				pathFor(input.bearer.readPath, input.agentId),
				undefined,
				secrets,
				{ authorization: readCredentialValue },
			);
			expectStatus(existing, 403, "delivery-revoked bearer credential");
			const denied = await request(
				contexts.other,
				input.origin,
				"POST",
				`/api/v1/applications/${encodeURIComponent(applicationIdValue)}/credentials`,
				{ schemaVersion: 1, scopes: ["agent:read"], expiresAt: null },
				secrets,
			);
			expectStatus(denied, 404, "issue after delivery revoke");
			return {
				revokeStatus: revoked.status,
				existingStatus: existing.status,
				issueAfterRevokeStatus: denied.status,
			};
		});

		await step("admin-audit-has-no-credential-values", async () => {
			const audit = await listAll(
				contexts.admin,
				input.origin,
				"/api/v1/admin/audit",
				secrets,
			);
			assertNoSecrets(audit.raw, secrets, "admin audit");
			return {
				status: audit.status,
				itemCount: Array.isArray(audit.json?.items)
					? audit.json.items.length
					: 0,
				secretValuesChecked: secrets.length,
			};
		});
		const logEvidence = [];
		for (const path of input.logFiles) {
			const raw = await readFile(path, "utf8");
			assertNoSecrets(raw, secrets, `deployment log ${path}`);
			logEvidence.push({
				pathHash: digest(path),
				bytes: Buffer.byteLength(raw, "utf8"),
			});
		}
		evidence.logs = { checked: input.logFiles.length > 0, files: logEvidence };

		const evidencePath = join(input.outputDirectory, "evidence.json");
		const serialized = JSON.stringify(evidence, null, 2);
		assertNoSecrets(serialized, secrets, "evidence");
		await writeFile(evidencePath, `${serialized}\n`, { mode: 0o600 });
		await chmod(evidencePath, 0o600);
		process.stdout.write(
			`${JSON.stringify({ schemaVersion: 1, mode: input.mode, endpointChecked: true, evidencePath, subjectHashes: evidence.subjectHashes })}\n`,
		);
	} finally {
		for (const context of Object.values(contexts)) await context.close();
		await browser.close();
	}
}

const checkConfig = process.argv[2] === "--check-config";
const configPath = checkConfig ? process.argv[3] : process.argv[2];
assert(configPath, "Pass an absolute path to the API identity configuration");
assert(isAbsolute(configPath), "Configuration path must be absolute");
await privateFile(configPath, "configuration file");
let parsed;
try {
	parsed = JSON.parse(await readFile(configPath, "utf8"));
} catch {
	assert.fail("Configuration must contain valid JSON");
}
const input = configuration(parsed);
for (const [label, value] of Object.entries(input.subjects))
	await validateState(value.stateFile, `${label}.stateFile`);
if (checkConfig) {
	await privateDirectory(input.outputDirectory);
	process.stdout.write(
		`${JSON.stringify({
			schemaVersion: 1,
			mode: "configuration-only",
			endpointChecked: false,
			origin: input.origin,
			agentHash: digest(input.agentId),
			subjectHashes: Object.fromEntries(
				Object.entries(input.subjects).map(([label, value]) => [
					label,
					digest(value.userId),
				]),
			),
		})}\n`,
	);
} else {
	await run(input);
}
