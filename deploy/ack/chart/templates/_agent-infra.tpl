{{/*
Environment resource and configuration projections.
*/}}

{{/* Content-addressed name: <base>-<first 10 hex of sha256(files)>. */}}
{{- define "agentInfra.hashedName" -}}
{{- printf "%s-%s" .base (toJson .files | sha256sum | trunc 10) -}}
{{- end }}

{{/* Non-secret opt-in projection; keep hashing and Secret bytes on the same files. */}}
{{/* The deployment-owned publication credential is mounted separately. Only the adapters
and release-pinned publication IDs are part of the hashed configuration. */}}
{{- define "agentInfra.addPublicationConfiguration" -}}
{{- $root := .root -}}
{{- $files := .files -}}
{{- $pub := $root.Values.automaticTemplatePublication -}}
{{- if $pub.enabled -}}
{{- if not $root.Values.configuration.enabled -}}{{- fail "automaticTemplatePublication requires configuration.enabled" -}}{{- end -}}
{{- $file := "template-publication.mjs" -}}
{{- if hasKey $files $file -}}{{- fail "automaticTemplatePublication conflicts with reserved template-publication.mjs" -}}{{- end -}}
{{- $module := required "automaticTemplatePublication requires configuration.mjs for both API and Worker" (index $files "configuration.mjs") | b64dec -}}
{{- $declaration := "import {createApiPublicationConfiguration} from './template-publication.mjs';\nexport const automaticTemplatePublication=createApiPublicationConfiguration();" -}}
{{- $bootstrap := $pub.bootstrapPrepareIds | default dict -}}
{{- if $bootstrap -}}
{{- if or (ne (dig "version" "" ($root.Values.deploymentRelease | default dict)) "v0.1.7") (ne (dig "source" "sha" "" $root.Values.deploymentRelease) "e423c29734e17aad2414c2ed09fba6dc0586ee21") (not $root.Values.files.enabled) (not (empty $pub.publicationIds)) (ne (len $bootstrap) (len (uniq (values $bootstrap)))) -}}
{{- fail "bootstrapPrepareIds requires the original v0.1.7 release, first-party Files identity, distinct IDs and empty publicationIds" -}}
{{- end -}}
{{- if eq .component "api" -}}
{{- if or (hasKey $files "bootstrap-deployment.mjs") (hasKey $files "template-publication-bootstrap.mjs") -}}{{- fail "reserved publication bootstrap module is already configured" -}}{{- end -}}
{{- $declaration = "" -}}
{{- $_ := set $files "template-publication-bootstrap.mjs" ($root.Files.Get "files/template-publication-bootstrap.mjs" | b64enc) -}}
{{- $entry := printf `export * from '/app/dist/deployment.mjs';
import * as deployment from '/app/dist/deployment.mjs';
import {createAutomaticTemplatePublicationAppV1} from '/app/dist/index.mjs';
import {createApiPublicationConfiguration} from './template-publication.mjs';
import {createBootstrapPublicationRoutes} from './template-publication-bootstrap.mjs';
const assembly = await deployment.createPlatformApiAssemblyInput();
export const createPlatformApiAssemblyInput = () => assembly;
export const standardTemplateReleaseApp = createBootstrapPublicationRoutes({
  ids: %s, assembly, configuration: createApiPublicationConfiguration(),
  createApp: createAutomaticTemplatePublicationAppV1, original: deployment.standardTemplateReleaseApp,
});` (toJson $bootstrap) -}}
{{- $_ := set $files "bootstrap-deployment.mjs" ($entry | b64enc) -}}
{{- end -}}
{{- end -}}
{{- if eq .component "worker" -}}
{{- $ids := $pub.publicationIds | default dict -}}
{{- if ne (len (values $ids)) (len (uniq (values $ids))) -}}{{- fail "automaticTemplatePublication requires a distinct publication ID for each template" -}}{{- end -}}
{{- $catalog := list -}}
{{- range $template, $id := $ids -}}
{{- $encoded := required (printf "publication %s needs the current API validation receipt for %s" $id $template) (index $root.Values.configuration.api (printf "template-validation-%s.json" $template)) -}}
{{- $receipt := $encoded | b64dec | fromJson -}}
{{- $candidate := $receipt.candidate | default dict -}}
{{- $digest := $candidate.imageDigest | default "" -}}
{{- $releaseDigest := dig "manifests" "templates-amd64" "images" $template "digest" "" ($root.Values.deploymentRelease | default dict) -}}
{{- if or (ne ($receipt.schemaVersion | int) 2) (ne $template $candidate.templateId) (not (regexMatch "^sha256:[a-f0-9]{64}$" $digest)) (and $releaseDigest (ne $releaseDigest $digest)) -}}
{{- fail (printf "publication %s does not match the adopted catalog for %s" $id $template) -}}
{{- end -}}
{{- $revision := required "publication candidate has no catalog revision" $candidate.configurationRevision -}}
{{- $installation := required "publication candidate has no installation" (dig "adoption" "target" "installationId" "" $receipt) -}}
{{- $catalog = append $catalog (dict "templateId" $template "publicationId" $id "targetImageDigest" $digest "catalogRevision" $revision "deploymentRef" $installation) -}}
{{- end -}}
{{- $declaration = printf "import {createWorkerPublicationConfiguration} from './template-publication.mjs';\nexport const automaticTemplatePublications=process.env.AGENT_INFRA_CACHE_PLAN_COLLECTOR === 'true' ? [] : await createWorkerPublicationConfiguration(%s,%s);" (toJson $pub.origin) (toJson $catalog) -}}
{{- end -}}
{{- $_ := set $files $file ($root.Files.Get "files/template-publication.mjs" | b64enc) -}}
{{- $_ := set $files "configuration.mjs" (printf "%s\n%s\n" $module $declaration | b64enc) -}}
{{- end -}}
{{- end }}

