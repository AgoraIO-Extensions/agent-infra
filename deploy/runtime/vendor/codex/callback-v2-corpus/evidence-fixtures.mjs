import {
  connectionIdentity,
} from "./identity-fixtures.mjs";

export const originalReceipt = {
  "callRef": "callref-fixture-a",
  "operationNonce": "00000000-0000-4000-8000-000000000005",
  "attemptNonce": "00000000-0000-4000-8000-000000000006",
  "requestDigestVersion": "connection-request-v1",
  "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
  "principal": {
    "type": "user",
    "key": "connection-user-fixture-a"
  },
  "actorId": "connection-actor-fixture-a",
  "actionVersionId": "action-version-fixture-a"
};

export const originalResponse = {
  "rpcRequestId": 7,
  "receivedAt": 1800000000100,
  "receipt": originalReceipt
};

export const verifiedCallRecord = {
  "callRef": "callref-fixture-a",
  "operationNonce": "00000000-0000-4000-8000-000000000005",
  "requestDigestVersion": "connection-request-v1",
  "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
  "principal": {
    "type": "user",
    "key": "connection-user-fixture-a"
  },
  "actorId": "connection-actor-fixture-a",
  "actionVersionId": "action-version-fixture-a",
  "attemptNonces": [
    "00000000-0000-4000-8000-000000000006"
  ],
  "consumerId": "consumer-codex-fixture",
  "clientId": "oauth-client-fixture"
};

export const differentCallRecord = {
  "callRef": "callref-fixture-b",
  "operationNonce": "00000000-0000-4000-8000-000000000005",
  "requestDigestVersion": "connection-request-v1",
  "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
  "principal": {
    "type": "user",
    "key": "connection-user-fixture-a"
  },
  "actorId": "connection-actor-fixture-a",
  "actionVersionId": "action-version-fixture-a",
  "attemptNonces": [
    "00000000-0000-4000-8000-000000000006"
  ],
  "consumerId": "consumer-codex-fixture",
  "clientId": "oauth-client-fixture"
};

export const recordUnavailableEvidence = {
  "verification": "unverified",
  "reason": "record_unavailable",
  "originalResponse": originalResponse
};

export const authorizationUnavailableEvidence = {
  "verification": "unverified",
  "reason": "authorization_unavailable",
  "originalResponse": originalResponse
};

export const verifiedRecordQuery = {
  "queriedAt": 1800000000200,
  "credentialRevision": "credential-fixture-r1",
  "record": verifiedCallRecord
};

export const differentRecordQuery = {
  "queriedAt": 1800000000200,
  "credentialRevision": "credential-fixture-r1",
  "record": differentCallRecord
};

export const authenticatedRecordQuery = {
  "origin": "https://connection.example.test",
  "path": "/api/client/calls/callref-fixture-a",
  "identity": connectionIdentity,
  "query": verifiedRecordQuery
};

export const verifiedEvidence = {
  "verification": "verified",
  "originalResponse": originalResponse,
  "recordQuery": verifiedRecordQuery,
  "verifiedAt": 1800000000200
};
