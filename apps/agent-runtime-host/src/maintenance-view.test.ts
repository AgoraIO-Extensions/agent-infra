import { randomBytes, randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	publishMaintenanceView,
	verifyMaintenanceView,
} from "./maintenance-view.js";

it.runIf(process.platform === "linux")(
	"publishes only the fixed Claude project document into an already mounted native view",
	async () => {
		const base = await mkdtemp(join(tmpdir(), "claude-native-view-"));
		const source = join(base, "source");
		const views = join(base, "views");
		const sandbox = randomUUID();
		const prewarmed = join(views, sandbox, "claude-project");
		try {
			await mkdir(prewarmed, { recursive: true });
			await mkdir(source);
			await writeFile(join(source, "CLAUDE.md"), "saved before claim");
			await writeFile(join(source, "other-file"), "unrelated");
			const digest = await publishMaintenanceView(source, views, sandbox, true);
			expect(await readdir(prewarmed)).toEqual(["CLAUDE.md"]);
			expect(await readFile(join(prewarmed, "CLAUDE.md"), "utf8")).toBe(
				"saved before claim",
			);
			await writeFile(join(source, "CLAUDE.md"), "later");
			expect(await verifyMaintenanceView(views, sandbox, digest, true)).toBe(
				digest,
			);
			expect(await readFile(join(prewarmed, "CLAUDE.md"), "utf8")).toBe(
				"saved before claim",
			);
			await rm(join(source, "CLAUDE.md"));
			await symlink("other-file", join(source, "CLAUDE.md"));
			const next = randomUUID();
			await publishMaintenanceView(source, views, next, true);
			expect(await readdir(join(views, next, "claude-project"))).toEqual([]);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	},
);

it.runIf(process.platform === "linux")(
	"publishes complete bytes once per Sandbox, including competing writers",
	async () => {
		const base = await mkdtemp(join(tmpdir(), "maint-view-"));
		const source = join(base, "source");
		const views = join(base, "views");
		const old = randomUUID();
		const later = randomUUID();
		const bytes = randomBytes(3 * 1024 * 1024 + 79);
		try {
			await mkdir(source);
			await mkdir(views);
			await mkdir(join(source, "目录"));
			const file = "目录/custom.file";
			await writeFile(join(source, file), bytes);
			await symlink(file, join(source, "link"));
			const capture = () => publishMaintenanceView(source, views, old);
			const [a, b] = await Promise.all([capture(), capture()]);
			expect(a).toEqual(b);
			const copied = await readFile(
				join(views, old, "published", "files", "link"),
			);
			expect(copied.equals(bytes)).toBe(true);
			await writeFile(join(source, file), "next");
			expect(await capture()).toBe(a);
			const laterHash = await publishMaintenanceView(source, views, later);
			expect(laterHash).not.toBe(a);
			expect(
				await readFile(join(views, later, "published", "files", file), "utf8"),
			).toBe("next");
			await writeFile(
				join(views, later, "published", "files", file),
				"tampered",
			);
			await expect(
				verifyMaintenanceView(views, later, laterHash),
			).rejects.toThrow();
			await symlink("../views", join(source, "outside"));
			await expect(
				publishMaintenanceView(source, views, randomUUID()),
			).rejects.toThrow();
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	},
);

it.runIf(process.platform === "linux")(
	"opens a new view while an editor saves the same file by rename",
	async () => {
		const base = await mkdtemp(join(tmpdir(), "maint-save-"));
		const source = join(base, "source");
		const views = join(base, "views");
		const sandbox = randomUUID();
		let saving = true;
		let saves = 0;
		try {
			await mkdir(source);
			await mkdir(views);
			await writeFile(join(source, "AGENTS.md"), "A");
			await writeFile(join(source, "asset"), randomBytes(4 * 1024 * 1024));
			const edit = async () => {
				while (saving) {
					await writeFile(join(base, "edit"), ++saves % 2 === 0 ? "A" : "B");
					await rename(join(base, "edit"), join(source, "AGENTS.md"));
				}
			};
			const writing = edit();
			let digest: string;
			try {
				digest = await publishMaintenanceView(source, views, sandbox);
			} finally {
				saving = false;
				await writing;
			}
			expect(saves).toBeGreaterThan(0);
			expect(["A", "B"]).toContain(
				await readFile(
					join(views, sandbox, "published", "files", "AGENTS.md"),
					"utf8",
				),
			);
			expect(await verifyMaintenanceView(views, sandbox, digest)).toBe(digest);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	},
);
