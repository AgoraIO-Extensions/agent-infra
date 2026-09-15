# Custom Agent Base Image

该镜像是自定义 Agent 的推荐构建起点，使用固定 Digest 的官方 Node.js 24 Alpine 镜像，保留
Node.js、npm 和上游基础工具，默认使用 `node` 用户及 `/workspace`。开发者自行安装应用所需
依赖；它不包含 RuntimeHost、ACP、身份、消息、Connection 或模型配置。

继承关系不赋予平台能力或准入资格。使用其他父镜像的自定义 Agent 仍按相同的 Registry、
不可变 Digest、Runtime Manifest 和实际入口验证规则准入。产品边界见
[平台 PRD](../../../docs/prd/PRD-agent-platform-M1.md#52-base-image)。

## 构建与发布

在已批准 Registry 登录完成、当前提交 CI 通过的 clean checkout 中执行：

```bash
node .github/scripts/install-trivy.mjs .trivy-tool
IMAGE_REPOSITORY_PREFIX=registry.example/agent-infra \
  PLATFORM=linux/amd64 \
  node deploy/release/build-images.mjs /tmp/custom-base-image.json --custom-base-image
```

将示例前缀替换为部署批准的仓库；产物名为 `custom-agent-base`。每次发布用 source commit 和
目标平台组成 Tag，`PLATFORM` 支持 `linux/amd64`、`linux/arm64`，两个平台分别验收，不把单架构
证据当作多架构发布。

Docker daemon 需要能读取探针的绑定挂载路径；使用虚拟机中的 Docker 时，通过 `TMPDIR`
把构建临时目录放到该虚拟机已共享的文件系统中。

该入口复用现有 Git archive、两次无缓存构建和 Digest 一致性检查，验证 non-root、只读根文件
系统和明确可写挂载；对实际待发布 OCI 产物执行现有 Trivy 政策，通过后才推送。扫描失败、
High/Critical 或不合格例外都会阻止发布，例外仍由仓库既有政策校验。

发布后按 Digest 拉取，回读远端 manifest/config，再从该 Digest 构建并运行下游样例。输出 JSON
记录 source commit、父镜像 Digest、Dockerfile SHA-256、目标平台、Base Image Digest、扫描器/
漏洞库版本与摘要、子镜像 Digest 和运行结果；原始扫描证据位于相邻的 `.scan` 目录。
输出 JSON 仅在全部步骤通过后生成，不供 Platform Helm 的 release validator 使用。

## 继承样例

[最小 Dockerfile](../../../tests/fixtures/custom-base-image/Dockerfile) 使用 `ARG BASE_IMAGE` 将已发布
Digest 传给 `FROM`，构建期校验 Node.js 文件，运行期验证用户、只读根文件系统和 `/tmp`、
`/workspace` 可写挂载。它是独立示例，不登记为标准模板。

从发布清单读取真实不可变引用后，可独立重验：

```bash
BASE_IMAGE=$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const { images } = JSON.parse(readFileSync("/tmp/custom-base-image.json", "utf8"));
  console.log(`${images.customBase.repository}@${images.customBase.digest}`);
')
node deploy/release/custom-base-image.mjs \
  "$BASE_IMAGE" /tmp/custom-base-inheritance.json --published
```

真实应用可沿用该 `FROM` 写法并替换样例文件及启动命令；根据自身需要声明可写挂载。
升级时选择新的已验证 Digest、重新构建子镜像并走原有准入，不自动跟随 Tag，不自动升级既有
Agent。
