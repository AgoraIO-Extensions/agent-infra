import { randomBytes, randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
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
			expect(
				await readFile(join(views, old, "published", "files", "link")),
			).toEqual(bytes);
			await writeFile(join(source, file), "next");
			expect(await capture()).toBe(a);
			expect(await publishMaintenanceView(source, views, later)).not.toBe(a);
			expect(
				await readFile(join(views, later, "published", "files", file), "utf8"),
			).toBe("next");
			await expect(
				publishMaintenanceView(source, views, randomUUID(), 1),
			).rejects.toThrow("after Session admission");
			await writeFile(
				join(views, later, "published", "files", file),
				"tampered",
			);
			await expect(verifyMaintenanceView(views, later, b)).rejects.toThrow();
			await symlink("../views", join(source, "outside"));
			await expect(
				publishMaintenanceView(source, views, randomUUID()),
			).rejects.toThrow();
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	},
);
