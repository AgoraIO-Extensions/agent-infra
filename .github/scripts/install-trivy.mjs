import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scannerVersion, sha256 } from "./vulnerability-policy.mjs";

const targets = {
  "linux-x64": ["Linux-64bit", "2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a"],
  "linux-arm64": ["Linux-ARM64", "b94ce1976bbf3c15b514b605ee88be7c6d94a29be2302847ff01cb794d47aad5"],
  "darwin-arm64": ["macOS-ARM64", "1caada5e0e2091909357c7525d3aa76f4b660b13821bc143b190c7483e31cc11"],
  "darwin-x64": ["macOS-64bit", "472816f6888dda689d075c30254d4210b4d1035acf365aa72332f584c2f60485"],
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target || process.argv.length !== 3)
  throw new Error("usage: install-trivy.mjs <tool-directory> on Linux/macOS amd64/arm64");
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: true });
const archive = join(directory, "trivy.tar.gz");
const existing = await readFile(archive).catch(() => null);
if (!existing || sha256(existing) !== target[1]) {
  execFileSync(
    "curl",
    [
      "--fail",
      "--location",
      "--proto",
      "=https",
      "--tlsv1.2",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      "--max-time",
      "180",
      "--retry",
      "3",
      `https://github.com/aquasecurity/trivy/releases/download/v${scannerVersion}/trivy_${scannerVersion}_${target[0]}.tar.gz`,
      "--output",
      archive,
    ],
    { stdio: "inherit" },
  );
}
if (sha256(await readFile(archive)) !== target[1]) throw new Error("Trivy archive checksum mismatch");
execFileSync("tar", ["-xzf", archive, "-C", directory, "trivy"]);
await writeFile(
  join(directory, "installation.json"),
  `${JSON.stringify({ version: scannerVersion, archiveSha256: target[1], binarySha256: sha256(await readFile(join(directory, "trivy"))) })}\n`,
);
console.info(`Verified Trivy ${scannerVersion}: ${directory}`);
