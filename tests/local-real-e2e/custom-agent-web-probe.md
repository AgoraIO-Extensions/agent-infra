# Custom Agent Web probe

This probe checks the request boundary of a deployed custom Web Agent. It requires a protected
HTTPS application URL, the deployment source SHA/image Digest/configuration revision, a stable
HTML content digest, and two application-issued Authorization header files: one allowed principal
and one valid-but-denied principal. Files must be private (`0600`) and are never printed.

The probe sends anonymous, forged-identity-header, invalid-credential, denied-principal and
allowed-principal requests. It rejects redirects, normalized health/readiness paths (`healthz`,
`readyz`, `livez`), oversized or leaking content,
invalid TLS/configuration and unexpected status codes. Run it with:

```bash
node tests/local-real-e2e/custom-agent-web-probe.ts /absolute/private/config.json
```

`401`/`403` responses must have an empty body; any non-empty body is treated as a content leak.
`NODE_EXTRA_CA_CERTS` may point to the reviewed private CA; do not disable TLS verification. The
output contains only bounded case status, declared provenance and pass/fail fields. Provenance
fields are claims that must be compared with Registry/Kubernetes receipts separately.

This probe does not prove LDAP, Registry admission, Kubernetes isolation, browser lifecycle,
revocation, key rotation, stop/restart, upgrade or failed-candidate recovery. Those remain
separate B6 evidence and must use the same deployment tuple and authorized principals.

The separate `custom-agent-platform-auth-probe.ts` uses private Cookie/header files to probe a
platform-auth public boundary. It verifies the same bounded HTTPS/content rules and intentionally
does not claim Gateway, LDAP, browser, revocation or key-rotation deployment evidence.
