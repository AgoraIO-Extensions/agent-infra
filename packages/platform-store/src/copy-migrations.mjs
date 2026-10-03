import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const source = resolve(repositoryRoot, "migrations/platform");
const destination = resolve(packageRoot, "dist/migrations");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
