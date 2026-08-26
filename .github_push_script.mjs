// GitHub push script for dsh-extension-manager
// Uses GitHub Contents API to create/update files

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const OWNER = 'Szjpeter';
const REPO = 'dsh-extension-manager';
const BRANCH = 'main';

if (!GITHUB_TOKEN) {
  console.error('Error: No GitHub token found. Set GITHUB_TOKEN or GH_TOKEN environment variable.');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'dsh-extension-manager',
  'Content-Type': 'application/json'
};

async function getFileSha(path) {
  try {
    const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {
      headers: headers
    });
    
    if (response.status === 200) {
      const data = await response.json();
      return data.sha;
    } else if (response.status === 404) {
      return null; // File doesn't exist
    } else {
      console.error(`Error getting SHA for ${path}:`, response.status);
      return null;
    }
  } catch (error) {
    console.error(`Error getting SHA for ${path}:`, error.message);
    return null;
  }
}

async function createOrUpdateFile(path, content, message) {
  const sha = await getFileSha(path);
  const body = {
    message: message,
    content: Buffer.from(content).toString('base64'),
    branch: BRANCH
  };
  
  if (sha) {
    body.sha = sha; // Update existing file
  }
  
  try {
    const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(body)
    });
    
    const result = await response.json();
    if (response.status === 200 || response.status === 201) {
      console.log(`✓ ${sha ? 'Updated' : 'Created'}: ${path}`);
      return true;
    } else {
      console.error(`✗ Failed ${path}:`, result.message);
      return false;
    }
  } catch (error) {
    console.error(`✗ Error ${path}:`, error.message);
    return false;
  }
}

// File contents (will be populated)
const files = {
  'README.md': `# dsh-extension-manager（扩展管理）

DeepSeek Harness (DSH) 的扩展管理中心插件：在 Web 设置页管理 **Skills / MCP 服务器 / 插件**。
基于 \`dsh-extension-hub\`（MIT）的成熟器官重写而成；无导入功能、无插件市场、稳健第一。

## 安装

\`\`\`sh
dsh plugin --profile web add <本地路径或发布名>
\`\`\`

或手动安装（本仓库的开发方式）：

1. 把本目录完整复制到 \`~/.dsh/profiles/web/node_modules/dsh-extension-manager\`；
2. 编辑 \`~/.dsh/profiles/web/package.json\`，把 \`dsh.profile.bundles\` 中的
   \`"dsh-extension-hub"\` 替换为 \`"dsh-extension-manager"\`（两者不可同时启用——
   它们注册同一个设置页区域）;
3. 重启 \`dsh web\`，打开 **设置 → 扩展管理**。

> 原先由 extension-hub 写入 \`cordis.patch.yml\` 托管区块的 MCP 行会继续生效，
> 无需迁移；本插件的托管区块标记为 \`# >>> dsh-extension-manager\`，与之共存互不干扰。

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
`,
  'lib/convert.mjs': `import { emit } from './emit.mjs'

// dsh-mcp-client requires serverName to match [A-Za-z0-9_-]{1,32}.
export function normalizeServerName(name) {
  let s = String(name || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s === '') s = 'mcp-server'
  if (/^[0-9]/.test(s)) s = 'm-' + s
  return s.slice(0, 32)
}

// Convert a discovered MCP item into a dsh-mcp-client config object.
export function mcpItemToConfig(item) {
  const serverName = normalizeServerName(item.name)
  if (item.transport === 'streamable-http') {
    const config = { serverName, transport: 'streamable-http', url: item.url || '' }
    if (item.headers && Object.keys(item.headers).length) config.headers = item.headers
    return { serverName, config, id: 'mcp-' + serverName }
  }
  const config = { serverName, transport: 'stdio', command: item.command || '' }
  if (item.args && item.args.length) config.args = item.args
  if (item.env && Object.keys(item.env).length) config.env = item.env
  return { serverName, config, id: 'mcp-' + serverName }
}

// A full patch \`insert\` list entry for one MCP server.
export function mcpItemToInsertEntry(item) {
  const { id, config } = mcpItemToConfig(item)
  return { id, name: '@deepseek-ai/dsh-mcp-client', config }
}

// Render a discovered skill into a DSH-compatible SKILL.md body.
export function skillItemToSkillMd(item) {
  const fm = {}
  fm.name = item.name
  fm.description = item.description || ''
  if (item.whenToUse) fm.whenToUse = item.whenToUse
  const meta = {}
  if (item.license != null) meta.license = item.license
  if (item.allowedTools != null) meta['allowed-tools'] = item.allowedTools
  if (Object.keys(meta).length) fm.metadata = meta
  const header = '---\\n' + emit(fm) + '\\n---\\n\\n'
  return header + (item.body || '')
}
`,
  // Add other files here...
};

// Main execution
async function main() {
  console.log('=== Pushing files to GitHub ===');
  console.log(`Repository: ${OWNER}/${REPO}`);
  console.log(`Branch: ${BRANCH}`);
  console.log('');
  
  let successCount = 0;
  let failCount = 0;
  
  for (const [path, content] of Object.entries(files)) {
    const message = path === 'README.md' 
      ? 'docs: add README with installation guide and feature overview'
      : \`feat: add \${path.split('/').pop()}\`;
    
    const success = await createOrUpdateFile(path, content, message);
    if (success) successCount++;
    else failCount++;
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('');
  console.log(\`=== Completed: \${successCount} success, \${failCount} failed ===\`);
}

main().catch(console.error);