{{- define "agentInfra.publicationVolume" -}}
{{- if not .Values.configuration.enabled -}}{{- fail "automaticTemplatePublication requires configuration.enabled" -}}{{- end -}}
- name: template-publication
  secret:
    secretName: {{ required "automaticTemplatePublication requires secretRef.name" .Values.automaticTemplatePublication.secretRef.name | quote }}
    defaultMode: 288
    items: [{key: {{ required "automaticTemplatePublication requires secretRef.key" .Values.automaticTemplatePublication.secretRef.key | quote }}, path: publications.json}]
{{- end }}

{{- define "agentInfra.apiConfigurationFiles" -}}
{{- $files := deepCopy (.Values.configuration.api | default dict) -}}
{{- $policy := .Values.applicationCredentialMaterialDelivery | default dict -}}
{{- if $policy.enabled -}}
{{- if not .Values.configuration.enabled -}}{{- fail "applicationCredentialMaterialDelivery needs configuration.enabled" -}}{{- end -}}
{{- $module := required "applicationCredentialMaterialDelivery needs configuration.api.configuration.mjs" (index $files "configuration.mjs") | b64dec -}}
{{- if regexMatch "(?m)^export[[:space:]]+(const|let|var)[[:space:]]+applicationCredentialMaterialDelivery" $module -}}
{{- fail "applicationCredentialMaterialDelivery conflicts with an existing module export" -}}
{{- end -}}
{{- $declaration := dict "schemaVersion" $policy.schemaVersion "enabled" true "publicOrigin" .Values.publicOrigin "recipients" $policy.recipients -}}
{{- $_ := set $files "configuration.mjs" (printf "%s\nexport const applicationCredentialMaterialDelivery=%s;\n" $module (toJson $declaration) | b64enc) -}}
{{- end -}}
{{- include "agentInfra.addPublicationConfiguration" (dict "root" . "component" "api" "files" $files) -}}
{{- toJson $files -}}
{{- end }}

{{/* Name of the API configuration Secret mounted at /app/deployment. */}}
{{- define "agentInfra.apiConfigurationSecret" -}}
{{- if .Values.configuration.enabled -}}
{{- include "agentInfra.hashedName" (dict "base" .Values.secrets.apiConfiguration "files" (include "agentInfra.apiConfigurationFiles" . | fromJson)) -}}
{{- else -}}
{{- .Values.secrets.apiConfiguration -}}
{{- end -}}
{{- end }}

