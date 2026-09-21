import {
  recordUnavailableEvidence,
  verifiedEvidence,
} from "./evidence-fixtures.mjs";

import {
  connectionToolIdentity,
} from "./identity-fixtures.mjs";

import {
  executeActionRequest,
} from "./request-fixtures.mjs";

export const connectionIntent = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000007",
  "phase": "intent",
  "identity": connectionToolIdentity,
  "occurredAt": 1800000000000,
  "connectionRequest": executeActionRequest
};

export const connectionPermit = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000007",
  "phase": "intent",
  "identity": connectionToolIdentity,
  "decision": "permit",
  "permitId": "00000000-0000-4000-8000-000000000008",
  "expiresAt": 1800000005000,
  "sourceOwner": {
    "rootThreadId": "thread-fixture-a",
    "rootTurnId": "turn-fixture-a"
  },
  "connectionRequest": executeActionRequest
};

export const recordUnavailableOutcome = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000010",
  "phase": "outcome",
  "identity": connectionToolIdentity,
  "occurredAt": 1800000000210,
  "connectionRequest": executeActionRequest,
  "permitId": "00000000-0000-4000-8000-000000000008",
  "outcome": "completed",
  "connectionEvidence": recordUnavailableEvidence
};

export const connectionEvidenceUpdate = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000011",
  "phase": "connection-evidence",
  "identity": connectionToolIdentity,
  "occurredAt": 1800000000300,
  "connectionRequest": executeActionRequest,
  "permitId": "00000000-0000-4000-8000-000000000008",
  "connectionEvidence": verifiedEvidence
};

export const verifiedOutcome = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000010",
  "phase": "outcome",
  "identity": connectionToolIdentity,
  "occurredAt": 1800000000210,
  "connectionRequest": executeActionRequest,
  "permitId": "00000000-0000-4000-8000-000000000008",
  "outcome": "completed",
  "connectionEvidence": verifiedEvidence
};

export const failedVerifiedOutcome = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000010",
  "phase": "outcome",
  "identity": connectionToolIdentity,
  "occurredAt": 1800000000210,
  "connectionRequest": executeActionRequest,
  "permitId": "00000000-0000-4000-8000-000000000008",
  "outcome": "failed",
  "connectionEvidence": verifiedEvidence,
  "reason": "execution_failed"
};
