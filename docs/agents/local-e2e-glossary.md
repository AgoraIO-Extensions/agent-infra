# Local E2E 术语

## `sourceRevision`

当前 worktree branch 的 upstream 最新 commit SHA。Harness 在运行开始 fetch 并只允许快进
到这个 SHA；它不固定为 `main`。

## `imageBundle`

一次 sourceRevision 对应的镜像集合和不可变 OCI Digest。tag 只帮助发现候选，部署记录和
准入使用 Digest。

## `HarnessRun`

由固定 Compose project、kind cluster、namespace 和 Helm release 组成的一次本地运行。资源
必须带 ownership，清理只作用于当前 HarnessRun。

## `E2E gate`

分层门禁：source/build、deploy/readiness、browser/business 和 conversation。前一层通过不
能替代后一层；测试 fixture 只属于测试层，不构成真实部署或模型验收。

## `deployment adapter`

部署拥有的 `configuration.mjs`。它把 env/Secret 文件和真实目录、Registry、ModelCatalog、
Kubernetes、签名等 factory 组装成 API/Worker 的固定导出契约，不承载产品业务规则。
