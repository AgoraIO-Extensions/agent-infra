export const executeActionArguments = {
  "actionId": "github.get_issue",
  "input": {
    "number": 1,
    "repository": "fixture/private"
  }
};

export const connectionRecoveryRequest = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000041",
  "phase": "connection-recovery",
  "profileRef": "connection-fixture-v1",
  "processNonce": "00000000-0000-4000-8000-000000000042"
};

export const connectionBootstrapRequest = {
  "schemaVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000001",
  "phase": "connection-bootstrap",
  "profileRef": "connection-fixture-v1",
  "processNonce": "00000000-0000-4000-8000-000000000002"
};

export const executeActionDispatch = {
  "method": "tools/call",
  "toolName": "execute_action",
  "arguments": executeActionArguments,
  "rpcRequestId": 7,
  "profileRef": "connection-fixture-v1",
  "credentialRevision": "credential-fixture-r1",
  "idempotencyKey": "00000000-0000-4000-8000-000000000005",
  "operationNonce": "00000000-0000-4000-8000-000000000005",
  "attemptNonce": "00000000-0000-4000-8000-000000000006"
};

export const listAppsRequest = {
  "slotId": "00000000-0000-4000-8000-000000000003",
  "profileRef": "connection-fixture-v1",
  "serviceRef": "connection-fixture",
  "operationNonce": "00000000-0000-4000-8000-000000000005",
  "attemptNonce": "00000000-0000-4000-8000-000000000006",
  "idempotencyKey": "00000000-0000-4000-8000-000000000005",
  "rpcRequestId": 7,
  "requestDigestVersion": "connection-request-v1",
  "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
  "method": "tools/call",
  "toolName": "list_apps"
};

export const searchActionsRequest = {
  "slotId": "00000000-0000-4000-8000-000000000003",
  "profileRef": "connection-fixture-v1",
  "serviceRef": "connection-fixture",
  "operationNonce": "00000000-0000-4000-8000-000000000005",
  "attemptNonce": "00000000-0000-4000-8000-000000000006",
  "idempotencyKey": "00000000-0000-4000-8000-000000000005",
  "rpcRequestId": 7,
  "requestDigestVersion": "connection-request-v1",
  "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
  "method": "tools/call",
  "toolName": "search_actions"
};

export const listConnectionsRequest = {
  "slotId": "00000000-0000-4000-8000-000000000003",
  "profileRef": "connection-fixture-v1",
  "serviceRef": "connection-fixture",
  "operationNonce": "00000000-0000-4000-8000-000000000005",
  "attemptNonce": "00000000-0000-4000-8000-000000000006",
  "idempotencyKey": "00000000-0000-4000-8000-000000000005",
  "rpcRequestId": 7,
  "requestDigestVersion": "connection-request-v1",
  "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
  "method": "tools/call",
  "toolName": "list_connections"
};

export const executeActionRequest = {
  "slotId": "00000000-0000-4000-8000-000000000003",
  "profileRef": "connection-fixture-v1",
  "serviceRef": "connection-fixture",
  "operationNonce": "00000000-0000-4000-8000-000000000005",
  "attemptNonce": "00000000-0000-4000-8000-000000000006",
  "idempotencyKey": "00000000-0000-4000-8000-000000000005",
  "rpcRequestId": 7,
  "requestDigestVersion": "connection-request-v1",
  "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
  "method": "tools/call",
  "toolName": "execute_action",
  "actionSelector": {
    "actionId": "github.get_issue"
  }
};

export const getActionGuideRequest = {
  "slotId": "00000000-0000-4000-8000-000000000003",
  "profileRef": "connection-fixture-v1",
  "serviceRef": "connection-fixture",
  "operationNonce": "00000000-0000-4000-8000-000000000005",
  "attemptNonce": "00000000-0000-4000-8000-000000000006",
  "idempotencyKey": "00000000-0000-4000-8000-000000000005",
  "rpcRequestId": 7,
  "requestDigestVersion": "connection-request-v1",
  "requestDigest": "cbf410928ef1c83e86bb13b4f0a03aa32258d6f48944ebc85d6ea3e93d92a673",
  "method": "tools/call",
  "toolName": "get_action_guide",
  "actionSelector": {
    "actionId": "github.get_issue"
  }
};
