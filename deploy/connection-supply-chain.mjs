import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const repository = "AgoraIO-Extensions/agent-infra";
export const repositoryId = "1316991471";
export const predicateType = "https://agent-infra.agoralab.co/connection/release-evidence/v1";
const registry = "ghcr.io/agoraio-extensions/agent-infra";
const sha = /^[a-f0-9]{40}$(?![\s\S])/;
const digest = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const tag = /^connection-v\d+\.\d+\.\d+$(?![\s\S])/;
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const tools = {
  cosign: { version: "3.0.2", linux: ["46dbdcb5467a3dfec2526923d0b3365e40c8d9dc00ec23d5aca3437449e8cbfd", "17fd784737ca54d7d8a343c82da6c5d6dbdee971e66644d923d1b057fb97d7ed"], darwin: ["0fc2b6f16b900abdfda3153b11fc435a8cbe3830e8e820fe8ad5fe4149a5b472", "3823b044de184da21e300bc5e20dd29d3fa9243af3ba70c4a5da1712f3385d46"] },
  syft: { version: "1.38.0", linuxArchive: "bc664debb00db1b9b4b9dae4ba1a29d99621e33b641b94b78b9048374b812a3d" },
};

export function validateSubject(subject) {
  requireValue(subject?.version === 1 && subject.repository === repository && subject.repositoryId === repositoryId, "Wrong release repository");
  requireValue(sha.test(subject.sourceSha) && tag.test(subject.tag), "Invalid release source/tag");
  requireValue(["connection-api", "connection-web"].includes(subject.application), "Wrong release application");
  requireValue(subject.image === `${registry}/${subject.application}` && digest.test(subject.digest), "Wrong image subject");
  return subject;
}

export function certificateArguments(subject) {
  requireValue(subject.repository === repository && subject.repositoryId === repositoryId && sha.test(subject.sourceSha) && tag.test(subject.tag) && ["connection-api", "connection-web"].includes(subject.application) && subject.image === `${registry}/${subject.application}`, "Invalid signing identity");
  return [
    "--certificate-identity", `https://github.com/${repository}/.github/workflows/publish-ghcr.yml@refs/tags/${subject.tag}`,
    "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
    "--certificate-github-workflow-repository", repository,
    "--certificate-github-workflow-ref", `refs/tags/${subject.tag}`,
    "--certificate-github-workflow-sha", subject.sourceSha,
    "--certificate-github-workflow-trigger", "push",
  ];
}

// Parse only DER framing and one Fulcio policy extension. Cosign verifies X.509/signatures.
function derItems(bytes) {
  const items = [];
  for (let offset = 0; offset < bytes.length;) {
    requireValue(offset + 2 <= bytes.length, "Truncated DER");
    const type = bytes[offset++]; let length = bytes[offset++];
    if (length & 128) {
      const size = length & 127;
      requireValue(size > 0 && size <= 4 && offset + size <= bytes.length, "Invalid DER length");
      length = 0; for (let i = 0; i < size; i++) length = length * 256 + bytes[offset++];
    }
    requireValue(offset + length <= bytes.length, "Truncated DER value");
    items.push({ type, bytes: bytes.subarray(offset, offset + length) }); offset += length;
  }
  return items;
}

export function requireRepositoryCertificate(bundle) {
  const material = bundle?.verificationMaterial;
  const chain = material?.x509CertificateChain?.certificates;
  requireValue(Boolean(material?.certificate) !== Boolean(chain), "Ambiguous signing certificate");
  const encoded = material?.certificate?.rawBytes ?? chain?.[0]?.rawBytes;
  requireValue(typeof encoded === "string" && encoded.length < 32768, "Missing signing certificate");
  const cert = derItems(Buffer.from(encoded, "base64"));
  requireValue(cert.length === 1 && cert[0].type === 48, "Invalid certificate sequence");
  const tbs = derItems(cert[0].bytes)[0]; requireValue(tbs?.type === 48, "Missing certificate body");
  const extensions = derItems(tbs.bytes).filter((item) => item.type === 163);
  requireValue(extensions.length === 1, "Missing certificate extensions");
  const sequence = derItems(extensions[0].bytes); requireValue(sequence.length === 1 && sequence[0].type === 48, "Invalid extensions sequence");
  const matches = derItems(sequence[0].bytes).filter((extension) => {
    requireValue(extension.type === 48, "Invalid extension");
    const fields = derItems(extension.bytes);
    return fields[0]?.type === 6 && fields[0].bytes.toString("hex") === "2b0601040183bf30010f";
  });
  requireValue(matches.length === 1, "Missing immutable repository identity");
  const value = derItems(matches[0].bytes).at(-1); requireValue(value.type === 4, "Invalid repository extension");
  const text = derItems(value.bytes);
  requireValue(text.length === 1 && text[0].type === 12 && text[0].bytes.toString("utf8") === repositoryId, "Wrong immutable repository identity");
}