{{/* Name of the Worker configuration Secret. */}}
{{- define "agentInfra.workerConfigurationSecret" -}}
{{- if .Values.configuration.enabled -}}
{{- include "agentInfra.hashedName" (dict "base" .Values.secrets.workerConfiguration "files" (include "agentInfra.workerConfigurationFiles" . | fromJson)) -}}
{{- else -}}
{{- .Values.secrets.workerConfiguration -}}
{{- end -}}
{{- end }}

{{/*
Checksum of the chart-owned Secrets a component reads, so a change to one of
them rolls only that component. Args: dict "root" $ "names" (list ...).
*/}}
{{- define "agentInfra.secretsChecksum" -}}
{{- $root := .root -}}
{{- $selected := dict -}}
{{- range .names -}}
{{- $item := index $root.Values.chartSecrets.items . -}}
{{- if $item -}}
{{- $_ := set $selected . $item -}}
{{- end -}}
{{- end -}}
{{- toJson $selected | sha256sum | trunc 16 -}}
{{- end }}

{{/* Pod-template annotation block for a component. Args: dict "root" $ "names" (list ...) "extra" string. */}}
{{- define "agentInfra.podAnnotations" -}}
{{- if or .root.Values.chartSecrets.enabled .extra }}
annotations:
  {{- if .root.Values.chartSecrets.enabled }}
  agent-infra.agora.io/secrets-checksum: {{ include "agentInfra.secretsChecksum" (dict "root" .root "names" .names) | quote }}
  {{- end }}
  {{- with .extra }}
  agent-infra.agora.io/source-checksum: {{ . | quote }}
  {{- end }}
{{- end }}
{{- end }}

{{/* Web entry path for the Connection console. The path is independent of callback credentials. */}}
{{- define "agentInfra.connectionWebPath" -}}
{{- $platformApi := .Values.platformApi | default dict -}}
{{- if ($platformApi.connectionSystemAccess | default dict).enabled -}}
{{- required "platformApi.connectionWebPath is required when Connection system access is enabled" $platformApi.connectionWebPath -}}
{{- else -}}
{{- $platformApi.connectionWebPath | default "" -}}
{{- end -}}
{{- end }}

{{/*
One-time system Connection access (#4157 AC-5). Values contain only the approved deployment
fields. The helper assembles the immutable runtime projection and verifies the approval
fingerprint before the API receives it.
*/}}
{{- define "agentInfra.connectionSystemAccess" -}}
{{- $access := .Values.platformApi.connectionSystemAccess | default dict -}}
{{- if eq ($access.enabled | default false) true }}
{{- if hasKey $access "consumerId" }}{{- fail "platformApi.connectionSystemAccess must not name a Consumer" }}{{- end }}
{{- $origin := required "platformApi.connectionSystemAccess.publicOrigin is required" $access.publicOrigin -}}
{{- $issuer := required "platformApi.connectionSystemAccess.issuer is required" $access.issuer -}}
{{- if not (hasPrefix (printf "%s/" $origin) $issuer) }}{{- fail "platformApi.connectionSystemAccess.issuer must be on publicOrigin" }}{{- end }}
{{- if or (hasPrefix "//" $access.mcpPath) (regexMatch `(^|/)\.{1,2}(/|$)` $access.mcpPath) (regexMatch `(?i)%(?:2f|2e|5c)` $access.mcpPath) }}{{- fail "platformApi.connectionSystemAccess.mcpPath must be a safe absolute path" }}{{- end }}
{{- $system := dict "schemaVersion" 1 "publicOrigin" $origin "mcpPath" $access.mcpPath "audience" $access.audience "egressProfile" $access.egressProfile "issuer" $issuer "oauthCallbackUrl" $access.oauthCallbackUrl -}}
{{- $fingerprint := sha256sum (toRawJson (list "connection-system-access/v1" $origin $access.mcpPath $access.audience $access.egressProfile.ref $access.egressProfile.revision $issuer $access.oauthCallbackUrl)) -}}
{{- $approval := required "platformApi.connectionSystemAccess.approval is required" $access.approval -}}
{{- if ne $approval.egressEnforced true }}{{- fail "platformApi.connectionSystemAccess.approval.egressEnforced must be true" }}{{- end }}
{{- if ne ($approval.configFingerprint | default "") $fingerprint }}{{- fail (printf "platformApi.connectionSystemAccess.approval.configFingerprint must be the approved fingerprint of these fields (%s)" $fingerprint) }}{{- end }}
- {name: AGENT_INFRA_CONNECTION_SYSTEM_ACCESS, value: {{ toRawJson $system | quote }}}
- {name: AGENT_INFRA_CONNECTION_SYSTEM_ACCESS_APPROVAL, value: {{ toRawJson (dict "schemaVersion" 1 "configFingerprint" $approval.configFingerprint "egressEnforced" $approval.egressEnforced "source" $approval.source) | quote }}}
- {name: AGENT_INFRA_CONNECTION_CONFIG_VERSION, value: {{ printf "1-%s" $fingerprint | quote }}}
{{- end }}
{{- end }}

