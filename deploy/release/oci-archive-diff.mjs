// Bounded diagnostics for two OCI layout archives that should be identical.
// The report names descriptors, config field paths, file paths, sizes, modes,
// mtimes and hashes, plus dpkg package name/version deltas; it never prints
// other file contents or image config values.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream";
import { createGunzip, createZstdDecompress } from "node:zlib";

const blockSize = 512;
const dpkgStatusPath = "var/lib/dpkg/status";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const defaultLimits = {
	configPaths: 20,
	detailedLayers: 3,
	entries: 50,
	headerBytes: 1024 * 1024,
	jsonBytes: 8 * 1024 * 1024,
	layerEntries: 500_000,
	layerLines: 30,
	packages: 50,
	statusBytes: 32 * 1024 * 1024,
};

class DiagnosticError extends Error {}

function printable(value) {
	const text = String(value);
	const escaped = text.replace(
		/[\u0000-\u001f\u007f]/g,
		(character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
	return escaped.length > 300 ? `${escaped.slice(0, 300)}…` : escaped;
}

function textField(header, start, end) {
	const bytes = header.subarray(start, end);
	const terminator = bytes.indexOf(0);
	return bytes
		.subarray(0, terminator < 0 ? bytes.length : terminator)
		.toString("utf8");
}

function numericField(header, start, end) {
	if (header[start] & 0x80) {
		let value = header[start] & 0x7f;
		for (let index = start + 1; index < end; index += 1) {
			value = value * 256 + header[index];
		}
		return value;
	}
	const text = textField(header, start, end).trim();
	if (!text) return 0;
	if (!/^[0-7]+$/.test(text)) throw new DiagnosticError("tar header is invalid");
	return Number.parseInt(text, 8);
}

function parseHeader(header) {
	const prefix = textField(header, 345, 500);
	const name = textField(header, 0, 100);
	return {
		name: prefix ? `${prefix}/${name}` : name,
		mode: numericField(header, 100, 108) & 0o7777,
		uid: numericField(header, 108, 116),
		gid: numericField(header, 116, 124),
		size: numericField(header, 124, 136),
		mtime: numericField(header, 136, 148),
		type: header[156] ? String.fromCharCode(header[156]) : "0",
		linkname: textField(header, 157, 257),
	};
}

function parsePax(bytes) {
	const records = {};
	let position = 0;
	while (position < bytes.length) {
		const space = bytes.indexOf(0x20, position);
		const length = Number(bytes.subarray(position, space).toString("utf8"));
		if (space < 0 || !Number.isSafeInteger(length) || length <= 0) {
			throw new DiagnosticError("tar extended header is invalid");
		}
		const record = bytes
			.subarray(space + 1, position + length - 1)
			.toString("utf8");
		const separator = record.indexOf("=");
		if (separator > 0) records[record.slice(0, separator)] = record.slice(separator + 1);
		position += length;
	}
	return records;
}

function normalizePath(path) {
	return path.replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "");
}

const typeNames = {
	0: "file",
	1: "hardlink",
	2: "symlink",
	3: "char",
	4: "block",
	5: "dir",
	6: "fifo",
	7: "file",
};

function applyOverrides(header, overrides) {
	// The effective size advances archive offsets and stream reads; a malformed
	// PAX value must stop the diagnostic instead of looping.
	const size = Number(overrides.size ?? header.size);
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new DiagnosticError("tar entry size is invalid");
	}
	return {
		path: normalizePath(overrides.path ?? header.name),
		type: typeNames[header.type] ?? `type-${header.type}`,
		mode: header.mode,
		uid: Number(overrides.uid ?? header.uid),
		gid: Number(overrides.gid ?? header.gid),
		size,
		mtime: String(overrides.mtime ?? header.mtime),
		link: overrides.linkpath ?? header.linkname,
		xattrs: Object.keys(overrides)
			.filter((key) => key.startsWith("SCHILY.xattr."))
			.sort()
			.map(
				(key) =>
					`${key.slice("SCHILY.xattr.".length)}=${createHash("sha256")
						.update(overrides[key], "binary")
						.digest("hex")
						.slice(0, 16)}`,
			)
			.join(","),
	};
}