export function completeSbom(imageSbom, bundle, subject) {
  validateSubject(subject);
  requireValue(imageSbom?.bomFormat === "CycloneDX" && imageSbom.components?.length > 0, "Missing image SBOM");
  requireValue(imageSbom.components.some((component) => /^pkg:(deb|apk)\//.test(component.purl ?? "")), "Image SBOM lacks OS packages");
  requireValue(bundle?.version === 1 && bundle.application === subject.application && bundle.components?.length > 0, "Missing actual bundle inventory");
  const runtime = [];
  if (subject.application === "connection-api") {
    requireValue(bundle.buildRuntime?.name === "node" && /^v\d+\.\d+\.\d+$/.test(bundle.buildRuntime.version) && /^[a-f0-9]{64}$/.test(bundle.buildRuntime.sha256), "Missing Node runtime evidence");
    runtime.push({ type: "application", "bom-ref": "connection:node-runtime", name: "node", version: bundle.buildRuntime.version.slice(1), hashes: [{ alg: "SHA-256", content: bundle.buildRuntime.sha256 }], properties: [{ name: "connection:origin", value: "final-image-runtime-matches-build-runtime" }] });
  } else requireValue(imageSbom.components.some((component) => component.name === "nginx"), "Missing nginx runtime package");
  const bundled = bundle.components.map((component) => {
    requireValue(typeof component.name === "string" && component.inputs?.length > 0, "Invalid bundled component");
    for (const input of component.inputs) requireValue(typeof input.path === "string" && !input.path.startsWith("/") && !input.path.split("/").includes("..") && /^[a-f0-9]{64}$/.test(input.sha256), "Invalid bundle provenance");
    return { type: "library", "bom-ref": `bundled:${component.name}@${component.version ?? subject.sourceSha}`, name: component.name, ...(component.version ? { version: component.version } : {}), ...(component.license ? { licenses: [{ license: { name: component.license } }] } : {}), properties: [{ name: "connection:origin", value: "actual-bundler-inputs" }, { name: "connection:inputs", value: JSON.stringify(component.inputs) }] };
  });
  return { ...imageSbom, metadata: { ...imageSbom.metadata, component: { type: "container", name: subject.image, version: subject.tag, hashes: [{ alg: "SHA-256", content: subject.digest.slice(7) }] }, properties: [{ name: "connection:source-sha", value: subject.sourceSha }, { name: "connection:coverage", value: "final-image-and-actual-bundler-inputs" }] }, components: [...imageSbom.components, ...runtime, ...bundled] };
}

export function releaseManifest(subject, sbomBytes, bundleBytes, snapshotBytes, provenanceBytes, licenseHashes) {
  validateSubject(subject);
  const snapshot = JSON.parse(snapshotBytes); const provenance = JSON.parse(provenanceBytes);
  requireValue(snapshot.version === 1 && snapshot.providers?.length > 0 && provenance.source?.commit, "Missing executor provenance");
  for (const provider of snapshot.providers) requireValue(provider.providerReleaseId && digest.test(provider.executorDigest) && provider.actions?.length > 0, "Invalid executor identity");
  requireValue(subject.application !== "connection-api" || ["LICENSE.txt", "NOTICE.md", "PROVENANCE.json"].every((name) => /^[a-f0-9]{64}$/.test(licenseHashes?.[name] ?? "")), "Missing Kernel license artifacts");
  return { ...subject, encoding: "connection-release-json-bytes-v1", sbomSha256: hash(sbomBytes), bundleInventorySha256: hash(bundleBytes), snapshotSha256: hash(snapshotBytes), kernelProvenanceSha256: hash(provenanceBytes), providers: snapshot.providers, kernel: provenance.source, licenseHashes };
}

function trustedCosign() {
  const binary = execFileSync("which", ["cosign"], { encoding: "utf8" }).trim();
  requireValue(tools.cosign[process.platform]?.includes(hash(readFileSync(binary))), "Unapproved cosign binary");
  return binary;
}

function runCosign(binary, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COSIGN_|SIGSTORE_|FULCIO_|REKOR_)/.test(key)));
  try { return execFileSync(binary, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new Error("Trusted signature verification failed"); }
}

