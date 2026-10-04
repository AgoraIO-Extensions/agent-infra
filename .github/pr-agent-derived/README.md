# PR-Agent plain-diff derived runtime

This directory contains the smallest upstream compatibility patch for Issue #1304.
It preserves parsed files only for the `PlainDiffGitProvider`; GitHub provider filtering,
token caps, required checks, Publisher isolation, and Coverage validation are unchanged.

The patch is based on upstream commit `8e5a9295973b24af4b70cafd0b660a230811ef9e` (`v0.47.0`)
and the pinned official image `sha256:548b760b81ab4b3f729182428695ccc1194bbf87528c2b1e2b2b07e5223af7b6`.
The patch file SHA-256 is
`2c104ce92d670705e9fb2910660dba040f29ca98d4f7b25853b6294ba02e5cae`.

The Dockerfile verifies the three upstream source hashes, applies the single patch with the
standard `patch` utility, compiles the changed Python modules, and removes the build utility.
The image must be built with OCI provenance/SBOM attestation. Its resulting digest is not
recorded here until an authorized build publishes and reads it back; the existing workflow
continues to use the official image until that digest and the native receipts are accepted.

The patch adds an explicit `preserve_all_files` capability to language sorting. Only
`PlainDiffGitProvider` opts in; all other providers retain the default filtering path.