// Streams one tar and returns path -> metadata (+content sha256 for files).
export async function listTarEntries(stream, options = {}) {
	const limits = { ...defaultLimits, ...options.limits };
	const capture = new Set(options.capture ?? []);
	const entries = new Map();
	const captured = new Map();
	let pending = Buffer.alloc(0);
	let current;
	let overrides = {};
	let globalOverrides = {};
	let ended = false;

	function begin(size, finish, { hash = false, keep = false, limit = Infinity } = {}) {
		current = {
			remaining: size,
			padding: (blockSize - (size % blockSize)) % blockSize,
			hash: hash ? createHash("sha256") : undefined,
			chunks: keep ? [] : undefined,
			kept: 0,
			limit,
			overflow: false,
			finish,
		};
		if (size === 0) end();
	}
	function end() {
		const done = current;
		current = undefined;
		done.finish(done);
	}
	function consume(bytes) {
		if (current.hash) current.hash.update(bytes);
		if (current.chunks && !current.overflow) {
			if (current.kept + bytes.length > current.limit) {
				current.overflow = true;
				current.chunks = [];
			} else {
				current.chunks.push(Buffer.from(bytes));
				current.kept += bytes.length;
			}
		}
	}
	function header(block) {
		if (block.every((byte) => byte === 0)) {
			ended = true;
			return;
		}
		const parsed = parseHeader(block);
		if (parsed.type === "x" || parsed.type === "g" || parsed.type === "L" || parsed.type === "K") {
			if (parsed.size > limits.headerBytes) {
				throw new DiagnosticError("tar extended header exceeds its limit");
			}
			begin(
				parsed.size,
				(done) => {
					const bytes = Buffer.concat(done.chunks);
					if (parsed.type === "x") overrides = { ...overrides, ...parsePax(bytes) };
					else if (parsed.type === "g") globalOverrides = { ...globalOverrides, ...parsePax(bytes) };
					else {
						const value = bytes.toString("utf8").replace(/\0+$/, "");
						overrides = { ...overrides, [parsed.type === "L" ? "path" : "linkpath"]: value };
					}
				},
				{ keep: true, limit: limits.headerBytes },
			);
			return;
		}
		const entry = applyOverrides(parsed, { ...globalOverrides, ...overrides });
		overrides = {};
		if (entries.size >= limits.layerEntries) {
			throw new DiagnosticError("layer entry count exceeds its limit");
		}
		const regular = entry.type === "file";
		const keep = regular && capture.has(entry.path);
		begin(
			regular ? entry.size : 0,
			(done) => {
				if (regular) entry.sha256 = done.hash.digest("hex");
				entries.set(entry.path, entry);
				if (keep) captured.set(entry.path, done.overflow ? undefined : Buffer.concat(done.chunks));
			},
			{ hash: regular, keep, limit: limits.statusBytes },
		);
		// Non-regular entries can still declare a payload size (rare); skip it.
		if (!regular && parsed.size > 0) {
			begin(parsed.size, () => {});
		}
	}

	for await (const chunk of stream) {
		const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
		pending = Buffer.alloc(0);
		let position = 0;
		while (position < data.length) {
			if (current) {
				const take = Math.min(current.remaining, data.length - position);
				if (take > 0) {
					consume(data.subarray(position, position + take));
					current.remaining -= take;
					position += take;
				}
				if (current.remaining === 0) {
					const skip = Math.min(current.padding, data.length - position);
					current.padding -= skip;
					position += skip;
					if (current.padding === 0) end();
				}
				continue;
			}
			if (ended) {
				position = data.length;
				break;
			}
			if (data.length - position < blockSize) {
				pending = Buffer.from(data.subarray(position));
				break;
			}
			header(data.subarray(position, position + blockSize));
			position += blockSize;
		}
	}
	if (current) throw new DiagnosticError("tar stream ended inside an entry");
	return { entries, captured };
}

async function readRange(handle, offset, size, limit) {
	if (size > limit) throw new DiagnosticError("archive member exceeds its limit");
	const bytes = Buffer.alloc(size);
	const { bytesRead } = await handle.read(bytes, 0, size, offset);
	if (bytesRead !== size) throw new DiagnosticError("archive member is truncated");
	return bytes;
}

