import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const [tokenPath, outputPath] = process.argv.slice(2);
if (!tokenPath || !outputPath || !isAbsolute(tokenPath) || !isAbsolute(outputPath)) {
  throw new Error("Local proxy token and output paths must be absolute");
}

const sourceFile = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
let token;
try {
  const source = await sourceFile.stat();
  if (!source.isFile() || source.uid !== process.getuid() || (source.mode & 0o077) !== 0) {
    throw new Error("Local proxy token source must be an owned private regular file");
  }
  token = (await sourceFile.readFile("utf8")).trim();
} finally {
  await sourceFile.close();
}
const decodedToken = Buffer.from(token, "base64url");
if (
  !/^[A-Za-z0-9_-]{43,128}$/.test(token) ||
  decodedToken.length < 32 ||
  decodedToken.length > 96 ||
  decodedToken.toString("base64url") !== token
) {
  throw new Error("Local proxy token must be a Base64URL value of 32-96 bytes");
}

const template = await readFile(new URL("./nginx.conf", import.meta.url), "utf8");
const marker = "__PLATFORM_LOCAL_PROXY_TOKEN__";
if (template.split(marker).length !== 2) {
  throw new Error("Local nginx template must contain exactly one proxy token marker");
}

const directory = dirname(outputPath);
await mkdir(directory, { recursive: true, mode: 0o700 });
const info = await lstat(directory);
if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
  throw new Error("Local nginx state directory must be owned by this user and private");
}

const temporary = join(directory, `.nginx-${randomUUID()}`);
const temporaryToken = join(directory, `.proxy-token-${randomUUID()}`);
try {
  await writeFile(temporary, template.replace(marker, token), { flag: "wx", mode: 0o644 });
  await writeFile(temporaryToken, token, { flag: "wx", mode: 0o644 });
  await chmod(temporary, 0o644);
  await chmod(temporaryToken, 0o644);
  await rename(temporaryToken, join(directory, "proxy-token"));
  await rename(temporary, outputPath);
} finally {
  await Promise.all([
    rm(temporary, { force: true }),
    rm(temporaryToken, { force: true }),
  ]);
}
