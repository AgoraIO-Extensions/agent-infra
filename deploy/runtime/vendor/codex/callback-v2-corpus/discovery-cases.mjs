import {
  connectionToolIdentity,
} from "./identity-fixtures.mjs";

import {
  getActionGuideRequest,
  listAppsRequest,
  listConnectionsRequest,
  searchActionsRequest,
} from "./request-fixtures.mjs";

export const cases = [
  {
    "id": "v2-discovery-list_apps-intent",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": listAppsRequest
    },
    "schemaValid": true
  },
  {
    "id": "v2-discovery-list_apps-outcome-without-association",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": listAppsRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed"
    },
    "schemaValid": true
  },
  {
    "id": "v2-discovery-list_connections-intent",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": listConnectionsRequest
    },
    "schemaValid": true
  },
  {
    "id": "v2-discovery-list_connections-outcome-without-association",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": listConnectionsRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed"
    },
    "schemaValid": true
  },
  {
    "id": "v2-discovery-search_actions-intent",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": searchActionsRequest
    },
    "schemaValid": true
  },
  {
    "id": "v2-discovery-search_actions-outcome-without-association",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": searchActionsRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed"
    },
    "schemaValid": true
  },
  {
    "id": "v2-discovery-get_action_guide-intent",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "intent",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": getActionGuideRequest
    },
    "schemaValid": true
  },
  {
    "id": "v2-discovery-get_action_guide-outcome-without-association",
    "layer": "schema",
    "frame": {
      "schemaVersion": 2,
      "requestId": "00000000-0000-4000-8000-000000000007",
      "phase": "outcome",
      "identity": connectionToolIdentity,
      "occurredAt": 1800000000000,
      "connectionRequest": getActionGuideRequest,
      "permitId": "00000000-0000-4000-8000-000000000008",
      "outcome": "completed"
    },
    "schemaValid": true
  }
];
