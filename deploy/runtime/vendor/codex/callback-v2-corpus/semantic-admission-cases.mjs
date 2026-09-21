import {
  applicationBootstrapPermit,
  applicationConnectionSlot,
  userBootstrapPermit,
} from "./connection-fixtures.mjs";

import {
  authenticatedExecutionContext,
  lostResponseContext,
  metadataUpdateContext,
} from "./context-fixtures.mjs";

import {
  authenticatedRecordQuery,
  originalResponse,
  verifiedRecordQuery,
} from "./evidence-fixtures.mjs";

import {
  applicationOriginalBinding,
  connectionService,
  connectionToolIdentity,
  installedIsolation,
} from "./identity-fixtures.mjs";

import {
  connectionEvidenceUpdate,
  connectionIntent,
  connectionPermit,
  failedVerifiedOutcome,
  verifiedOutcome,
} from "./operation-fixtures.mjs";

import {
  connectionBootstrapRequest,
  executeActionDispatch,
  executeActionRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "semantic-bootstrap-original-user",
    "layer": "semantic",
    "frame": userBootstrapPermit,
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": true,
      "rule": "BINDING",
      "effect": "install_original_slot_only"
    }
  },
  {
    "id": "semantic-bootstrap-original-application",
    "layer": "semantic",
    "frame": applicationBootstrapPermit,
    "schemaValid": true,
    "context": {
      "now": 1800000000250,
      "socketBinding": applicationOriginalBinding,
      "socketProcessNonce": "00000000-0000-4000-8000-000000000002",
      "trustedProfile": {
        "profileRef": "connection-fixture-v1",
        "service": connectionService,
        "mcpEndpoint": "https://connection.example.test/mcp",
        "identityEndpoint": "https://connection.example.test/api/client/identity",
        "callsPathPrefix": "https://connection.example.test/api/client/calls/",
        "connectionIdentity": {
          "principal": {
            "type": "application",
            "key": "connection-application-fixture-a"
          },
          "actorId": "connection-actor-fixture-a",
          "consumerId": "consumer-codex-fixture",
          "clientId": "oauth-client-fixture"
        }
      },
      "isolation": installedIsolation,
      "executionActive": true,
      "sourceActive": true,
      "slot": applicationConnectionSlot,
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
      "accept": true,
      "rule": "BINDING",
      "effect": "install_original_slot_only"
    }
  },
  {
    "id": "semantic-intent-original-source-slot",
    "layer": "semantic",
    "frame": connectionIntent,
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": true,
      "rule": "INTENT_BINDING",
      "effect": "persist_descriptor_before_permit"
    }
  },
  {
    "id": "semantic-outcome-all-evidence-matches",
    "layer": "semantic",
    "frame": verifiedOutcome,
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": true,
      "rule": "EVIDENCE_BINDING",
      "effect": "record_one_terminal_fact_and_verified_association"
    }
  },
  {
    "id": "semantic-provider-failure-still-associated",
    "layer": "semantic",
    "frame": failedVerifiedOutcome,
    "schemaValid": true,
    "context": authenticatedExecutionContext,
    "semanticExpected": {
      "accept": true,
      "rule": "OUTCOME_ORTHOGONAL",
      "effect": "record_failed_terminal_with_verified_reference_no_provider_success_claim"
    }
  },
  {
    "id": "semantic-lost-response-lookup-stays-unverified",
    "layer": "semantic",
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
        "reason": "response_unconfirmed",
        "recordQuery": verifiedRecordQuery
      },
      "reason": "result_unconfirmed"
    },
    "schemaValid": true,
    "context": lostResponseContext,
    "semanticExpected": {
      "accept": true,
      "rule": "ORIGINAL_RESPONSE_REQUIRED",
      "effect": "record_unknown_with_unverified_no_guessed_callref"
    }
  },
  {
    "id": "semantic-readonly-metadata-update",
    "layer": "semantic",
    "frame": connectionEvidenceUpdate,
    "schemaValid": true,
    "context": metadataUpdateContext,
    "semanticExpected": {
      "accept": true,
      "rule": "METADATA_ONLY",
      "effect": "upgrade_association_keep_phase_times_counters_and_no_dispatch"
    }
  }
];