{{/*
"true" when a configuration module declares the export. Args: dict "module" text "name" export
"allowUndefined" bool (an `export const <name> = undefined;` line then does not count).
*/}}
{{- define "agentInfra.moduleDeclares" -}}
{{- $name := .name -}}
{{- $allow := .allowUndefined -}}
{{- $trivia := `(?:[[:space:]]|/\*.*?\*/|//[^\n]*(?:\n|$))*` -}}
{{- /* Wildcard re-exports can hide any reserved setting in another module. */ -}}
{{- if regexMatch (printf `(?s)\bexport%s\*` $trivia) .module }}true{{ end -}}
{{- range regexFindAll (printf `(?s)\bexport%s(?:const|let|var|class|function\*?|async%sfunction\*?)%s%s\b[^\n]*` $trivia $trivia $trivia $name) .module -1 -}}
{{- if not (and $allow (regexMatch (printf `^export[[:space:]]+(?:const|let|var)[[:space:]]+%s[[:space:]]*=[[:space:]]*undefined[[:space:]]*;?[[:space:]]*$` $name) .)) }}true{{ end -}}
{{- end -}}
{{- if regexMatch (printf `\bas[[:space:]]+%s\b` $name) .module }}true{{ end -}}
{{- /* Braced exports can override the shared projection without a declaration on that line. */ -}}
{{- if regexMatch (printf `(?s)\bexport%s\{[^}]*\b%s\b[^}]*\}` $trivia $name) .module }}true{{ end -}}
{{- end }}

