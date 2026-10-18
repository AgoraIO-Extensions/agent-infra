// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(join(sourceRoot, "index.css"), "utf8");
const designMono = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.(css|tsx?)$/.test(entry.name) &&
			!/\.test\.tsx?$/.test(entry.name) &&
			!path.includes(`${join("pilot", "generated")}`)
			? [path]
			: [];
	});
}

function block(selector: string) {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`Missing ${selector}`);
	return css.slice(start, css.indexOf("\n}", start));
}

describe("design tokens", () => {
	it("defines the monospace stack once and every source references the token", () => {
		const offenders = sourceFiles(sourceRoot).flatMap((path) =>
			readFileSync(path, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					/ui-monospace|\bmonospace\b|Menlo|Consolas|SF ?Mono/.test(line) &&
					line.trim() !== `--font-mono: ${designMono};`
						? [`${relative(sourceRoot, path)}:${index + 1}: ${line.trim()}`]
						: [],
				),
		);
		expect(offenders).toEqual([]);
		expect(css.match(/ui-monospace/g)).toHaveLength(1);
		expect(block(":root")).toContain(`--font-mono: ${designMono};`);
		// Tailwind font-mono 工具类与 preflight 的 code/pre 也走同一个 token。
		expect(block("@theme inline")).toContain("--font-mono: var(--font-mono);");
	});

	it("provides design-named aliases and ink colors on the root", () => {
		const root = block(":root");
		for (const declaration of [
			"--secondary-foreground: var(--foreground);",
			"--accent-ink: oklch(0.46 0.15 248);",
			"--success-ink: oklch(0.45 0.12 145);",
			"--warning-ink: oklch(0.49 0.11 82);",
			"--danger-ink: oklch(0.46 0.14 27);",
			"--muted-ink: oklch(0.42 0.03 255);",
			"--bg: var(--background);",
			"--fg: var(--foreground);",
			"--surface-raised: var(--muted);",
			"--accent: var(--primary);",
			"--accent-soft: var(--secondary);",
			"--danger: var(--destructive);",
			"--shadow: var(--surface-shadow);",
			"font-family: var(--font-body);",
		])
			expect(root).toContain(declaration);
		expect(root).not.toContain("oklch(0.205 0 0)");
	});

	it("maps Tailwind accent to the design accent and keeps grey highlights on muted", () => {
		const theme = block("@theme inline");
		expect(theme).toContain("--color-accent: var(--accent);");
		for (const ink of ["accent", "success", "warning", "danger", "muted"])
			expect(theme).toContain(`--color-${ink}-ink: var(--${ink}-ink);`);
		const greyAccentClasses = sourceFiles(sourceRoot).filter((path) =>
			/\b(?:bg|text)-accent(?:-foreground)?\b(?!-)/.test(
				readFileSync(path, "utf8"),
			),
		);
		expect(greyAccentClasses).toEqual([]);
	});

	it("compresses motion durations with important declarations under reduced motion", () => {
		const reduced = css.slice(
			css.indexOf("@media (prefers-reduced-motion: reduce)"),
		);
		const rule = reduced.slice(0, reduced.indexOf("\n}"));
		expect(rule).toContain("animation-duration: 0.001ms !important;");
		expect(rule).toContain("transition-duration: 0.001ms !important;");
		expect(rule).toContain("scroll-behavior: auto !important;");
		expect(rule).not.toMatch(/animation: none|transition: none/);
	});
});
