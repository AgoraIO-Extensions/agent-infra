# Platform Secret 使用项目内置密文存储

Agent Platform 在 Platform DB 中保存版本化 Secret 密文，由部署环境注入版本化主密钥组，不强制依赖外部 KMS 或 Secret Store 服务。Secret 替换只有在候选 Workload 成功后才激活，主密钥轮换先重新加密历史密文再退役旧密钥。这样既保持开源部署自包含，也保证主密钥不进入仓库、数据库、Agent Pod、日志或用户接口。