async function openArchive(path, limits) {
	const handle = await open(path, "r");
	try {
		const members = new Map();
		const block = Buffer.alloc(blockSize);
		let offset = 0;
		let overrides = {};
		for (;;) {
			const { bytesRead } = await handle.read(block, 0, blockSize, offset);
			if (bytesRead < blockSize || block.every((byte) => byte === 0)) break;
			const parsed = parseHeader(block);
			const dataOffset = offset + blockSize;
			let size = parsed.size;
			if (parsed.type === "x" || parsed.type === "L") {
				const bytes = await readRange(handle, dataOffset, parsed.size, limits.headerBytes);
				overrides =
					parsed.type === "x"
						? { ...overrides, ...parsePax(bytes) }
						: { ...overrides, path: bytes.toString("utf8").replace(/\0+$/, "") };
			} else if (parsed.type !== "g") {
				const entry = applyOverrides(parsed, overrides);
				overrides = {};
				size = entry.size;
				if (entry.type === "file") members.set(entry.path, { offset: dataOffset, size });
			}
			offset = dataOffset + Math.ceil(size / blockSize) * blockSize;
		}
		return { path, handle, members };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

function blobMember(archive, digest) {
	if (!digestPattern.test(digest ?? "")) throw new DiagnosticError("descriptor digest is invalid");
	const member = archive.members.get(`blobs/sha256/${digest.slice(7)}`);
	if (!member) throw new DiagnosticError(`blob ${digest} is missing from the archive`);
	return member;
}

async function readJsonMember(archive, member, limits) {
	const bytes = await readRange(archive.handle, member.offset, member.size, limits.jsonBytes);
	try {
		return { bytes, value: JSON.parse(bytes.toString("utf8")) };
	} catch {
		throw new DiagnosticError("archive JSON member is invalid");
	}
}

async function readBlobJson(archive, digest, limits) {
	const { bytes, value } = await readJsonMember(archive, blobMember(archive, digest), limits);
	if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) {
		throw new DiagnosticError(`blob ${digest} does not match its digest`);
	}
	return value;
}

const isIndex = (mediaType) =>
	mediaType === "application/vnd.oci.image.index.v1+json" ||
	mediaType === "application/vnd.docker.distribution.manifest.list.v2+json";

async function readImage(archive, limits) {
	const member = archive.members.get("index.json");
	if (!member) throw new DiagnosticError("index.json is missing from the archive");
	let { value: index } = await readJsonMember(archive, member, limits);
	let descriptor = index.manifests?.[0];
	for (let depth = 0; descriptor && isIndex(descriptor.mediaType) && depth < 2; depth += 1) {
		index = await readBlobJson(archive, descriptor.digest, limits);
		descriptor = index.manifests?.[0];
	}
	if (!descriptor) throw new DiagnosticError("image manifest descriptor is missing");
	const manifest = await readBlobJson(archive, descriptor.digest, limits);
	if (!Array.isArray(manifest.layers) || !manifest.config) {
		throw new DiagnosticError("image manifest is invalid");
	}
	const config = await readBlobJson(archive, manifest.config.digest, limits);
	return { manifestDigest: descriptor.digest, manifest, config };
}

function jsonDifferences(first, second, path, output, limit) {
	if (output.length > limit) return;
	const bothObjects =
		first &&
		second &&
		typeof first === "object" &&
		typeof second === "object" &&
		Array.isArray(first) === Array.isArray(second);
	if (!bothObjects) {
		if (JSON.stringify(first) !== JSON.stringify(second)) output.push(path || "<root>");
		return;
	}
	const keys = [...new Set([...Object.keys(first), ...Object.keys(second)])];
	if (!Array.isArray(first)) keys.sort();
	for (const key of keys) {
		const child = Array.isArray(first) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
		jsonDifferences(first[key], second[key], child, output, limit);
	}
}

function decompressor(mediaType) {
	if (/(?:\+gzip|\.tar\.gzip)$/.test(mediaType)) return createGunzip();
	if (/(?:\+zstd|\.tar\.zstd)$/.test(mediaType)) return createZstdDecompress();
	if (/(?:layer\.v1\.tar|rootfs\.diff\.tar)$/.test(mediaType)) return undefined;
	throw new DiagnosticError(`layer media type ${mediaType} is unsupported`);
}

async function readLayer(archive, descriptor, limits) {
	const member = blobMember(archive, descriptor.digest);
	if (member.size === 0) return { entries: new Map(), captured: new Map() };
	const source = createReadStream(archive.path, {
		start: member.offset,
		end: member.offset + member.size - 1,
	});
	const transform = decompressor(descriptor.mediaType ?? "");
	// pipeline() propagates source errors into the stream being iterated.
	const stream = transform ? pipeline(source, transform, () => {}) : source;
	return listTarEntries(stream, {
		capture: [dpkgStatusPath],
		limits,
	});
}

const metadataFields = ["type", "size", "sha256", "mode", "uid", "gid", "mtime", "link", "xattrs"];

function describeEntry(entry) {
	const parts = [entry.type];
	if (entry.type === "file") parts.push(`size ${entry.size}`, `sha256 ${entry.sha256}`);
	if (entry.link) parts.push(`link ${printable(entry.link)}`);
	parts.push(`mode ${entry.mode.toString(8)}`, `owner ${entry.uid}:${entry.gid}`, `mtime ${entry.mtime}`);
	if (entry.xattrs) parts.push(`xattrs ${entry.xattrs}`);
	return parts.join(", ");
}

function describeChange(first, second) {
	return metadataFields
		.filter((field) => (first[field] ?? "") !== (second[field] ?? ""))
		.map((field) => {
			const format = (value) =>
				field === "mode" ? value.toString(8) : printable(value ?? "");
			return `${field} ${format(first[field])} -> ${format(second[field])}`;
		})
		.join(", ");
}

function dpkgPackages(bytes) {
	const packages = new Map();
	for (const paragraph of bytes.toString("utf8").split(/\n\s*\n/)) {
		const fields = {};
		for (const line of paragraph.split("\n")) {
			const match = /^(Package|Architecture|Version|Status):\s*(.*)$/.exec(line);
			if (match) fields[match[1]] = match[2].trim();
		}
		if (!fields.Package) continue;
		const name = fields.Architecture ? `${fields.Package}:${fields.Architecture}` : fields.Package;
		const status = fields.Status && !/ installed$/.test(fields.Status) ? ` (${fields.Status})` : "";
		packages.set(name, `${fields.Version ?? "<none>"}${status}`);
	}
	return packages;
}

function dpkgLines(first, second, limits) {
	if (!first || !second) {
		return [`  ${dpkgStatusPath}: package comparison unavailable (missing or over ${limits.statusBytes} bytes)`];
	}
	const before = dpkgPackages(first);
	const after = dpkgPackages(second);
	const deltas = [];
	for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const left = before.get(name);
		const right = after.get(name);
		if (left === right) continue;
		if (left === undefined) deltas.push(`  dpkg + ${printable(name)} ${printable(right)}`);
		else if (right === undefined) deltas.push(`  dpkg - ${printable(name)} ${printable(left)}`);
		else deltas.push(`  dpkg ~ ${printable(name)} ${printable(left)} -> ${printable(right)}`);
	}
	if (deltas.length === 0) {
		return [`  ${dpkgStatusPath}: no package name/version/status delta (${before.size} packages)`];
	}
	const shown = deltas.slice(0, limits.packages);
	if (deltas.length > shown.length) shown.push(`  dpkg … ${deltas.length - shown.length} more package deltas`);
	return [`  ${dpkgStatusPath}: ${deltas.length} package deltas`, ...shown];
}

