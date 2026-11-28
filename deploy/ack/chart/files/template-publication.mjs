import { readFile } from "node:fs/promises";
import { TemplatePublicationBindingV1Schema } from "@agent-infra/contracts/pilot";
import { createTemplatePublicationServiceTransportV1 } from "@agent-infra/platform-core";

const mountedFile = "/var/run/agent-infra/template-publication/publications.json";
const reference = /^[A-Za-z0-9._~:-]{1,128}$/;

function invalid() {
	throw new Error("TEMPLATE_PUBLICATION_CONFIGURATION_INVALID");
}

function serviceMaterial(binding, principalRef, {issuer, keyVersion, keyBase64}) {
	if (![principalRef, issuer, keyVersion].every(value => typeof value === "string" && reference.test(value)) ||
		typeof keyBase64 !== "string") invalid();
	const key = Buffer.from(keyBase64, "base64");
	if (key.length < 32 || key.length > 128 || key.toString("base64") !== keyBase64) invalid();
	return {principalRef, issuer, keyVersion, key, publicationId: binding.publicationId, deploymentRef: binding.deploymentRef};
}

// Read the projected Secret on each authenticated request so revocation and key rotation take effect.
async function loadRecord(publicationId, file) {
	try {
		const doc = JSON.parse(await readFile(file, "utf8"));
		if (doc.schemaVersion !== 1 || !Array.isArray(doc.publications) || doc.publications.length > 64) invalid();
		const matches = doc.publications.filter((row) => row.binding?.publicationId === publicationId);
		if (matches.length !== 1) invalid();
		const row = matches[0];
		const binding = TemplatePublicationBindingV1Schema.parse(row.binding);
		return { binding, material: serviceMaterial(binding, binding.servicePrincipalRef, row),
			completedStatusReader: row.completedStatusReader };

	} catch {
		// Parse, I/O and schema errors can contain confidential input.
		invalid();
	}
}

export function createApiPublicationConfiguration(file = mountedFile) {
	return {
		loadBinding: async (id) => (await loadRecord(id, file)).binding,
		serviceAuthentication: {
			currentKey: async (id) => (await loadRecord(id, file)).material,
			async completedStatusReader(id) {
				const { binding, material: publisher, completedStatusReader: reader } = await loadRecord(id, file);
				if (!reader || typeof reader.expiresAt !== "string" || !(Date.parse(reader.expiresAt) > Date.now())) invalid();
				const material = serviceMaterial(binding, reader.principalRef, reader);
				if (material.principalRef === publisher.principalRef || material.key.equals(publisher.key)) invalid();
				return {material, expiresAt:reader.expiresAt};
			},
		},
	};
}

export async function createWorkerPublicationConfiguration(origin, catalog, file = mountedFile) {
	const base = new URL(origin);
	if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) invalid();
	return Promise.all(catalog.map(async (target) => {
		const { templateId, publicationId, catalogRevision, targetImageDigest, deploymentRef } = target;
		// The Worker may retain many older digests. Only this Helm revision's adopted target can report ready.
		async function currentKey() {
			const row = await loadRecord(publicationId, file);
			if (row.binding.templateId !== templateId || row.binding.catalogRevision !== catalogRevision ||
				row.binding.targetImageDigest !== targetImageDigest || row.binding.deploymentRef !== deploymentRef) invalid();
			return row.material;
		}
		await currentKey();
		const transport = createTemplatePublicationServiceTransportV1({ currentKey });
		const path = `/internal/ops/standard-template-releases/${publicationId}/`;
		return {
			publicationId, templateId, catalogRevision, targetImageDigest, origin: base.origin,
			async request(request) {
				const url = new URL(request.url);
				const mayRead = request.method === "GET" && url.pathname === path + "status-automatic";
				const mayWrite = request.method === "POST" &&
					(url.pathname === path + "worker-ready" || url.pathname === path + "run-automatic");
				if (url.origin !== base.origin || url.username || url.password || url.hash || !(mayRead || mayWrite)) invalid();
				return transport.request(request);
			},
		};
	}));
}