{{/*
#4199 C2 preflight (Spec §13.5.1; Runtime SHOULD on #4331). The API and the Worker take the exception
gate decision from the same projected inputs, so the route opens and closes together. Fails the
render when only one side could open it, when the two sides could read different inputs, or when the
enabled route misses its Worker transport or a Secret reference. Messages name value paths only.
*/}}
{{- define "agentInfra.connectionManualInstallationPreflight" -}}
{{- $manual := .Values.connectionManualInstallation | default dict -}}
{{- $enabled := eq ($manual.enabled | default false) true -}}
{{- $configuration := .Values.configuration | default dict -}}
{{- if and $enabled (not $configuration.enabled) -}}
{{- fail "connectionManualInstallation needs configuration.enabled: the chart adds the Worker install transport to the Worker configuration module" -}}
{{- end -}}
{{- if $configuration.enabled -}}
{{- $modules := dict "api" (index ($configuration.api | default dict) "configuration.mjs" | default "" | b64dec) "worker" (index ($configuration.worker | default dict) "configuration.mjs" | default "" | b64dec) -}}
{{- range $component, $module := $modules -}}
{{- /* Module exports override the env projection on that side only. */ -}}
{{- range list "connectionConsistencyExceptionApproval" "connectionManualInstallationClientName" "connectionInstallBootstrap" "connectionInstallWorker" -}}
{{- if include "agentInfra.moduleDeclares" (dict "module" $module "name" . "allowUndefined" (not (and $enabled (eq $component "worker")))) -}}
{{- fail (printf "configuration.%s configuration.mjs exports %s; the exception route is set only by connectionManualInstallation, for the API and the Worker together" $component .) -}}
{{- end -}}
{{- end -}}
{{- if $enabled -}}
{{- range list "connectionSystemAccess" "connectionSystemAccessApproval" "connectionConsumerProfile" "connectionConsumerProfileApproval" "connectionConsumerApproval" -}}
{{- if include "agentInfra.moduleDeclares" (dict "module" $module "name" . "allowUndefined" true) -}}
{{- fail (printf "connectionManualInstallation: configuration.%s configuration.mjs exports %s, so that side would not read the shared system access projection" $component .) -}}
{{- end -}}
{{- end -}}
{{- if regexMatch `\bagentInfraConnectionInstall` $module -}}
{{- fail (printf "connectionManualInstallation: configuration.%s configuration.mjs already uses the agentInfraConnectionInstall prefix" $component) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if $enabled -}}
{{- if not (index ($configuration.worker | default dict) "configuration.mjs") -}}
{{- fail "connectionManualInstallation needs configuration.worker.configuration.mjs" -}}
{{- end -}}
{{- $platformApi := .Values.platformApi | default dict -}}
{{- $access := $platformApi.connectionSystemAccess | default dict -}}
{{- if ne ($access.enabled | default false) true -}}
{{- fail "connectionManualInstallation needs platformApi.connectionSystemAccess.enabled: the API and the Worker read the same system access projection" -}}
{{- end -}}
{{- $callback := $platformApi.connectionCallbackAuthSecretRef | default dict -}}
{{- if not (and $callback.name $callback.key) -}}
{{- fail "connectionManualInstallation needs platformApi.connectionCallbackAuthSecretRef: the API callback file and the Host callback Secret are the same Secret" -}}
{{- end -}}
{{- $approval := $manual.exceptionApproval | default dict -}}
{{- if or (ne (toString $approval.kind) "consistency-exception-v1") (ne (toString $approval.schemaVersion) "1") -}}
{{- fail "connectionManualInstallation.exceptionApproval must be a consistency-exception-v1 record with schemaVersion 1" -}}
{{- end -}}
{{- if ne (toString $approval.systemAccessFingerprint) (toString (dig "approval" "configFingerprint" "" $access)) -}}
{{- fail "connectionManualInstallation.exceptionApproval.systemAccessFingerprint must equal platformApi.connectionSystemAccess.approval.configFingerprint" -}}
{{- end -}}
{{- if or (ne (toString (dig "approvalSource" "ref" "" $approval)) (toString (dig "approval" "source" "ref" "" $access))) (ne (toString (dig "approvalSource" "revision" "" $approval)) (toString (dig "approval" "source" "revision" "" $access))) -}}
{{- fail "connectionManualInstallation.exceptionApproval.approvalSource must equal platformApi.connectionSystemAccess.approval.source" -}}
{{- end -}}
{{- range $ref, $keys := dict "hostCaSecretRef" (list "name" "key") "readbackTlsSecretRef" (list "name" "certKey" "keyKey") "hostTlsSecretRef" (list "name" "certKey" "keyKey") "workerCaSecretRef" (list "name" "key") -}}
{{- $value := index $manual $ref | default dict -}}
{{- range $keys -}}
{{- if not (index $value .) -}}
{{- fail (printf "connectionManualInstallation.%s.%s is required" $ref .) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $readback := int ($manual.readbackPort | default 0) -}}
{{- if or (eq $readback (int ($manual.receiverPort | default 0))) (has $readback (list 3004 (int (dig "nativeMetadataGateway" "port" 3004 (.Values.worker | default dict))))) -}}
{{- fail "connectionManualInstallation.readbackPort must differ from receiverPort and from the Worker internal listener" -}}
{{- end -}}
{{- $versions := splitList "," (toString .Values.worker.keyVersions) -}}
{{- if or (ne (len $versions) 1) (ne (first $versions) (toString .Values.encryption.keyVersion)) -}}
{{- fail "connectionManualInstallation needs worker.keyVersions to be the single encryption.keyVersion: the install keyring file holds that one private key" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/* #4199 C2 env, rendered identically to the API (dict "root" $) and the Worker (dict "root" $ "worker" true). */}}
{{- define "agentInfra.connectionManualInstallationEnv" -}}
{{- include "agentInfra.connectionManualInstallationPreflight" .root -}}
{{- include "agentInfra.connectionManualPublicationPreflight" .root -}}
{{- $manual := .root.Values.connectionManualInstallation | default dict -}}
{{- if eq ($manual.enabled | default false) true -}}
{{- if .worker -}}
{{ include "agentInfra.connectionSystemAccess" .root | trim }}
{{ end -}}
- {name: AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL, value: {{ toRawJson $manual.exceptionApproval | quote }}}
{{- with $manual.clientName }}
- {name: AGENT_INFRA_CONNECTION_MANUAL_CLIENT_NAME, value: {{ . | quote }}}
{{- end }}
{{- if and .worker (eq (($manual.publication | default dict).enabled | default false) true) }}
- {name: AGENT_INFRA_CONNECTION_MANUAL_PUBLICATION_CONTRACT, value: {{ toRawJson $manual.publication.contract | quote }}}
{{- end }}
{{- end -}}
{{- end }}

