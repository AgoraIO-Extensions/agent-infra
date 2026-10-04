# Trusted chunk coverage shadow

This package is the TypeScript, job-local boundary for the §7.3.1 recorder and shadow verifier.

`buildGitInventory` reads the immutable `merge-base..head` range with configuration, attributes,
external diff, and checkout execution disabled. `JobLocalRecorder` accepts only the approved JSON
request shape, checks every file and hunk before forwarding the unchanged body, retries the same
logical chunk only, and enforces the three-chunk limit. `serializeMetadata` emits bounded metadata
only; source, prompts, credentials, and the runtime repository path are not persisted.

`verifyShadowMetadata` validates the same run/attempt identity, inventory, file/hunk coverage, and
response summary. It is a shadow consumer and does not publish or replace the existing required
Coverage check. Production activation and shared workflow wiring remain a later hosted gate.
