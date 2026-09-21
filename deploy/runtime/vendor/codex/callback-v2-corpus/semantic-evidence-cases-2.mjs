import {
  authenticatedExecutionContext,
} from "./context-fixtures.mjs";

import {
  differentRecordQuery,
  originalResponse,
  verifiedRecordQuery,
} from "./evidence-fixtures.mjs";

import {
  connectionToolIdentity,
} from "./identity-fixtures.mjs";

import {
  executeActionRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "semantic-reject-record-ref-mismatch",
    "layer": "semantic",
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
        "verification": "verified",
        "originalResponse": originalResponse,
        "recordQuery": differentRecordQuery,
        "verifiedAt": 1800000000200
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "EVIDENCE_BINDING",
      "effect": "reject_verified_association"
    }
  },
  {
    "id": "semantic-reject-verified-time-in-future",
    "layer": "semantic",
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
        "verification": "verified",
        "originalResponse": originalResponse,
        "recordQuery": verifiedRecordQuery,
        "verifiedAt": 1800000100000
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "EVIDENCE_TIME",
      "effect": "reject_verified_association"
    }
  }
];