{{/*
#4199 C2 reader (Spec §13.5.6 工具声明): the approved dynamic publication contract the Worker hands to
Session Hosts. The render fails unless the exception route is on and the contract has the Host
parser's shape, bound to the descriptor's publication contract connection-mcp-publication/1.
Messages name the value path only.
*/}}
{{- define "agentInfra.connectionManualPublicationPreflight" -}}
{{- $manual := .Values.connectionManualInstallation | default dict -}}
{{- $publication := $manual.publication | default dict -}}
{{- if eq ($publication.enabled | default false) true -}}
{{- if ne ($manual.enabled | default false) true -}}
{{- fail "connectionManualInstallation.publication needs connectionManualInstallation.enabled: the Worker hands the contract on only through the open exception route" -}}
{{- end -}}
{{- $message := "connectionManualInstallation.publication.contract must be {serviceRef, contract {ref: connection-mcp-publication, revision: \"1\", serverInfo {name, version}, tools: 1-32}, toolDeclarations: one {name, description (at most 1024), inputSchema} per tool}, at most 64 KiB" -}}
{{- $id := `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` -}}
{{- $value := $publication.contract -}}
{{- if not (kindIs "map" $value) }}{{ fail $message }}{{ end -}}
{{- if ne (keys $value | sortAlpha | join ",") "contract,serviceRef,toolDeclarations" }}{{ fail $message }}{{ end -}}
{{- if not (and (kindIs "string" $value.serviceRef) (regexMatch $id $value.serviceRef)) }}{{ fail $message }}{{ end -}}
{{- $contract := $value.contract -}}
{{- if not (kindIs "map" $contract) }}{{ fail $message }}{{ end -}}
{{- if ne (keys $contract | sortAlpha | join ",") "ref,revision,serverInfo,tools" }}{{ fail $message }}{{ end -}}
{{- if not (and (kindIs "string" $contract.ref) (eq $contract.ref "connection-mcp-publication") (kindIs "string" $contract.revision) (eq $contract.revision "1")) }}{{ fail $message }}{{ end -}}
{{- $server := $contract.serverInfo -}}
{{- if not (kindIs "map" $server) }}{{ fail $message }}{{ end -}}
{{- if ne (keys $server | sortAlpha | join ",") "name,version" }}{{ fail $message }}{{ end -}}
{{- if not (and (kindIs "string" $server.name) (regexMatch $id $server.name) (kindIs "string" $server.version) (regexMatch $id $server.version)) }}{{ fail $message }}{{ end -}}
{{- $tools := $contract.tools -}}
{{- $declarations := $value.toolDeclarations -}}
{{- if not (and (kindIs "slice" $tools) (kindIs "slice" $declarations)) }}{{ fail $message }}{{ end -}}
{{- if or (lt (len $tools) 1) (gt (len $tools) 32) (ne (len $declarations) (len $tools)) }}{{ fail $message }}{{ end -}}
{{- $names := dict -}}
{{- range $tools -}}
{{- if not (kindIs "map" .) }}{{ fail $message }}{{ end -}}
{{- if not (and (kindIs "string" .name) (regexMatch $id .name)) }}{{ fail $message }}{{ end -}}
{{- if hasKey $names .name }}{{ fail $message }}{{ end -}}
{{- $_ := set $names .name false -}}
{{- end -}}
{{- range $declarations -}}
{{- if not (kindIs "map" .) }}{{ fail $message }}{{ end -}}
{{- if ne (keys . | sortAlpha | join ",") "description,inputSchema,name" }}{{ fail $message }}{{ end -}}
{{- if not (and (kindIs "string" .name) (hasKey $names .name)) }}{{ fail $message }}{{ end -}}
{{- if index $names .name }}{{ fail $message }}{{ end -}}
{{- $_ := set $names .name true -}}
{{- if not (and (kindIs "string" .description) (le (len .description) 1024) (kindIs "map" .inputSchema)) }}{{ fail $message }}{{ end -}}
{{- end -}}
{{- if gt (len (toRawJson $value)) 65536 }}{{ fail $message }}{{ end -}}
{{- end -}}
{{- end }}

