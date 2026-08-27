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

## v0.2.0 — MCP 网关三态实时管理

远程 MCP 服务器从此由**网关**托管，不再作为启动组合树的阻塞成员：

| 模式 | 行为 |
|---|---|
| `标准 (full)` | 立即真实连接；工具按服务器返回的**完整 inputSchema** 注册 |
| `懒加载 (lazy)` | 仅注册名称级 stub（自由 JSON 参数），连接同样立即建立但走树外异步通道 |
| `停用 (off)`  | 不注册任何工具 |

- MCP 页每行新增「标准 / 懒加载 / 停用」三态按钮，**即时生效、无需重启**（进程内 register/dispose）；
- 无论处于哪种模式，**重启都是快速的**：原生行永久钉扎禁用，网关连接走启动关键路径之外的异步通道；
- 被网关接管的服务器，其原生组合行自动钉扎为 `disabled:true` —— 确保任何一次重启都不会出现"桥 + 原生客户端"双服务的命名空间冲突，也保证启动关键路径零网络等待；
- **修复 v0.1 的 toggleMcp 反转缺陷**（client 漏传 disabled、host 按 `!!undefined=false` 兜底，导致"禁用"恒等于"启用"）；现在 client 显式传目标态，host 支持显式布尔并在缺省时对现状取反；
- 新增回归测试 `tests/server-modes.test.mjs`（15 例）：覆盖模式切换、代际拆除防抢注、legacy lazyServers 迁移、BOM 编码地雷等场景。

### v0.2.1 — 大型服务器自动懒加载策略

- 桥接核心在 `tools/list` 发现已知工具数 **>30** 时，请求的 `full` 自动降级为 `lazy`——降档发生在 schema 注册之前，连一帧的上下文浪费都不会发生；
- 逃生门：条目 config 加 `"fullPreferred": true` 可强制标准模式；
- 实测依据：github-mcp-server(44 工具) 完整注册 ≈**12k–15k tokens/轮**，懒加载 ≈2.2k–2.8k；THX(25 工具) 在阈值内不受影响。

## License

MIT。包含来自 [dsh-extension-hub](https://github.com/Relistencode/dsh-extension-hub)（MIT）
的移植代码。
