# 生产部署执行器

`Deploy production` workflow 在 ACK 集群内的临时 runner（标签 `agent-infra-deploy`）上执行 Helm
部署仓库的环境配置与 `agent-infra/deploy.sh prod <command>`，chart 来自执行器同一 main 提交。规则以
[工作流 Spec §10.3](../../docs/architecture/SPEC-ai-native-development-workflow.md#103-生产部署执行器)
为准，本文只说明用法。

## 运行

```bash
gh workflow run deploy-production.yml --ref main -f command=diff
gh workflow run deploy-production.yml --ref main -f command=deploy -f version=v1.2.3 -f helm_commit=<部署仓库 main 的 40 位提交>
gh workflow run deploy-production.yml --ref main -f command=rollback -f revision=<Helm revision>
```

| 命令 | 计划（只读） | 写入 |
| --- | --- | --- |
| `status` | release history 与 Pod | 无 |
| `diff` | 下一次 deploy 的变更 | 无 |
| `verify` | Worker 已加载的容量元组与 profile | 无 |
| `accept` | 业务验收冒烟 | 只写验收账号自己的 Agent 与会话 |
| `deploy` | 审批检查（`deploy.sh prod gate`）与 diff | 审批后 `deploy`，随后 `verify` 与 `accept` |
| `rollback` | 校验目标 revision | 批准后 `helm rollback`；部署负责人随后在部署仓库 revert 对应提交 |

`version` 留空保留生产当前版本；正式 tag 必须已发布并同步到内部 Registry。
较新的 failed/pending release 尝试须先由部署 owner 处置。`helm_commit` 为空时取运行时读到的部署仓库 `main`。哪些情况需要批准、批准后的复检和并发规则见
Spec §10.3；需要批准时，Apply 等待 `production-approval` Environment 的审批。GitHub 只保留一个排队中的
运行，更新的运行会替换它。

## 读取结果

Summary 和 Artifact `deploy-plan-receipt-*`、`deploy-apply-receipt-*` 只含提交、revision、计数和结论。
`diff` 与 `deploy` 还记录部署入口在比较或写入前的内部 Registry 核对：每个渲染 digest 的镜像名（不含
Registry 主机）、digest 与状态；任一 digest 缺失时该步骤失败，不写集群。`deploy` 与 `status` 记录本 lane
ImageCache 按状态的计数；部署不等待缓存 Ready。
部署入口的原始输出保存在集群内，用运维 kubeconfig 读取：

```bash
kubectl -n agent-infra-deployer get secret deploy-log-<run id>-<attempt>-<plan|apply> \
  -o jsonpath='{.data.output\.log\.gz}' | base64 -d | gunzip
```

执行器保留最近 30 份输出。

## 一次性配置

- GitHub Environment `production`：部署分支只允许 `main`，不设审批人；Environment variable
  `KUBERNETES_OIDC_AUDIENCE` 为 API Server 信任的 OIDC client ID。
- GitHub Environment `production-approval`：部署分支只允许 `main`，审批人为部署负责人。
- 集群侧的 runner controller、两组 runner scale set、runner namespace 的 NetworkPolicy、OIDC 身份的
  RBAC 与部署 Secret 由 Helm 部署仓库的 `agent-infra-runners/` 安装，说明见该目录的 README。

执行器启动使用官方 codeload 的固定 main SHA 归档和 runner 自带 Node.js 24，
执行脚本前通过 GitHub API 核对请求 SHA 与归档完整 tree。
App source 归档必须还原已验证的 commit SHA 与完整 tree，保留精确源码与干净工作树检查。
工具下载通过官方 API 的固定 release asset ID，仍以已固定 SHA-256 校验；不改变 Registry 或审批规则。
