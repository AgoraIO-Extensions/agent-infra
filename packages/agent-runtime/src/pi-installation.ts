import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import release from "./pi-release.json" with { type: "json" };

export const PI_NATIVE_PROVENANCE = release;
export async function verifyPiInstallation() {
	try {
		const root = dirname(
			dirname(fileURLToPath(import.meta.resolve(release.package))),
		);
		const metadata = JSON.parse(
			await readFile(join(root, "package.json"), "utf8"),
		);
		if (metadata.version !== release.nativeVersion) throw new Error();
		const bundle = join(root, "dist/bundle");
		const files = (await readdir(bundle, { recursive: true }))
			.filter((name) => name.endsWith(".js"))
			.sort();
		const hash = createHash("sha256");
		for (const file of files)
			hash.update(
				`${file}\0${createHash("sha256")
					.update(await readFile(join(bundle, file)))
					.digest("hex")}\n`,
			);
		if (
			files.length !== release.bundleFileCount ||
			hash.digest("hex") !== release.bundleSha256
		)
			throw new Error();
		return {
			...release,
			executable: process.execPath,
			cli: join(bundle, "cli.js"),
		};
	} catch {
		throw new Error("RUNTIME_PI_PROVENANCE_MISMATCH");
	}
}
