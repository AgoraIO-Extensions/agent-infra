import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readProtectedStandardMcpBytes } from "./standard-mcp-files.js";

const faults = vi.hoisted(() => ({
	phase: "",
	lost: false,
	hits: 0,
	reads: 0,
	handles: new Set<number>(),
}));
// Controlled I/O boundaries only; this is not real Linux protection evidence.
vi.mock("./standard-mcp-protection.js", () => ({
	assertStandardMcpProcessProtection: () => {
		if (faults.lost) throw new Error("private-protection-diagnostic");
	},
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: async (...args: Parameters<typeof fs.open>) => {
			const file = await fs.open(...args);
			let path: string;
			try {
				path = await fs.realpath(String(args[0]));
			} catch (error) {
				await file.close();
				throw error;
			}
			const fd = file.fd;
			faults.handles.add(fd);
			const material = path.endsWith("/private-fixture.token");
			const lose = () => {
				faults.lost = true;
				faults.hits++;
			};
			if (material && faults.phase === "open") lose();
			return new Proxy(file, {
				get(target, property) {
					if (property === "close")
						return async () => {
							await target.close();
							faults.handles.delete(fd);
							if (material && faults.phase === "close") lose();
						};
					if (material && property === "stat")
						return async () => {
							const stat = await target.stat();
							if (faults.phase === "stat" && !faults.lost) lose();
							return stat;
						};
					if (material && property === "read")
						return async (
							buffer: Buffer,
							offset: number,
							length: number,
							position: number,
						) => {
							faults.reads++;
							const result = await target.read(
								buffer,
								offset,
								faults.phase === "chunk" ? Math.min(length, 4) : length,
								position,
							);
							if (faults.phase === "chunk" && !faults.lost) lose();
							return result;
						};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
});

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
	faults.phase = "";
	faults.lost = false;
	faults.hits = 0;
	faults.reads = 0;
	faults.handles.clear();
});

async function setup() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "private-io-")));
	directories.push(root);
	const directory = join(root, "materials");
	await mkdir(directory, { mode: 0o700 });
	await writeFile(
		join(directory, "private-fixture.token"),
		"synthetic-fixture-material",
		{
			mode: 0o400,
		},
	);
	return directory;
}

it("reads bounded private bytes while protection stays available and closes every FD", async () => {
	const directory = await setup();
	expect(
		await readProtectedStandardMcpBytes(
			directory,
			"private-fixture.token",
			4096,
		),
	).toBe("synthetic-fixture-material");
	expect(faults.reads).toBeGreaterThan(0);
	expect(faults.handles.size).toBe(0);
});

it.each(["open", "stat", "chunk", "close"])(
	"rejects protection loss during %s without further private I/O or leaked FDs",
	async (phase) => {
		const directory = await setup();
		faults.phase = phase;
		const denied = await readProtectedStandardMcpBytes(
			directory,
			"private-fixture.token",
			4096,
		).then(
			() => false,
			() => true,
		);
		expect(faults.hits).toBe(1);
		expect(faults.handles.size).toBe(0);
		expect(faults.reads).toBe(
			phase === "close" ? 2 : phase === "chunk" ? 1 : 0,
		);
		expect(denied).toBe(true);
	},
);