{{/* #4199 C2 Worker readback origin; the Service below carries the same name and port. */}}
{{- define "agentInfra.connectionInstallWorkerOrigin" -}}
{{- printf "https://agent-infra-worker-connection-install.%s.svc:%d/" .Release.Namespace (int .Values.connectionManualInstallation.readbackPort) -}}
{{- end }}

{{/*
Worker configuration files. With connectionManualInstallation enabled, the module also exports the
install transport (#4199 C2): the Sandbox bootstrap carries only ports, origin, API selector and Secret
references (system access, approval and clientName come from the gate); the Worker side carries file
paths, and its keyring is read from the 0440 Secret mount at import, never from values.
*/}}
{{- define "agentInfra.workerConfigurationFiles" -}}
{{- $files := deepCopy (.Values.configuration.worker | default dict) -}}
{{- $manual := .Values.connectionManualInstallation | default dict -}}
{{- if eq ($manual.enabled | default false) true -}}
{{- include "agentInfra.connectionManualInstallationPreflight" . -}}
{{- $module := index $files "configuration.mjs" | b64dec -}}
{{- $callback := .Values.platformApi.connectionCallbackAuthSecretRef -}}
{{- $bootstrap := dict "port" (int $manual.receiverPort) "workerOrigin" (include "agentInfra.connectionInstallWorkerOrigin" .) "apiSelector" (dict "app.kubernetes.io/name" "agent-infra" "app.kubernetes.io/component" "platform-api") "callbackAuthSecretRef" (dict "name" $callback.name "key" $callback.key) "workerCaSecretRef" (dict "name" $manual.workerCaSecretRef.name "key" $manual.workerCaSecretRef.key) -}}
{{- $hostTls := dict "name" $manual.hostTlsSecretRef.name "certKey" $manual.hostTlsSecretRef.certKey "keyKey" $manual.hostTlsSecretRef.keyKey -}}
{{- $base := "/var/run/agent-infra/connection-install" -}}
{{- $worker := dict "hostCaFile" (printf "%s/host-ca/ca.crt" $base) "readbackCertFile" (printf "%s/readback-tls/tls.crt" $base) "readbackKeyFile" (printf "%s/readback-tls/tls.key" $base) -}}
{{- $code := list
  `import { createPrivateKey as agentInfraConnectionInstallPrivateKey } from "node:crypto";`
  `import { readFileSync as agentInfraConnectionInstallReadFile } from "node:fs";`
  (printf `export const connectionInstallBootstrap={...%s,tlsSecretForSandbox:()=>(%s)};` (toJson $bootstrap) (toJson $hostTls))
  (printf `export const connectionInstallWorker={...%s,keyring:(()=>{try{return{keys:[{keyVersion:%s,privateKeyPkcs8DerBase64:agentInfraConnectionInstallPrivateKey(agentInfraConnectionInstallReadFile(%s)).export({type:"pkcs8",format:"der"}).toString("base64")}]};}catch{throw new Error("CONNECTION_MANUAL_INSTALLATION_WORKER_UNAVAILABLE");}})()};` (toJson $worker) (toJson (toString .Values.worker.keyVersions)) (toJson (printf "%s/keyring/keyring.pem" $base)))
-}}
{{- $_ := set $files "configuration.mjs" (printf "%s\n%s\n" $module (join "\n" $code) | b64enc) -}}
{{- end -}}
{{- include "agentInfra.addPublicationConfiguration" (dict "root" . "component" "worker" "files" $files) -}}
{{- $approvals := .Values.worker.executorInstanceStartupApprovals | default list -}}
{{- if gt (len $approvals) 0 -}}
{{- range $approvals -}}
{{- if not (has .imageDigest ($.Values.worker.executorInstanceStartupApprovedImages | default list)) -}}
{{- fail "executorInstanceStartupApprovals imageDigest is outside the environment approval allowlist" -}}
{{- end -}}
{{- end -}}
{{- if not .Values.configuration.enabled -}}{{- fail "executorInstanceStartupApprovals needs configuration.enabled" -}}{{- end -}}
{{- $module := required "executorInstanceStartupApprovals needs configuration.worker.configuration.mjs" (index $files "configuration.mjs") | b64dec -}}
{{- if regexMatch "(?m)^export[[:space:]]+(const|let|var)[[:space:]]+executorInstanceStartupApprovals" $module -}}
{{- fail "executorInstanceStartupApprovals conflicts with an existing module export" -}}
{{- end -}}
{{- $baseName := "executor-base-configuration.mjs" -}}
{{- if hasKey $files $baseName -}}{{- fail "executorInstanceStartupApprovals conflicts with its reserved base module" -}}{{- end -}}
{{- $_ := set $files $baseName ($module | b64enc) -}}
{{- $wrapper := list
  `import * as base from "./executor-base-configuration.mjs";`
  `export * from "./executor-base-configuration.mjs";`
  `if(!base.workloadInput?.policy || base.executorInstanceStartupApprovals !== undefined || base.workloadInput.policy.executorInstanceStartupApprovals !== undefined) throw new Error("WORKER_EXECUTOR_V2_APPROVAL_CONFIGURATION_CONFLICT");`
  (printf `export const workloadInput={...base.workloadInput,policy:{...base.workloadInput.policy,executorInstanceStartupApprovals:%s}};` (toJson $approvals))
-}}
{{- $_ := set $files "configuration.mjs" (printf "%s\n" (join "\n" $wrapper) | b64enc) -}}
{{- end -}}
{{- toJson $files -}}
{{- end }}

