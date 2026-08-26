# dsh-extension-manager（扩展管理）

DeepSeek Harness (DSH) 的扩展管理中心插件：在 Web 设置页管理 **Skills / MCP 服务器 / 插件**。
基于 `dsh-extension-hub`（MIT）的成熟器官重写而成；无导入功能、无插件市场、稳健第一。

## 安装

```sh
dsh plugin --profile web add <本地路径或发布名>
```

或手动安装（本仓库的开发方式）：

1. 把本目录完整复制到 `~/.dsh/profiles/web/node_modules/dsh-extension-manager`；
2. 编辑 `~/.dsh/profiles/web/package.json`，把 `dsh.profile.bundles` 中的
   `"dsh-extension-hub"` 替换为 `"dsh-extension-manager"`（两者不可同时启用——
   它们注册同一个设置页区域）;
3. 重启 `dsh web`，打开 **设置 → 扩展管理**。

> 原先由 extension-hub 写入 `cordis.patch.yml` 托管区块的 MCP 行会继续生效，
> 无需迁移；本插件的托管区块标记为 `# >>> dsh-extension-manager`，与之共存互不干扰。

## 功能

| 标签页 | 能力 |
|---|---|
| Skills | 列表 / 新建 / 编辑 / 删除 / 启用-禁用（官方 frontmatter 语义）；内置与 preset 技能只读保护 |
| MCP 服务器 | 列表 / 添加 / 删除 / 启停（stdio 与 streamable-http）；连通探测（真实 initialize 握手）；pip/npx 升级检测（只报告命令，不代执行）；热重载实验开关 |
| 插件管理 | 官方/第三方分层展示；三级保护（锁死 / 确认 / 自由）；启停、卸载 |

侧边栏底部提供 MCP 实时状态小组件（15s 轮询，可折叠）。

## 稳健性设计

- 所有组合配置写入走五步流水线：预演校验（含全层行 id 查重）→ 备份(5代) →
  原子写 → 回读验证 → 失败自动还原；
- 锁死级组件（loader、webserver、client 运行时、本插件自身等）在 UI 与 RPC 双层拒绝变更；
- 本插件自身初始化失败时降级为空壳，绝不拖垮 harness 启动；
- 热重载开关默认关闭（上游 Web 端 HMR 未充分验证），开启需显式确认。

## License

MIT。包含来自 [dsh-extension-hub](https://github.com/Relistencode/dsh-extension-hub)（MIT）
的移植代码。
