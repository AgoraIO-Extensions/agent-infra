import {
	createHash,
	createHmac,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import {
	type TemplatePublicationServiceIdentityV1,
	TemplatePublicationServiceIdentityV1Schema,
} from "@agent-infra/contracts/pilot";

const parseTemplatePublicationServiceIdentityV1 = (
	value: unknown,
): TemplatePublicationServiceIdentityV1 =>
	TemplatePublicationServiceIdentityV1Schema.parse(value);

const header = "x-platform-template-publication";
export interface TemplatePublicationServiceKeyV1 {
	readonly issuer: string;
	readonly keyVersion: string;
	readonly principalRef: string;
	readonly deploymentRef: string;
	readonly publicationId: string;
	readonly key: Uint8Array;
}
export class TemplatePublicationAuthenticationErrorV1 extends Error {
	constructor() {
		super("TEMPLATE_PUBLICATION_AUTHENTICATION_FAILED");
	}
}
function reject(): never {
	throw new TemplatePublicationAuthenticationErrorV1();
}
function key(input: TemplatePublicationServiceKeyV1) {
	if (
		!(input.key instanceof Uint8Array) ||
		input.key.length < 32 ||
		input.key.length > 128
	)
		reject();
	return input;
}
function purpose(
	request: Request,
): TemplatePublicationServiceIdentityV1["purpose"] {
	const operation = new URL(request.url).pathname.split("/").at(-1);
	if (request.method === "GET" && operation === "status-automatic")
		return "read";
	if (request.method !== "POST") reject();
	if (operation === "worker-ready") return "ready";
	if (operation === "activate-automatic") return "activate";
	if (operation === "run-automatic") return "run";
	return reject();
}
async function bodyDigest(request: Request) {
	const reader = request.clone().body?.getReader();
	const hash = createHash("sha256");
	let length = 0;
	if (reader)
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.length;
			if (length > 16_384) {
				void reader.cancel().catch(() => {});
				reject();
			}
			hash.update(part.value);
		}
	return hash.digest("hex");
}
function scope(
	request: Request,
	identity: TemplatePublicationServiceIdentityV1,
) {
	const url = new URL(request.url);
	return (
		identity.purpose === purpose(request) &&
		url.pathname ===
			`/internal/ops/standard-template-releases/${identity.publicationId}/${url.pathname.split("/").at(-1)}`
	);
}
function current(
	identity: TemplatePublicationServiceIdentityV1,
	input: TemplatePublicationServiceKeyV1,
) {
	const now = Date.now();
	return (
		[
			"issuer",
			"keyVersion",
			"principalRef",
			"deploymentRef",
			"publicationId",
		].every(
			(field) =>
				identity[field as keyof typeof identity] ===
				input[field as keyof typeof input],
		) &&
		Date.parse(identity.issuedAt) <= now &&
		Date.parse(identity.expiresAt) > now &&
		Date.parse(identity.expiresAt) - Date.parse(identity.issuedAt) <= 60_000
	);
}

/** Credentials stay in the two deployment control processes; this never constructs a user identity. */
export function createTemplatePublicationServiceTransportV1(input: {
	readonly currentKey: () => Promise<TemplatePublicationServiceKeyV1>;
	readonly fetch?: typeof fetch;
}) {
	return {
		async request(request: Request) {
			try {
				if (new URL(request.url).protocol !== "https:") reject();
				const material = key(await input.currentKey());
				const now = Date.now();
				const identity = parseTemplatePublicationServiceIdentityV1({
					schemaVersion: 1,
					principalRef: material.principalRef,
					deploymentRef: material.deploymentRef,
					publicationId: material.publicationId,
					issuer: material.issuer,
					keyVersion: material.keyVersion,
					audience: "platform.template-publication.v1",
					purpose: purpose(request),
					requestRef: randomUUID(),
					issuedAt: new Date(now).toISOString(),
					expiresAt: new Date(now + 60_000).toISOString(),
				});
				if (!scope(request, identity)) reject();
				const url = new URL(request.url);
				const payload = Buffer.from(
					JSON.stringify({
						identity,
						method: request.method,
						path: url.pathname + url.search,
						bodyDigest: await bodyDigest(request),
					}),
				).toString("base64url");
				const signature = createHmac("sha256", material.key)
					.update(payload)
					.digest("base64url");
				const headers = new Headers(request.headers);
				headers.set(header, `${payload}.${signature}`);
				return await (input.fetch ?? fetch)(
					new Request(request, { headers, redirect: "error" }),
				);
			} catch {
				return reject();
			}
		},
	};
}

export function createTemplatePublicationServiceVerifierV1(input: {
	readonly currentKey: () => Promise<TemplatePublicationServiceKeyV1>;
	readonly consumeNonce: (
		identity: TemplatePublicationServiceIdentityV1,
	) => Promise<boolean>;
}) {
	return {
		async resolveService(
			request: Request,
		): Promise<TemplatePublicationServiceIdentityV1 | null> {
			const value = request.headers.get(header);
			if (value === null) return null;
			try {
				if (value.length > 8192) reject();
				const [payload, signature, ...extra] = value.split(".");
				if (
					!payload ||
					!signature ||
					extra.length ||
					!/^[A-Za-z0-9_-]+$/.test(payload) ||
					!/^[A-Za-z0-9_-]{43}$/.test(signature)
				)
					reject();
				const material = key(await input.currentKey());
				const expected = createHmac("sha256", material.key)
					.update(payload)
					.digest();
				const actual = Buffer.from(signature, "base64url");
				if (
					actual.length !== expected.length ||
					!timingSafeEqual(actual, expected)
				)
					reject();
				const envelope = JSON.parse(
					Buffer.from(payload, "base64url").toString("utf8"),
				);
				if (
					!envelope ||
					Object.keys(envelope).sort().join() !==
						"bodyDigest,identity,method,path"
				)
					reject();
				const identity = parseTemplatePublicationServiceIdentityV1(
					envelope.identity,
				);
				const url = new URL(request.url);
				if (
					!current(identity, material) ||
					!scope(request, identity) ||
					envelope.method !== request.method ||
					envelope.path !== url.pathname + url.search ||
					envelope.bodyDigest !== (await bodyDigest(request)) ||
					!(await input.consumeNonce(identity))
				)
					reject();
				return Object.freeze(identity);
			} catch {
				return reject();
			}
		},
		async isServiceCurrent(identity: TemplatePublicationServiceIdentityV1) {
			try {
				return current(
					parseTemplatePublicationServiceIdentityV1(identity),
					key(await input.currentKey()),
				);
			} catch {
				return false;
			}
		},
	};
}
