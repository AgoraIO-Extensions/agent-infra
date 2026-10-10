import { crc32, gunzipSync, inflateRawSync } from "node:zlib";
import type { ProviderExecutor } from "@agent-infra/connection-core";
import {
	StaticSpacesAdapter as ArchivedAdapter,
	staticSpacesConnectionCatalog as archived,
	staticSpacesOrigins,
} from "./static-spaces.ts";
import { staticSpacesV2ExecutorDigest } from "./static-spaces-v2-integrity.ts";

export const staticSpacesPilot = {
	approvalIssue: "1681",
	principalId: "e3cc9ece-4e3e-4f2e-866e-3ef38fcf5749",
	consumerId: "consumer-codex",
	externalAccount: "841",
	startsAt: "2026-10-10T05:00:00Z",
	expiresAt: "2026-10-11T05:00:00Z",
	applicationId: "0c1e6e33-6750-4127-9d72-157e8899ddcd",
	ownerGroupId: "5c8d58a6-4732-4e7a-bf3e-c0174e771aa1",
	viewerGroupId: "9ba88b80-f9fb-43c8-8c91-684f0bbcdef0",
	canaryRunId: "static-spaces-7a0e99e4-419b-4f83-babb-33f7d9dfe768",
} as const;
const releaseId = "static-spaces-connection-v2-supervised";
export const staticSpacesConnectionCatalog = {
	...archived,
	providerReleaseId: releaseId,
	deploymentProfile: {
		...archived.deploymentProfile,
		supervisedPilot: staticSpacesPilot,
	},
	executorDigest: staticSpacesV2ExecutorDigest,
	actions: archived.actions.map((action) => ({
		...action,
		id: `${action.name}@v2`,
		description: `${action.description} 受监督试点：仅 shared connection-test；WRITE 仅带 ownership marker 的隔离 canary，禁止覆盖。`,
		inputSchema: action.name.endsWith("get_current_user")
			? action.inputSchema
			: {
					...action.inputSchema,
					properties: {
						...(action.inputSchema.properties as Record<string, object>),
						kind: { const: "shared" },
						slug: { const: "connection-test" },
						...(action.effect === "WRITE"
							? { overwrite: { const: false } }
							: {}),
					},
					required: [
						...new Set([
							...action.inputSchema.required,
							"slug",
							...(action.effect === "WRITE" ? ["overwrite"] : []),
						]),
					],
				},
	})),
};
function denied(): never {
	throw new Error("StaticSpaces supervised pilot admission denied");
}
function active() {
	const now = Date.now();
	if (
		now < Date.parse(staticSpacesPilot.startsAt) ||
		now >= Date.parse(staticSpacesPilot.expiresAt)
	)
		denied();
}
function ownedFile(path: unknown, bytes: Buffer) {
	if (typeof path !== "string") denied();
	const match =
		/^connection-onboarding\/(static-spaces-[0-9a-f-]{36})\/[a-zA-Z0-9._/-]+$/.exec(
			path,
		);
	if (
		!match ||
		match[1] !== staticSpacesPilot.canaryRunId ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	)
		denied();
	if (!bytes.includes(Buffer.from(`connection-e2e:${match[1]}`))) denied();
}
// Inspect every file before submission; bounded decompression and regular files only.
export function inspectPilotArchive(encoded: unknown, format: unknown) {
	if (
		typeof encoded !== "string" ||
		encoded.length > 1398104 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
	)
		denied();
	const archive = Buffer.from(encoded, "base64");
	if (
		!archive.length ||
		archive.length > 1048576 ||
		archive.toString("base64") !== encoded
	)
		denied();
	let count = 0;
	let total = 0;
	const names = new Set<string>();
	const accept = (name: string, data: Buffer) => {
		if (names.has(name)) denied();
		names.add(name);
		total += data.length;
		if (++count > 100 || total > 2097152) denied();
		ownedFile(name, data);
	};
	if (format === "zip") {
		let offset = 0;
		const localEntries: {
			name: string;
			offset: number;
			size: number;
			crc: number;
			flags: number;
			expected: number;
			method: number;
		}[] = [];
		while (
			offset + 30 <= archive.length &&
			archive.readUInt32LE(offset) === 0x04034b50
		) {
			const flags = archive.readUInt16LE(offset + 6);
			const method = archive.readUInt16LE(offset + 8);
			const size = archive.readUInt32LE(offset + 18);
			const expected = archive.readUInt32LE(offset + 22);
			const nameLength = archive.readUInt16LE(offset + 26);
			const extraLength = archive.readUInt16LE(offset + 28);
			const start = offset + 30 + nameLength + extraLength;
			const end = start + size;
			if (
				flags & ~0x800 ||
				![0, 8].includes(method) ||
				end > archive.length ||
				expected > 2097152
			)
				denied();
			const name = archive
				.subarray(offset + 30, offset + 30 + nameLength)
				.toString("utf8");
			const compressed = archive.subarray(start, end);
			const bytes =
				method === 0
					? compressed
					: inflateRawSync(compressed, { maxOutputLength: 2097152 });
			if (
				bytes.length !== expected ||
				crc32(bytes) !== archive.readUInt32LE(offset + 14)
			)
				denied();
			localEntries.push({
				name,
				offset,
				size,
				crc: archive.readUInt32LE(offset + 14),
				flags,
				expected,
				method,
			});
			accept(name, bytes);
			offset = end;
		}
		// Reject absent directories or local entries hidden from the central directory.
		const directoryStart = offset;
		let entries = 0;
		while (
			offset + 46 <= archive.length &&
			archive.readUInt32LE(offset) === 0x02014b50
		) {
			const local = localEntries[entries];
			const centralName = archive
				.subarray(offset + 46, offset + 46 + archive.readUInt16LE(offset + 28))
				.toString("utf8");
			if (
				!local ||
				centralName !== local.name ||
				archive.readUInt32LE(offset + 42) !== local.offset ||
				archive.readUInt32LE(offset + 20) !== local.size ||
				archive.readUInt32LE(offset + 16) !== local.crc ||
				archive.readUInt16LE(offset + 10) !== local.method ||
				archive.readUInt16LE(offset + 34) !== 0 ||
				archive.readUInt16LE(offset + 8) !== local.flags ||
				archive.readUInt32LE(offset + 24) !== local.expected
			)
				denied();
			const external = archive.readUInt32LE(offset + 38) >>> 16;
			if ((external & 0xf000) !== 0 && (external & 0xf000) !== 0x8000) denied();
			offset +=
				46 +
				archive.readUInt16LE(offset + 28) +
				archive.readUInt16LE(offset + 30) +
				archive.readUInt16LE(offset + 32);
			entries++;
		}
		if (
			entries !== count ||
			offset + 22 > archive.length ||
			archive.readUInt32LE(offset) !== 0x06054b50 ||
			offset + 22 + archive.readUInt16LE(offset + 20) !== archive.length ||
			archive.readUInt16LE(offset + 4) !== 0 ||
			archive.readUInt16LE(offset + 6) !== 0 ||
			archive.readUInt16LE(offset + 8) !== count ||
			archive.readUInt16LE(offset + 10) !== count ||
			archive.readUInt32LE(offset + 16) !== directoryStart ||
			archive.readUInt32LE(offset + 12) !== offset - directoryStart
		)
			denied();
	} else if (format === "tgz" || format === "tar.gz") {
		const tar = gunzipSync(archive, { maxOutputLength: 2162688 });
		let offset = 0;
		while (
			offset + 512 <= tar.length &&
			tar.subarray(offset, offset + 512).some((byte) => byte !== 0)
		) {
			const header = tar.subarray(offset, offset + 512);
			const field = (start: number, length: number) =>
				header
					.subarray(start, start + length)
					.toString("utf8")
					.replace(/\0.*$/s, "");
			const checksum = field(148, 8).trim();
			if (
				!/^[0-7]+$/.test(checksum) ||
				Number.parseInt(checksum, 8) !==
					header.reduce(
						(sum, byte, index) =>
							sum + (index >= 148 && index < 156 ? 32 : byte),
						0,
					)
			)
				denied();
			const sizeText = field(124, 12).trim();
			if (
				!/^[0-7]+$/.test(sizeText) ||
				![0, 48].includes(header[156] ?? -1) ||
				field(345, 155)
			)
				denied();
			const size = Number.parseInt(sizeText, 8);
			const start = offset + 512;
			if (start + size > tar.length) denied();
			accept(field(0, 100), tar.subarray(start, start + size));
			offset = start + Math.ceil(size / 512) * 512;
		}
		if (
			tar.length - offset < 1024 ||
			tar.subarray(offset).some((byte) => byte !== 0)
		)
			denied();
	} else denied();
	if (!count) denied();
}

