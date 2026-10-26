import { createHash } from "node:crypto";

export function workerInputHash(entries) {
	const hash = createHash("sha256");
	for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
		hash.update(entry.path);
		hash.update("\0");
		hash.update(entry.content);
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function cachedWorkerDigest(cache, inputHash) {
	const entry = cache?.worker?.[inputHash];
	if (!entry?.repository || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) return null;
	return entry;
}

