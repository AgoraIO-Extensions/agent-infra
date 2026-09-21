import {
  authorizationUnavailableEvidence,
  originalResponse,
} from "./evidence-fixtures.mjs";

import {
  connectionToolIdentity,
} from "./identity-fixtures.mjs";

import {
  connectionEvidenceUpdate,
  connectionIntent,
  connectionPermit,
  failedVerifiedOutcome,
  recordUnavailableOutcome,
  verifiedOutcome,
} from "./operation-fixtures.mjs";

import {
  executeActionRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "v2-connection-intent",
    "layer": "schema",
    "frame": connectionIntent,
    "schemaValid": true
  },
  {
    "id": "v2-connection-permit",
    "layer": "schema",
    "frame": connectionPermit,
    "schemaValid": true
  },
  {
    "id": "v2-connection-started",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000009",
      "phase": "started",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000001,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008"
    },
    "schemaValid": true
  },
  {
    "id": "v2-connection-completed-verified",
    "layer": "schema",
    "frame": verifiedOutcome,
    "schemaValid": true
  },
  {
    "id": "v2-connection-unknown-response-lost",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "unknown",
      "connectionEvidence": {
        "verification": "unverified",
        "reason": "response_unconfirmed"
      },
      "reason": "result_unconfirmed"
    },
    "schemaValid": true
  },
  {
    "id": "v2-connection-unverified-receipt_missing",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed",
      "connectionEvidence": {
        "verification": "unverified",
        "reason": "receipt_missing"
      }
    },
    "schemaValid": true
  },
  {
    "id": "v2-connection-unverified-record_unavailable",
    "layer": "schema",
    "frame": recordUnavailableOutcome,
    "schemaValid": true
  },
  {
    "id": "v2-connection-unverified-authorization_unavailable",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed",
      "connectionEvidence": authorizationUnavailableEvidence
    },
    "schemaValid": true
  },
  {
    "id": "v2-connection-unverified-binding_mismatch",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed",
      "connectionEvidence": {
        "verification": "unverified",
        "reason": "binding_mismatch",
        "originalResponse": originalResponse
      }
    },
    "schemaValid": true
  },
  {
    "id": "v2-connection-unverified-response_unconfirmed",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000210,
      "connectionRequest": executeActionRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed",
      "connectionEvidence": {
        "verification": "unverified",
        "reason": "response_unconfirmed"
      }
    },
    "schemaValid": true
  },
  {
    "id": "v2-connection-failed-with-verified-association",
    "layer": "schema",
    "frame": failedVerifiedOutcome,
    "schemaValid": true
  },
  {
    "id": "v2-connection-outcome-ack",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000010",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "decision": "ack",
      "connectionRequest": executeActionRequest
    },
    "schemaValid": true
  },
  {
    "id": "v2-connection-evidence-update",
    "layer": "schema",
    "frame": connectionEvidenceUpdate,
    "schemaValid": true
  },
  {
    "id": "v2-connection-evidence-update-ack",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000011",
      "phase": "connection-evidence",
      "identity": connectionToolIdentity,
      "decision": "ack",
      "connectionRequest": executeActionRequest
    },
    "schemaValid": true
  }
];
