import {
  trustedConnectionProfile,
  userConnectionSlot,
} from "./connection-fixtures.mjs";

import {
  authenticatedExecutionContext,
} from "./context-fixtures.mjs";

import {
  authenticatedRecordQuery,
  originalResponse,
} from "./evidence-fixtures.mjs";

import {
  connectionToolIdentity,
  installedIsolation,
  userOriginalBinding,
} from "./identity-fixtures.mjs";

import {
  connectionIntent,
  connectionPermit,
} from "./operation-fixtures.mjs";

import {
  connectionBootstrapRequest,
  executeActionDispatch,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "semantic-reject-permit-response-descriptor-swap",
    "layer": "semantic",
    "frame": {
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
      "connectionRequest": {
        "slotId": "00000000-0000-4000-8000-000000000076",
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
      }
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "REQUEST_BINDING",
      "effect": "reject_permit"
    }
  },
  {
    "id": "semantic-reject-expired-slot",
    "layer": "semantic",
    "frame": connectionIntent,
    "schemaValid": true,
    "context": {
      "now": 1800000030000,
      "socketBinding": userOriginalBinding,
      "socketProcessNonce": "00000000-0000-4000-8000-000000000002",
      "trustedProfile": trustedConnectionProfile,
      "isolation": installedIsolation,
      "executionActive": true,
      "sourceActive": true,
      "slot": userConnectionSlot,
      "nativeIdentity": connectionToolIdentity,
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      },
      "pendingBootstrapRequest": connectionBootstrapRequest,
      "storedIntent": connectionIntent,
      "storedPermit": connectionPermit,
      "actualDispatch": executeActionDispatch,
      "authenticatedOriginalResponse": originalResponse,
      "independentlyAuthenticatedQuery": authenticatedRecordQuery,
      "journaledOriginalResponse": originalResponse
    },
    "semanticExpected": {
      "accept": false,
      "rule": "SLOT_EXPIRY",
      "effect": "deny_dispatch"
    }
  },
  {
    "id": "semantic-reject-stopped-original-execution",
    "layer": "semantic",
    "frame": connectionIntent,
    "schemaValid": true,
    "context": {
      "now": 1800000000250,
      "socketBinding": userOriginalBinding,
      "socketProcessNonce": "00000000-0000-4000-8000-000000000002",
      "trustedProfile": trustedConnectionProfile,
      "isolation": installedIsolation,
      "executionActive": false,
      "sourceActive": true,
      "slot": userConnectionSlot,
      "nativeIdentity": connectionToolIdentity,
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      },
      "pendingBootstrapRequest": connectionBootstrapRequest,
      "storedIntent": connectionIntent,
      "storedPermit": connectionPermit,
      "actualDispatch": executeActionDispatch,
      "authenticatedOriginalResponse": originalResponse,
      "independentlyAuthenticatedQuery": authenticatedRecordQuery,
      "journaledOriginalResponse": originalResponse
    },
    "semanticExpected": {
      "accept": false,
      "rule": "CURRENT_AUTHORITY",
      "effect": "deny_dispatch"
    }
  },
  {
    "id": "semantic-reject-terminal-native-source",
    "layer": "semantic",
    "frame": connectionIntent,
    "schemaValid": true,
    "context": {
      "now": 1800000000250,
      "socketBinding": userOriginalBinding,
      "socketProcessNonce": "00000000-0000-4000-8000-000000000002",
      "trustedProfile": trustedConnectionProfile,
      "isolation": installedIsolation,
      "executionActive": true,
      "sourceActive": false,
      "slot": userConnectionSlot,
      "nativeIdentity": connectionToolIdentity,
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      },
      "pendingBootstrapRequest": connectionBootstrapRequest,
      "storedIntent": connectionIntent,
      "storedPermit": connectionPermit,
      "actualDispatch": executeActionDispatch,
      "authenticatedOriginalResponse": originalResponse,
      "independentlyAuthenticatedQuery": authenticatedRecordQuery,
      "journaledOriginalResponse": originalResponse
    },
    "semanticExpected": {
      "accept": false,
      "rule": "SOURCE_OWNER",
      "effect": "deny_dispatch"
    }
  },
  {
    "id": "semantic-reject-isolation-not-installed",
    "layer": "semantic",
    "frame": connectionBootstrapRequest,
    "schemaValid": true,
    "context": {
      "now": 1800000000250,
      "socketBinding": userOriginalBinding,
      "socketProcessNonce": "00000000-0000-4000-8000-000000000002",
      "trustedProfile": trustedConnectionProfile,
      "isolation": {
        "actualInstalledState": "manifest-claim-only",
        "nodeBridgeProtected": true,
        "credentialLaneEnabled": true
      },
      "executionActive": true,
      "sourceActive": true,
      "slot": userConnectionSlot,
      "nativeIdentity": connectionToolIdentity,
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      },
      "pendingBootstrapRequest": connectionBootstrapRequest,
      "storedIntent": connectionIntent,
      "storedPermit": connectionPermit,
      "actualDispatch": executeActionDispatch,
      "authenticatedOriginalResponse": originalResponse,
      "independentlyAuthenticatedQuery": authenticatedRecordQuery,
      "journaledOriginalResponse": originalResponse
    },
    "semanticExpected": {
      "accept": false,
      "rule": "ACTUAL_ISOLATION",
      "effect": "do_not_send_bootstrap_or_read_token"
    }
  },
  {
    "id": "semantic-reject-legacy-connection-bypass",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 1,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000
    },
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": false,
      "rule": "CONNECTION_REQUIRES_V2",
      "effect": "deny_dispatch"
    }
  },
  {
    "id": "semantic-reject-replay-changed-frame",
    "layer": "semantic",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": {
        "slotId": "00000000-0000-4000-8000-000000000003",
        "profileRef": "connection-fixture-v1",
        "serviceRef": "connection-fixture",
        "operationNonce": "00000000-0000-4000-8000-000000000077",
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
      }
    },
    "schemaValid": true,
    "context": {
      "now": 1800000000250,
      "socketBinding": userOriginalBinding,
      "socketProcessNonce": "00000000-0000-4000-8000-000000000002",
      "trustedProfile": trustedConnectionProfile,
      "isolation": installedIsolation,
      "executionActive": true,
      "sourceActive": true,
      "slot": userConnectionSlot,
      "nativeIdentity": connectionToolIdentity,
      "sourceOwner": {
        "rootThreadId": "thread-fixture-a",
        "rootTurnId": "turn-fixture-a"
      },
      "pendingBootstrapRequest": connectionBootstrapRequest,
      "storedIntent": connectionIntent,
      "storedPermit": connectionPermit,
      "actualDispatch": executeActionDispatch,
      "authenticatedOriginalResponse": originalResponse,
      "independentlyAuthenticatedQuery": authenticatedRecordQuery,
      "journaledOriginalResponse": originalResponse,
      "seenRequest": {
        "requestId": "00000000-0000-4000-8000-000000000007",
        "frame": connectionIntent
      }
    },
    "semanticExpected": {
      "accept": false,
      "rule": "REPLAY_IMMUTABILITY",
      "effect": "reject_changed_request"
    }
  }
];