function layerLines(first, second, limits) {
	const lines = [];
	const changes = [];
	const paths = [...new Set([...first.entries.keys(), ...second.entries.keys()])].sort();
	for (const path of paths) {
		const left = first.entries.get(path);
		const right = second.entries.get(path);
		if (!left) changes.push(`  + ${printable(path)} (${describeEntry(right)})`);
		else if (!right) changes.push(`  - ${printable(path)} (${describeEntry(left)})`);
		else {
			const change = describeChange(left, right);
			if (change) changes.push(`  ~ ${printable(path)} (${change})`);
		}
	}
	lines.push(
		`  entries ${first.entries.size} vs ${second.entries.size}; ${changes.length} differing paths`,
	);
	lines.push(...changes.slice(0, limits.entries));
	if (changes.length > limits.entries) {
		lines.push(`  … ${changes.length - limits.entries} more differing paths`);
	}
	const left = first.entries.get(dpkgStatusPath);
	const right = second.entries.get(dpkgStatusPath);
	if (left && right && left.sha256 !== right.sha256) {
		lines.push(...dpkgLines(first.captured.get(dpkgStatusPath), second.captured.get(dpkgStatusPath), limits));
	}
	return lines;
}

function short(descriptor) {
	return descriptor ? `${descriptor.digest} (${descriptor.size} bytes)` : "<absent>";
}

