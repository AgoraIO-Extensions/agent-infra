# Connection 连接器目录

Connection 按 OpenConnector 的 Provider 目录组织连接器。开发入口在
`packages/openconnector-adapter/src/providers/<名称>/`，运行装配通过
`@agent-infra/openconnector-adapter/providers/<名称>` 导入。

```text
openconnector-adapter/
├── provider-source-layout.json       # 已发布源码的搬迁位置和原始摘要
├── scripts/verify-provider-layout.mjs
└── src/
    ├── provider-catalogs.ts          # 当前目录的统一注册
    ├── provider-fetch.ts             # 共享出口传输
    ├── providers/
    │   ├── github/
    │   ├── bitbucket/
    │   ├── jira/
    │   ├── confluence/
    │   ├── jenkins/
    │   ├── manhattan/
    │   ├── datalego/
    │   ├── static-spaces/
    │   └── rehoboam/
    └── *.ts                         # 旧导入路径的兼容出口
```

每个 Provider 目录有以下入口：

| 文件 | 职责 |
| --- | --- |
| `actions.ts` | 当前能力的 schema、effect 和 scopes；引用同一份已发布定义，避免复制漂移 |
| `definition.ts` | 当前 ProviderRelease、部署及认证 profile、版本和升级兼容证据 |
| `executors.ts` | 执行器、认证及 OAuth 实现的公开入口 |
| `index.ts` | Provider 的包导出 |
| `compatibility.ts` | 有该类证据时保存精确版本的审批兼容证明 |
| `versions/` | 已发布实现、摘要及对应测试；保存原文件字节和旧版本委托关系 |

Jenkins CI/Release 是两个独立部署 profile，使用同一 `jenkins/` 实现；DataLego 的历史 PAT、OAuth
试验和 v4/v5/v6 在同一 Provider 的版本目录内，当前入口选择已发布 v6。Rehoboam 当前入口选择 v11，
v10 及旧版本路由继续按原契约委托。
StaticSpaces 的当前入口保留原真实验收门禁及启用条件，不因目录调整自动开放未验证能力。

已发布版本源码是不可变快照，归档内保留原来的模块边界。目录调整不重写它们，也不改变
ProviderRelease、executor digest、Action schema 或权限，因此不会制造一次没有能力变化的账号升级。
原相对导入仅通过透明出口绑定到同一实现；校验检查实际搬迁后的源文件、兼容出口和跨目录桥接。
源码搬迁 manifest 使用逻辑文件名保留原摘要计算方式，旧 Git tag 的发布门禁仍读取旧布局。

新增连接器在 Provider 目录内组织 actions/definition/executors，只有确实需要共享请求实现时才增加
`runtime.ts`。修改已发布能力产生新的不可变版本及受评审的升级关系，不能原地改归档。
新版本仍使用的旧模块不能仅因旧运行版本下线就删除，清理规则见
[版本生命周期](provider-release-lifecycle.md)。

`openconnector-kernel` 继续保存经审核的上游执行闭包。Connection 的账号、凭据、授权、数据库和审计
仍由 Connection 自己管理；此目录调整不引入上游 Runtime Server 或动态 Provider Loader。
