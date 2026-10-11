import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateArguments, completeSbom, hash, predicateType, releaseManifest, repository, repositoryId, requireRepositoryCertificate, validateEvidenceBytes, validateSubject, verifiedEvidencePayload } from "../../deploy/connection-supply-chain.mjs";

const subject = { version: 1, repository, repositoryId, application: "connection-api", sourceSha: "a".repeat(40), tag: "connection-v0.0.87", image: "ghcr.io/agoraio-extensions/agent-infra/connection-api", digest: `sha256:${"b".repeat(64)}` };
const bytes = (value) => Buffer.from(JSON.stringify(value));
const bundle = { version: 1, application: "connection-api", buildRuntime: { name: "node", version: "v24.19.0", sha256: "c".repeat(64) }, components: [{ name: "bundled-package", version: "1.0.0", inputs: [{ path: "node_modules/bundled-package/index.js", sha256: "d".repeat(64) }] }] };
const image = { bomFormat: "CycloneDX", specVersion: "1.6", components: [{ type: "library", name: "libc", purl: "pkg:deb/debian/libc6@1.0" }] };
const snapshot = bytes({ version: 1, providers: [{ providerReleaseId: "provider-v1", executorDigest: `sha256:${"e".repeat(64)}`, actions: [{ id: "provider.read@v1" }] }] });
const provenance = bytes({ source: { commit: "f".repeat(40) } });
const licenses = { "LICENSE.txt": "1".repeat(64), "NOTICE.md": "2".repeat(64), "PROVENANCE.json": hash(provenance) };

const expected = { snapshotSha256: hash(snapshot), kernelProvenanceSha256: hash(provenance), providers: JSON.parse(snapshot).providers, licenseHashes: licenses };

function evidence() {
  const sbom = bytes(completeSbom(image, bundle, subject));
  const manifest = bytes(releaseManifest(subject, sbom, bytes(bundle), snapshot, provenance, licenses));
  return { manifest: manifest.toString("base64"), sbom: sbom.toString("base64"), bundleInventory: bytes(bundle).toString("base64"), manifestBundle: bytes({}).toString("base64"), sbomBundle: bytes({}).toString("base64") };
}

test("release identity pins repository, immutable ID, exact workflow/tag/source", () => {
  assert.equal(validateSubject(subject), subject);
  const flags = certificateArguments(subject);
  assert.ok(flags.includes(`https://github.com/${repository}/.github/workflows/publish-ghcr.yml@refs/tags/${subject.tag}`));
  assert.ok(flags.includes(subject.sourceSha));
  for (const change of [{ repository: "other/repo" }, { repositoryId: "999" }, { sourceSha: "main" }, { tag: "v1.0.0" }, { application: "platform-api" }, { image: "ghcr.io/other/image" }, { digest: "latest" }]) assert.throws(() => validateSubject({ ...subject, ...change }));
});

test("SBOM requires actual image OS, runtime and bundled provenance", () => {
  const result = completeSbom(image, bundle, subject);
  assert.ok(result.components.some((component) => component.name === "node" && component.hashes[0].content === bundle.buildRuntime.sha256));
  assert.ok(result.components.some((component) => component.name === "bundled-package"));
  for (const bad of [{ ...bundle, components: [] }, { ...bundle, buildRuntime: undefined }, { ...bundle, application: "connection-web" }, { ...bundle, components: [{ name: "x", inputs: [{ path: "/Users/operator/key", sha256: "d".repeat(64) }] }] }]) assert.throws(() => completeSbom(image, bad, subject));
  assert.throws(() => completeSbom({ ...image, components: [] }, bundle, subject));
  const web = { ...subject, application: "connection-web", image: "ghcr.io/agoraio-extensions/agent-infra/connection-web" };
  assert.throws(() => completeSbom(image, { ...bundle, application: "connection-web" }, web));
});

test("signed byte contract rejects tampered release, SBOM, bundle or snapshot", () => {
  assert.doesNotThrow(() => validateEvidenceBytes(evidence(), subject, expected));
  for (const field of ["manifest", "sbom", "bundleInventory", "manifestBundle", "sbomBundle"]) assert.throws(() => validateEvidenceBytes({ ...evidence(), [field]: "" }, subject, expected));
  const modified = evidence(); const manifest = JSON.parse(Buffer.from(modified.manifest, "base64"));
  manifest.sourceSha = "c".repeat(40); modified.manifest = bytes(manifest).toString("base64");
  assert.throws(() => validateEvidenceBytes(modified, subject, expected));
  assert.throws(() => validateEvidenceBytes({ ...evidence(), sbom: bytes({}).toString("base64") }, subject, expected));
  assert.throws(() => validateEvidenceBytes(evidence(), subject, { ...expected, snapshotSha256: "0".repeat(64) }));
  assert.throws(() => releaseManifest(subject, bytes({}), bytes(bundle), snapshot, provenance, {}));
});