// Never throws: diagnostic failure must not mask the reproducibility failure.
export async function describeOciArchiveDifference(firstPath, secondPath, options = {}) {
	const limits = { ...defaultLimits, ...options.limits };
	const lines = [];
	const archives = [];
	try {
		// Free space helps separate content drift from builder cache pressure.
		const { bavail, blocks, bsize } = await statfs(dirname(firstPath));
		const gib = (count) => ((count * bsize) / 1024 ** 3).toFixed(1);
		lines.push(`archive filesystem free ${gib(bavail)} GiB of ${gib(blocks)} GiB`);
	} catch {
		// The archive comparison below reports missing paths.
	}
	try {
		for (const path of [firstPath, secondPath]) archives.push(await openArchive(path, limits));
		const [first, second] = [await readImage(archives[0], limits), await readImage(archives[1], limits)];
		lines.push(
			first.manifestDigest === second.manifestDigest
				? `manifest identical ${first.manifestDigest}`
				: `manifest ${first.manifestDigest} vs ${second.manifestDigest}`,
		);
		if (first.manifest.config.digest !== second.manifest.config.digest) {
			const paths = [];
			jsonDifferences(first.config, second.config, "", paths, limits.configPaths);
			lines.push(
				`config ${first.manifest.config.digest} vs ${second.manifest.config.digest}; differing fields: ${
					paths.slice(0, limits.configPaths).join(", ") || "<none>"
				}${paths.length > limits.configPaths ? ", …" : ""}`,
			);
		}
		const count = Math.max(first.manifest.layers.length, second.manifest.layers.length);
		const differing = [];
		for (let index = 0; index < count; index += 1) {
			const left = first.manifest.layers[index];
			const right = second.manifest.layers[index];
			if (left?.digest !== right?.digest) differing.push(index);
		}
		lines.push(
			`layers ${first.manifest.layers.length} vs ${second.manifest.layers.length}; differing indexes: ${
				differing.join(", ") || "<none>"
			}`,
		);
		for (const index of differing.slice(0, limits.layerLines)) {
			const diffIds = [first, second].map((image) => image.config.rootfs?.diff_ids?.[index]);
			const diffId = !diffIds[0] || !diffIds[1]
				? "unavailable"
				: diffIds[0] === diffIds[1]
					? "identical (compression only)"
					: "differs";
			lines.push(
				`layer ${index}: ${short(first.manifest.layers[index])} vs ${short(second.manifest.layers[index])}; diff_id ${diffId}`,
			);
		}
		const detailed = differing
			.filter((index) => first.manifest.layers[index] && second.manifest.layers[index])
			.slice(0, limits.detailedLayers);
		for (const index of detailed) {
			lines.push(`layer ${index} paths:`);
			const [left, right] = [
				await readLayer(archives[0], first.manifest.layers[index], limits),
				await readLayer(archives[1], second.manifest.layers[index], limits),
			];
			lines.push(...layerLines(left, right, limits));
		}
		if (differing.length > detailed.length) {
			lines.push(`path details limited to layers ${detailed.join(", ") || "<none>"}`);
		}
	} catch (error) {
		lines.push(
			`diagnostic incomplete: ${
				error instanceof DiagnosticError ? printable(error.message) : printable(error?.code ?? error?.name ?? "error")
			}`,
		);
	} finally {
		await Promise.all(archives.map((archive) => archive.handle.close().catch(() => {})));
	}
	return lines;
}