export class StaticSpacesAdapter {
	readonly providerId = "static-spaces";
	readonly providerReleaseId = releaseId;
	private readonly archived: ArchivedAdapter;
	private readonly fetcher: typeof fetch;
	constructor(fetcher: typeof fetch) {
		this.fetcher = fetcher;
		this.archived = new ArchivedAdapter(fetcher);
	}
	async validateCredential(accessToken: string) {
		active();
		const credential = await this.archived.validateCredential(accessToken);
		if (credential.externalAccount !== staticSpacesPilot.externalAccount)
			denied();
		return { ...credential, providerReleaseId: releaseId };
	}
	async execute(
		input: Parameters<ProviderExecutor["execute"]>[0],
	): Promise<Record<string, unknown>> {
		active();
		if (
			input.providerReleaseId !== releaseId ||
			input.actionVersionId !== `${input.action}@v2`
		)
			denied();
		const action = staticSpacesConnectionCatalog.actions.find(
			(action) => action.name === input.action,
		);
		if (!action) denied();
		if (
			!input.action.endsWith("get_current_user") &&
			(input.input.kind !== "shared" || input.input.slug !== "connection-test")
		)
			denied();
		if (action.effect === "WRITE") {
			if (input.input.overwrite !== false) denied();
			if (input.action.endsWith("upload_html"))
				ownedFile(
					input.input.relative_path,
					Buffer.from(String(input.input.html)),
				);
			else if (input.action.endsWith("publish_space")) {
				if (!Array.isArray(input.input.files) || !input.input.files.length)
					denied();
				for (const file of input.input.files)
					ownedFile(
						file.relative_path,
						Buffer.from(
							file.content ?? file.content_base64 ?? "",
							file.content === undefined ? "base64" : "utf8",
						),
					);
			} else
				inspectPilotArchive(
					input.input.archive_base64,
					input.input.archive_format,
				);
			await this.preflight(input.credential.accessToken);
			active();
		}
		await this.validateCredential(input.credential.accessToken);
		active();
		return this.archived.execute({
			...input,
			providerReleaseId: archived.providerReleaseId,
			actionVersionId: `${input.action}@v1`,
		});
	}
	private async preflight(token: string) {
		const get = async (path: string) => {
			const response = await this.fetcher(
				new URL(path, staticSpacesOrigins.identity),
				{
					headers: {
						Authorization: `Bearer ${token}`,
						"Accept-Encoding": "identity",
						Accept: "application/json",
					},
					redirect: "error",
					signal: AbortSignal.timeout(10000),
				},
			);
			if (
				!response.ok ||
				response.headers.get("content-type")?.split(";")[0] !==
					"application/json" ||
				![null, "identity"].includes(response.headers.get("content-encoding"))
			)
				denied();
			const chunks: Buffer[] = [];
			let size = 0;
			if (!response.body) denied();
			const reader = response.body.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > 2097152) {
						await reader.cancel();
						denied();
					}
					chunks.push(Buffer.from(value));
				}
			} finally {
				reader.releaseLock();
			}
			const bytes = Buffer.concat(chunks);
			if (bytes.includes(Buffer.from(token))) denied();
			return JSON.parse(bytes.toString("utf8"));
		};
		const identity = await get("/api/v3/core/users/me/");
		const user = identity.user;
		const groups = new Set(
			(user?.groups ?? []).map((group: { pk: string }) => String(group.pk)),
		);
		if (
			String(user?.pk) !== "841" ||
			user?.is_superuser !== false ||
			user?.is_active !== true ||
			!groups.has(staticSpacesPilot.ownerGroupId) ||
			!groups.has(staticSpacesPilot.viewerGroupId)
		)
			denied();
		const applications = await get(
			"/api/v3/core/applications/?slug=static-spaces-shared-connection-test",
		);
		const matches = applications.results?.filter(
			(app: { slug: string }) =>
				app.slug === "static-spaces-shared-connection-test",
		);
		if (
			matches?.length !== 1 ||
			matches[0].pk !== staticSpacesPilot.applicationId ||
			matches[0].launch_url !==
				"https://static-spaces.sh3.agoralab.co/spaces/shared/connection-test/"
		)
			denied();
	}
}