{{- /* API and Worker accept the gateway origin only as http://platform-worker-native-metadata or
http://<release>-platform-worker-native-metadata (platform-api deployment-entry.ts, platform-worker
isNativeMetadataWorkerOriginV1); any other name makes both exit at startup. */}}
{{- define "agentInfra.nativeMetadataServiceName" -}}
{{- $name := printf "%s-platform-worker-native-metadata" .Release.Name -}}
{{- if or (gt (len $name) 63) (not (regexMatch `^[a-z0-9]([-a-z0-9]*[a-z0-9])?-platform-worker-native-metadata$` $name)) }}
{{- fail (printf "native metadata Service name %q is not accepted by the API and Worker" $name) }}
{{- end }}
{{- $name -}}
{{- end }}

{{/* Mount the externally managed credential file alongside Operations configuration. */}}
{{- define "agentInfra.operationsConfigurationVolume" -}}
{{- $ops := .operations }}
{{- if and $ops.prometheusCredentialsSecret $ops.prometheusTLSSecretPrefix }}{{ fail "select one Prometheus authentication method" }}{{ end }}
- name: operations-configuration
  {{- if or $ops.prometheusCredentialsSecret $ops.prometheusTLSSecretPrefix }}
  projected:
    sources:
      - secret:
          name: {{ $ops.configurationSecret | quote }}
      - secret:
          {{- if $ops.prometheusTLSSecretPrefix }}
          name: {{ printf "%s-%s" $ops.prometheusTLSSecretPrefix .component | quote }}
          items:
            - {key: ca.crt, path: prometheus-tls/ca.crt}
            - {key: tls.crt, path: prometheus-tls/tls.crt}
            - {key: tls.key, path: prometheus-tls/tls.key}
          {{- else }}
          name: {{ $ops.prometheusCredentialsSecret | quote }}
          items: [{key: prometheus-credentials.json, path: prometheus-credentials.json}]
          {{- end }}
  {{- else }}
  secret:
    secretName: {{ $ops.configurationSecret | quote }}
  {{- end }}
{{- end }}
