export const framingCases = [
  {
    "id": "duplicate-request-id",
    "wireUtf8": "{\"schemaVersion\":2,\"requestId\":\"00000000-0000-4000-8000-000000000001\",\"requestId\":\"00000000-0000-4000-8000-000000000002\",\"phase\":\"connection-bootstrap\",\"profileRef\":\"connection-fixture-v1\",\"processNonce\":\"00000000-0000-4000-8000-000000000002\"}",
    "transportAccept": false,
    "rule": "DUPLICATE_KEYS"
  },
  {
    "id": "invalid-utf8",
    "wireHex": "fffe7b7d",
    "transportAccept": false,
    "rule": "UTF8_STRICT"
  },
  {
    "id": "non-object-json",
    "wireUtf8": "[]",
    "transportAccept": false,
    "rule": "FRAME_OBJECT"
  }
];