export function verifiedEvidencePayload(output, subject) {
  let parsed;
  try { parsed = JSON.parse(output); }
  catch { parsed = output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  const responses = Array.isArray(parsed) ? parsed : [parsed];
  requireValue(responses.length > 0, "Missing verified attestation");
  const matches = responses.map((item) => JSON.parse(Buffer.from(item.payload, "base64").toString("utf8"))).filter((statement) => statement.predicateType === predicateType && statement.subject?.length === 1 && statement.subject[0].digest?.sha256 === subject.digest.slice(7));
  requireValue(matches.length === 1, "Ambiguous or wrong attestation subject");
  return matches[0].predicate;
}

export function validateEvidenceBytes(evidence, subject, expected) {
  const bytes = (key) => {
    requireValue(typeof evidence?.[key] === "string" && evidence[key].length > 0 && evidence[key].length < 16 * 1024 * 1024, "Missing or oversized signed evidence");
    return Buffer.from(evidence[key], "base64");
  };
  const manifestBytes = bytes("manifest"); const sbomBytes = bytes("sbom"); const bundleBytes = bytes("bundleInventory");
  const manifest = JSON.parse(manifestBytes); validateSubject(manifest);
  for (const key of ["sourceSha", "tag", "image", "digest", "application", "repositoryId"]) requireValue(manifest[key] === subject[key], "Evidence release mismatch");
  requireValue(manifest.encoding === "connection-release-json-bytes-v1" && manifest.sbomSha256 === hash(sbomBytes) && manifest.bundleInventorySha256 === hash(bundleBytes) && manifest.snapshotSha256 === expected.snapshotSha256 && manifest.kernelProvenanceSha256 === expected.kernelProvenanceSha256, "Evidence hashes mismatch");
  requireValue(JSON.stringify(manifest.providers) === JSON.stringify(expected.providers) && JSON.stringify(manifest.licenseHashes) === JSON.stringify(expected.licenseHashes), "Executor or license provenance mismatch");
  const sbom = JSON.parse(sbomBytes);
  requireValue(sbom.bomFormat === "CycloneDX" && sbom.metadata?.component?.hashes?.some((entry) => entry.alg === "SHA-256" && entry.content === subject.digest.slice(7)), "SBOM subject mismatch");
  requireValue(sbom.metadata?.properties?.some((entry) => entry.name === "connection:coverage" && entry.value === "final-image-and-actual-bundler-inputs") && sbom.components?.some((entry) => entry.properties?.some((property) => property.name === "connection:origin" && property.value === "actual-bundler-inputs")), "Incomplete SBOM coverage");
  const completed = completeSbom(sbom, JSON.parse(bundleBytes), subject);
  const requiredComponents = completed.components.slice(sbom.components.length);
  const origins = new Set(["actual-bundler-inputs", "final-image-runtime-matches-build-runtime"]);
  const signedComponents = sbom.components.filter((component) => component.properties?.some((property) => property.name === "connection:origin" && origins.has(property.value)));
  const records = (components) => components.map((component) => JSON.stringify(component)).sort();
  requireValue(JSON.stringify(records(signedComponents)) === JSON.stringify(records(requiredComponents)), "Signed SBOM runtime or bundle inventory mismatch");
  return { manifestBytes, sbomBytes, manifestBundle: bytes("manifestBundle"), sbomBundle: bytes("sbomBundle") };
}

export function verifiedImageDigest(signatures, subject) {
  certificateArguments(subject);
  requireValue(Array.isArray(signatures) && signatures.length > 0, "Unsigned image");
  const references = [subject.image, `${subject.image}:${subject.tag}`];
  const digests = new Set(signatures.map((signature) => {
    requireValue(references.includes(signature.critical?.identity?.["docker-reference"]), "Wrong signed image repository");
    const value = signature.critical?.image?.["docker-manifest-digest"];
    requireValue(digest.test(value), "Invalid signed image digest");
    return value;
  }));
  requireValue(digests.size === 1, "Ambiguous signed image");
  return [...digests][0];
}

export function resolveVerifiedSubject(application, version, sourceSha) {
  const subject = { version: 1, repository, repositoryId, application, tag: version, sourceSha, image: `${registry}/${application}` };
  const binary = trustedCosign();
  const signatures = JSON.parse(runCosign(binary, ["verify", ...certificateArguments(subject), `${subject.image}:${version}`]));
  subject.digest = verifiedImageDigest(signatures, subject); validateSubject(subject);
  return subject;
}

export function verifyRelease(subject, expected) {
  validateSubject(subject);
  const binary = trustedCosign(); const args = certificateArguments(subject); const ref = `${subject.image}@${subject.digest}`;
  runCosign(binary, ["verify", ...args, ref]);
  const evidence = verifiedEvidencePayload(runCosign(binary, ["verify-attestation", ...args, "--type", predicateType, ref]), subject);
  const blobs = validateEvidenceBytes(evidence, subject, expected);
  const directory = mkdtempSync(join(tmpdir(), "connection-signature-"));
  try {
    for (const name of ["manifest", "sbom"]) {
      const file = join(directory, `${name}.json`); const bundle = join(directory, `${name}.sigstore.json`);
      writeFileSync(file, blobs[`${name}Bytes`]); writeFileSync(bundle, blobs[`${name}Bundle`]);
      runCosign(binary, ["verify-blob", ...args, "--bundle", bundle, file]);
      requireRepositoryCertificate(JSON.parse(blobs[`${name}Bundle`]));
    }
    return ref;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function expectedSourceEvidence(root = process.cwd()) {
  const snapshot = readFileSync(join(root, "packages/openconnector-adapter/provider-release-snapshot.json"));
  const directory = join(root, "packages/openconnector-kernel");
  const provenance = readFileSync(join(directory, "PROVENANCE.json"));
  return { snapshotSha256: hash(snapshot), kernelProvenanceSha256: hash(provenance), providers: JSON.parse(snapshot).providers,
    licenseHashes: Object.fromEntries(["LICENSE.txt", "NOTICE.md", "PROVENANCE.json"].map((name) => [name, hash(readFileSync(join(directory, name)))])) };
}

export function prepareEvidence(subjectFile, imageSbomFile, bundleFile, outputDirectory, root = process.cwd()) {
  const subject = validateSubject(JSON.parse(readFileSync(subjectFile)));
  const bundleBytes = readFileSync(bundleFile);
  const sbomBytes = jsonBytes(completeSbom(JSON.parse(readFileSync(imageSbomFile)), JSON.parse(bundleBytes), subject));
  const kernelDirectory = join(root, "packages/openconnector-kernel");
  const licenseHashes = Object.fromEntries(["LICENSE.txt", "NOTICE.md", "PROVENANCE.json"].map((name) => [name, hash(readFileSync(join(kernelDirectory, name)))]));
  const manifest = releaseManifest(subject, sbomBytes, bundleBytes, readFileSync(join(root, "packages/openconnector-adapter/provider-release-snapshot.json")), readFileSync(join(kernelDirectory, "PROVENANCE.json")), licenseHashes);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "sbom.cdx.json"), sbomBytes);
  writeFileSync(join(outputDirectory, "manifest.json"), jsonBytes(manifest));
  writeFileSync(join(outputDirectory, "bundle-inventory.json"), bundleBytes);
}

export function packEvidence(directory) {
  const files = { manifest: "manifest.json", sbom: "sbom.cdx.json", bundleInventory: "bundle-inventory.json", manifestBundle: "manifest.sigstore.json", sbomBundle: "sbom.sigstore.json" };
  const evidence = Object.fromEntries(Object.entries(files).map(([name, path]) => [name, readFileSync(join(directory, path)).toString("base64")]));
  const manifest = JSON.parse(Buffer.from(evidence.manifest, "base64"));
  validateEvidenceBytes(evidence, manifest, expectedSourceEvidence());
  requireRepositoryCertificate(JSON.parse(Buffer.from(evidence.manifestBundle, "base64")));
  requireRepositoryCertificate(JSON.parse(Buffer.from(evidence.sbomBundle, "base64")));
  const bytes = jsonBytes(evidence);
  requireValue(!/\/Users\/|\/home\/runner\/work\/|-----BEGIN .*PRIVATE KEY|Authorization:\s*Bearer\s+\S+|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(["manifest.json", "sbom.cdx.json", "bundle-inventory.json"].map((file) => readFileSync(join(directory, file), "utf8")).join("\n")), "Unsafe publication evidence");
  writeFileSync(join(directory, "evidence.json"), bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "subject" && args.length === 4) {
    const [application, version, sourceSha, imageDigest] = args;
    console.log(JSON.stringify(validateSubject({ version: 1, repository, repositoryId, application, tag: version, sourceSha, image: `${registry}/${application}`, digest: imageDigest })));
  }
  else if (command === "prepare" && args.length === 4) prepareEvidence(...args);
  else if (command === "pack" && args.length === 1) packEvidence(args[0]);
  else if (command === "verify" && args.length === 1) {
    const subject = validateSubject(JSON.parse(readFileSync(args[0])));
    console.log(verifyRelease(subject, expectedSourceEvidence()));
  }
  else throw new Error("Usage: connection-supply-chain.mjs prepare SUBJECT IMAGE_SBOM BUNDLE OUTPUT");
  } catch { console.error("Connection release evidence refused"); process.exitCode = 1; }
}
