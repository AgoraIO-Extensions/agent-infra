export const metadata = {
  "corpusVersion": 1,
  "schemaId": "urn:agent-infra:codex-mandatory-callback:v2",
  "fakeDataOnly": true,
  "maximumFrameUtf8Bytes": 16384,
  "notes": [
    "schemaValid is the AJV structural expectation only. Semantic cases require the production/native harness to enforce the listed trusted context; this file is not service delivery or runtime proof.",
    "No network request is needed to load this corpus. All identifiers/tokens/HTTPS domains are synthetic.",
    "Existing V1 frames are structurally accepted, but Connection dispatch via legacy V1 is a semantic denial.",
    "Authentication observations in context must be produced by controlled transport injection in integration tests, never accepted as caller assertions."
  ]
};