test("attestation must bind exactly one expected subject/predicate", () => {
  const payload = { predicateType, subject: [{ name: subject.image, digest: { sha256: subject.digest.slice(7) } }], predicate: evidence() };
  const output = JSON.stringify([{ payload: bytes(payload).toString("base64") }]);
  assert.deepEqual(verifiedEvidencePayload(output, subject), payload.predicate);
  const envelope = { payload: bytes(payload).toString("base64") };
  assert.deepEqual(verifiedEvidencePayload(JSON.stringify(envelope), subject), payload.predicate);
  const unrelated = { payload: bytes({ ...payload, predicateType: "other" }).toString("base64") };
  assert.deepEqual(verifiedEvidencePayload(JSON.stringify(unrelated)+"\n"+JSON.stringify(envelope)+"\n", subject), payload.predicate);
  assert.throws(() => verifiedEvidencePayload(JSON.stringify([]), subject));
  assert.throws(() => verifiedEvidencePayload(JSON.stringify([{ payload: bytes({ ...payload, subject: [] }).toString("base64") }]), subject));
  assert.throws(() => verifiedEvidencePayload(JSON.stringify([{ payload: bytes(payload).toString("base64") }, { payload: bytes(payload).toString("base64") }]), subject));
});

const der = (type, value) => Buffer.concat([Buffer.from([type, value.length]), value]);
function policyCertificate(id) {
  const extension = der(48, Buffer.concat([der(6, Buffer.from("2b0601040183bf30010f", "hex")), der(4, der(12, Buffer.from(id)))]));
  const certificate = der(48, der(48, der(163, der(48, extension))));
  return { verificationMaterial: { certificate: { rawBytes: certificate.toString("base64") } } };
}

test("immutable repository policy reads only certificate extension, not unsigned JSON claim", () => {
  assert.doesNotThrow(() => requireRepositoryCertificate(policyCertificate(repositoryId)));
  assert.throws(() => requireRepositoryCertificate({ ...policyCertificate("999"), repositoryId }));
  assert.throws(() => requireRepositoryCertificate({ verificationMaterial: { certificate: { rawBytes: "broken" } } }));
  const ambiguous = policyCertificate(repositoryId); ambiguous.verificationMaterial.x509CertificateChain = { certificates: [] };
  assert.throws(() => requireRepositoryCertificate(ambiguous));
});

test("release CLI rejects malformed evidence without echoing credential-like input", () => {
  const directory = mkdtempSync(join(tmpdir(), "connection-evidence-error-"));
  try {
    const file = join(directory, "subject.json");
    writeFileSync(file, 'credential-canary-not-real {');
    const result = spawnSync(process.execPath, ["deploy/connection-supply-chain.mjs", "verify", file], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Connection release evidence refused/);
    assert.equal(`${result.stdout}${result.stderr}`.includes("credential-canary-not-real"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Recompute the manifest hash so these exercise semantic coverage, not byte tampering.
test("signed SBOM rejects omitted, extra or altered runtime and bundle records", () => {
  const mutations = [
    (sbom) => { sbom.components = sbom.components.filter((component) => component.name !== "node"); },
    (sbom) => { sbom.components.find((component) => component.name === "node").hashes[0].content = "0".repeat(64); },
    (sbom) => { const component = sbom.components.find((component) => component.name === "bundled-package"); component.properties.find((property) => property.name === "connection:inputs").value = JSON.stringify([{ path: "node_modules/bundled-package/index.js", sha256: "0".repeat(64) }]); },
    (sbom) => { sbom.components.push(structuredClone(sbom.components.find((component) => component.name === "bundled-package"))); },
  ];
  for (const mutate of mutations) {
    const modified = evidence();
    const sbom = JSON.parse(Buffer.from(modified.sbom, "base64"));
    mutate(sbom);
    const sbomBytes = bytes(sbom);
    modified.sbom = sbomBytes.toString("base64");
    const manifest = JSON.parse(Buffer.from(modified.manifest, "base64"));
    manifest.sbomSha256 = hash(sbomBytes);
    modified.manifest = bytes(manifest).toString("base64");
    assert.throws(() => validateEvidenceBytes(modified, subject, expected), /Signed SBOM runtime or bundle inventory mismatch/);
  }
});
