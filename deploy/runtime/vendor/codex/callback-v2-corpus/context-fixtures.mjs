import {
  trustedConnectionProfile,
  userConnectionSlot,
} from "./connection-fixtures.mjs";

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
  recordUnavailableOutcome,
} from "./operation-fixtures.mjs";

import {
  connectionBootstrapRequest,
  executeActionDispatch,
} from "./request-fixtures.mjs";

export const lostResponseContext = {
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
  "independentlyAuthenticatedQuery": authenticatedRecordQuery
};

export const authenticatedExecutionContext = {
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
  "journaledOriginalResponse": originalResponse
};

export const metadataUpdateContext = {
  "now": 1800000000350,
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
  "storedTerminal": recordUnavailableOutcome
};
