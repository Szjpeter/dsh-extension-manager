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
| MCP 服务器 | 列表 / 添加 / 删除 / 启停（stdio 与 streamable-http）；网关三态管理；连通探测（真实 initialize 握手）；pip/npx 升级检测（只报告命令，不代执行）；热重载实验开关 |
| 插件管理 | 官方/第三方分层展示；三级保护（锁死 / 确认 / 自由）；启停、卸载、更新检查 |
| Git 仓库 | 只读浏览 GitHub 仓库；安装其中的 SKILL.md 技能与零依赖 dsh 插件克隆 |

> 原先的侧边栏「MCP 实时状态小组件（15s 轮询）」已按产品决策移除（2026-08），
> 相关 RPC（`mcpStatus`）仍保留可用。

## 稳健性设计

- 所有**组合配置**写入（web profile `cordis.patch.yml` 的托管区块、生成的项目预设
  `agent.cordis.yml`）走五步流水线：预演校验（YAML 合法性 + 文档内重复行 id +
  跨层 insert id 查重）→ 备份(5代) → 原子写 → 回读验证 → 失败自动还原；
  无实际变化的写入会直接短路（不轮换备份、不落盘）；
- 锁死级组件（loader、webserver、client 运行时、本插件自身等）在 UI 与 RPC 双层拒绝变更；
- 本插件自身初始化失败时降级为空壳，绝不拖垮 harness 启动；
- 热重载开关默认关闭（上游 Web 端 HMR 未充分验证），开启需显式确认。

> Skills 文件与 project MCP manifest 属于普通数据文件而非组合文件，
> 使用原子写但不占用整套流水线。

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

### v0.2.2 — 审查修复与瘦身

代码审查（7D 模板）发现的缺陷修复：

- **🔴 YAML 块标量吞行**：解析器在探测内容缩进时把 `#` 开头的行当注释跳过，
  以 `#` 起头的技能描述首行在读取时被静默丢弃，UI 再保存即固化丢失。已修复并加回归锁。
- **🟡 off 模式钉扎反转**：`setServerMode(off)` 曾把该行原生组合行的
  `disabled` 解除（写回 false），重启后原生阻塞客户端回归，违背「网关托管后
  原生行永久钉扎禁用、任何模式下重启都快速」的契约。现在三种模式一律钉扎禁用。
- **🟡 预演校验接线补全**：区域写入此前只做 备份→原子→回读 三步，
  `previewCompositionWrite` 从未进入真实路径；同时修复其自身缺陷——
  扫描结果未排除被写文件自身，会把"覆盖自己上一代内容"误判为跨层冲突。
  现在补丁写入真正具备跨层 insert-id 查重；文档内重复 id 在所有托管文件生效。
- **🟡 项目预设标记失配**：首次生成项目 MCP 预设时托管区块用的是旧标签
  `dsh-mcp-skill-manager`，而读取端只认 `dsh-extension-manager`——这些行永远
  不受管理，同一服务器二次添加会在单文档内产生重复 insert（启动崩溃风险#2889 同类）。
  现在统一从基准组合落盘后全部走区域管线。
- **🟡 删除不存在的行为静默假成功**：移除一个不存在于托管区的 id 会照常轮换备份、
  整文件重写并返回成功。现在无变化写入直接短路返回。

瘦身（无功能损失）：

- `kebab()` 三处重复实现收敛到 `lib/util.mjs`；三处手写 tmp+rename 的技能安装块
  收敛为共享的原子安装器（`installSkillTextToUserRoot`）；
- 移除零引用面：`featureCatalog`/`patchRowIdByPackageName`/`listFeatures`
  （约 90 行）、`detectRepoUnits` 包装器、client 死函数 `doToggleLazy` 与 10 个
  失效 i18n 键、若干未使用导入与变量；
- README 与实现同步：Git 仓库标签页入表、侧边栏小组件移除记录在案、流水线描述精确化。

### v0.2.2 复审补充修复

- **M5 多作用域矩阵闭合**：MCP 行的 查询/启停/删除/探测/查更新 现在按行的**实际所在层**
  （home 补丁 / profile 补丁 / 预设 / 项目 manifest）分发；预设行可正常测试与启停删除，
  只读层与"仅存于 manifest"的行给出明确业务错误而非假成功。UI 同时放开了 streamable-http
  行的「测试」按钮（探测本就支持 HTTP），删除不存在 id 会显示无操作提示。
- **M6 stdio 断线自愈**：工具调用遇到进程退出类致命错误时，网关清掉死连接缓存并就地重建
  （工具名保持稳定），瞬态 HTTP 错误照常抛出不吞错（T8 回归锁定两种路径）。
- **G1** SSE 多帧响应按请求 id 选帧，日志通知在前不再导致假性失败。
- **G3** 升级检测兼容 `npx.cmd` / `uvx.exe` 等带扩展名绝对路径形态。
- **S3 卸载安全补强**：插件注册行删除改走 备份+原子+验证 流水线；质量门新增
  `force` 逃生门（仅豁免可解析性检查），入口文件已删的"僵尸插件"终于可以卸载，
  UI 会二次确认。
- **S4 + 瘦身收尾**：SKILL.md 全部写路径统一原子写；删除孤儿导出
  `installSkill` / `getMcpEntry` shim / `removeMcpProject` / `toggleMcpProject`
  （后两者的职责由按层分发的 mcp.mjs 接管）。

## License

MIT。包含来自 [dsh-extension-hub](https://github.com/Relistencode/dsh-extension-hub)（MIT）
的移植代码。
