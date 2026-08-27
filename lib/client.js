// Browser half of the durable dsh-extension-manager plugin.
//
// Served verbatim by the host's client-modules bundle route and executed
// through the lazy CJS module table: the factory receives `require` and must
// register itself with `window.__ModuleLoader__.load`. Only `react` is
// required from the shell seed words; every host API call goes through the
// mounted Remote namespace (`extensionManager`).
//
// Registers one section in the DSH Web settings page
// (`settings.section`, id `extension-manager`) with three tabs:
//   Skills  — list / create / edit / delete / enable-disable DSH skills
//   MCP     — list / add / remove / enable-disable MCP servers
//   Plugins — layered plugin management (Phase D placeholder)
//
// NOTE: no bundler/transpiler runs on this file — plain ES2017-ish JS as a
// classic script. Every useState is explicitly destructured.
window.__ModuleLoader__.load({
	id: "dsh-extension-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		// ── styles ──────────────────────────────────────────────────────────────
		var CSS_ID = "dsh-extension-manager/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-extension-manager";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".exm-wrap{display:flex;flex-direction:column;gap:12px;min-height:0;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px}",
				".exm-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-divider,#e5e6eb);padding-bottom:8px}",
				".exm-tab{cursor:pointer;border:1px solid transparent;background:none;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-secondary,#646a73);padding:5px 14px;border-radius:10px}",
				".exm-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}",
				".exm-tab.exm-active{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08));font-weight:500}",
				".exm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".exm-spacer{flex:1}",
				".exm-btn{cursor:pointer;border:1px solid var(--dsw-alias-border,#d0d3d9);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-family:inherit;font-size:13px;line-height:20px;padding:3px 12px;border-radius:10px}",
				".exm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}",
				".exm-btn.exm-danger{border-color:#d54941;color:#d54941}",
				".exm-btn.exm-danger:hover{background:rgba(213,73,65,.08)}",
				".exm-btn:disabled{opacity:.5;cursor:default}",
				".exm-list{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0}",
				".exm-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--dsw-alias-border,#e5e6eb);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff)}",
				".exm-name{font-weight:500}",
				".exm-desc{flex:1;color:var(--dsw-alias-label-secondary,#646a73);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".exm-badge{font-size:12px;line-height:18px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border,#d0d3d9);color:var(--dsw-alias-label-secondary,#646a73)}",
				".exm-badge.exm-on{color:#12965b;border-color:#12965b;background:rgba(18,150,91,.08)}",
				".exm-badge.exm-off{color:#8f959e}",
				".exm-badge.exm-ro{color:#b58a00;border-color:#e6b800;background:rgba(230,184,0,.08)}",
				".exm-empty{color:var(--dsw-alias-label-secondary,#646a73);padding:18px 0;text-align:center}",
				".exm-msg{font-size:13px;line-height:20px;padding:6px 10px;border-radius:12px}",
				".exm-msg.exm-ok{color:#12965b;background:rgba(18,150,91,.08)}",
				".exm-msg.exm-err{color:#d54941;background:rgba(213,73,65,.08)}",
				".exm-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}",
				".exm-field>label{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}",
				".exm-input,.exm-select,.exm-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border,#d0d3d9);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-family:inherit;font-size:13px;line-height:20px;padding:4px 10px;border-radius:10px}",
				".exm-textarea{min-height:120px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:16px}",
				".exm-seg{display:inline-flex;border:1px solid var(--dsw-alias-border,#d0d3d9);border-radius:10px;overflow:hidden}",
				".exm-seg button{cursor:pointer;border:none;background:none;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-secondary,#646a73);padding:5px 16px}",
				".exm-seg button.exm-active{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08));font-weight:500}",
				".exm-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 2px;border-bottom:1px solid var(--dsw-alias-divider,#e5e6eb)}",
				".exm-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}",
				".exm-main{flex:1;min-width:0}",
				".exm-name-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".exm-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}",
				".exm-actions{display:flex;gap:6px;align-items:center;flex-shrink:0;padding-top:2px}",
				".exm-btn.exm-primary{background:var(--dsw-alias-label-primary,#1f2329);border-color:var(--dsw-alias-label-tertiary,#8f959e);color:var(--dsw-alias-bg-layer-2,#fff)}",
				".exm-btn.exm-primary:hover{opacity:.9;background:var(--dsw-alias-label-primary,#1f2329)}",
				".exm-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:1000;display:flex;align-items:center;justify-content:center}",
				".exm-modal{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f2329);border-radius:12px;padding:16px;width:440px;max-width:92vw;max-height:82vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.18)}"
			].join("\n");
			document.head.appendChild(tag);
		}

		// ── tiny helpers ────────────────────────────────────────────────────────
		function h(type, props) {
			var children = Array.prototype.slice.call(arguments, 2);
			return React.createElement.apply(React, [type, props || null].concat(children));
		}
		function errText(e) {
			return e && e.message ? String(e.message) : String(e);
		}

		// ── localization ────────────────────────────────────────────────────────
		var NS = "dsh-extension-manager";
		var zh = {
			nav: "扩展管理",
			"tab.skills": "Skills",
			"tab.mcp": "MCP 服务器",
			"tab.plugins": "插件管理",
			"tab.git": "Git 仓库",
			"skill.create": "新建 Skill",
			"skill.delete": "删除",
			"skill.edit": "编辑",
			"skill.enable": "启用",
			"skill.disable": "禁用",
			"skill.name": "名称（kebab-case）",
			"skill.description": "描述",
			"skill.body": "正文（Markdown，可留空）",
			"skill.confirmDelete": "确认删除技能",
			"mcp.add": "添加 MCP",
			"mcp.remove": "删除",
			"mcp.enable": "启用",
			"mcp.disable": "禁用",
			"mcp.serverName": "serverName",
			"mcp.transport": "transport",
			"mcp.command": "command（stdio）",
			"mcp.args": "args（空格分隔）",
			"mcp.url": "url（streamable-http）",
			"mcp.confirmRemove": "确认删除 MCP 服务器",
			"mcp.removeNoop": "该行不存在于任何可管理的组合层中，未做修改。",
			"mcp.probe": "测试",
			"mcp.checkUpdate": "查更新",
			"mcp.probeOk": "已连接",
			"mcp.probeFail": "不通",
			"mcp.updateCmd": "升级命令",
			"mcp.checking": "正在检查…",
			"mcp.probing": "测试中…",
			"mcp.remoteNoUpdate": "网络型服务器：无需本地更新",
			"mcp.mode.title": "网关模式",
			"mcp.mode.full": "标准",
			"mcp.mode.lazy": "懒加载",
			"mcp.mode.off": "停用",
			"mcp.mode.current": "当前",
			"mcp.mode.applied": "已即时生效（网关托管模式，无需重启）。",
			"mcp.mode.managed": "网关托管",
			"mcp.sw.on": "开启",
			"mcp.sw.off": "关闭",
			"mcp.fidelity.standard": "完整参数",
			"mcp.fidelity.econ": "省上下文",
			"mcp.fidelity.label": "工具参数",
			"mcp.fidelity.title": "点击在「完整参数」与「省上下文 stub」之间切换",
			"status.title": "MCP 状态",
			"status.none": "无 MCP 服务器",
			"phase.active": "已连接",
			"phase.failed": "失败",
			"phase.loading": "连接中",
			"phase.pending": "等待",
			"phase.disabled": "已停用",
			"phase.unloading": "停止中",
			"phase.unknown": "未知",
			"mcp.hotReload": "热重载（实验）",
			"mcp.hotReloadOn": "热重载：开",
			"mcp.hotReloadOff": "热重载：关",
			"mcp.hotReloadConfirm": "上游未充分验证 Web 端 HMR，热重载失败时可能触发进程重启。确认开启？",
			"common.save": "保存",
			"common.cancel": "取消",
			"common.enabled": "启用",
			"common.disabled": "已禁用",
			"common.readonly": "只读",
			"common.builtin": "内置",
			"plugins.locked": "已锁定",
			"plugins.confirm": "受保护",
			"plugins.free": "第三方",
			"plugins.official": "官方",
			"plugins.other": "其他插件",
			"plugins.disable": "停用",
			"plugins.enable": "启用",
			"plugins.uninstall": "卸载",
			"plugins.forceUninstallConfirm": "插件入口无法从 web profile 解析（文件可能已被删除）。仍要强制移除注册行吗？",
			"plugins.confirmDisable": "停用官方插件可能影响功能，确认继续？",
			"plugins.confirmUninstall": "确认卸载该插件？卸载后需重启 dsh web 生效。",
			"skills.other": "其他",
			"skills.official": "官方",
			"plugins.search": "搜索插件：按名称 / entry id / 描述定位…",
			"plugins.effectiveConfig": "生效配置",
			"plugins.absorbNative": "融合原生插件清单",
			"plugins.absorbConfirm": "将停用 harness 自带的只读「Plugin list」页（其功能已由本页覆盖），重启后生效。确认？",
			"plugins.checkAll": "检查更新",
			"plugins.checking": "正在检查更新…",
			"plugins.update": "更新",
			"plugins.updateAvailable": "可更新",
			"plugins.originUnknown": "来源未记录",
			"plugins.originUnknownScan": "部分插件未记录来源仓库，已跳过（在插件目录补 .dsh-plugin-origin.json 后可更新）",
			"plugins.updatableFound": "发现可更新插件",
			"plugins.allUpToDate": "全部为最新版本",
			"git.user": "GitHub 用户名",
			"git.load": "拉取仓库",
			"git.browse": "浏览内容",
			"git.refresh": "刷新",
			"git.skillsFound": "可安装技能",
			"git.pluginFound": "插件包（根 package.json）",
			"git.installSkill": "安装技能",
			"git.installPlugin": "安装插件",
			"git.overwriteConfirm": "本地已存在同名技能，覆盖？",
			"git.none": "未检测到可安装内容。插件需含 dsh 字段的 package.json；技能需含 SKILL.md。空仓库则无内容可装。",
			"git.kind.dsh": "DSH 插件",
			"git.kind.mcp": "MCP 服务包",
			"git.kind.readerror": "读取失败",
			"git.kind.unknown": "非 DSH 插件",
			"git.mcpHint": "MCP 服务包：请在 MCP 页以服务器形式配置运行，无需在此安装",
			"git.readErrorHint": "package.json 读取失败（网络/解码），请点击「刷新」重试",
			"git.repoHint": "公开仓库 · 只读集成：浏览与安装，不做任何远端写操作",
			"msg.saved": "已保存",
			"msg.removed": "已删除",
			"msg.pendingRestart": "已写入配置，重启 dsh web 后生效。"
		};
		var en = {
			nav: "Extension Manager",
			"tab.skills": "Skills",
			"tab.mcp": "MCP Servers",
			"tab.plugins": "Plugins",
			"tab.git": "Git Repos",
			"skill.create": "New Skill",
			"skill.delete": "Delete",
			"skill.edit": "Edit",
			"skill.enable": "Enable",
			"skill.disable": "Disable",
			"skill.name": "Name (kebab-case)",
			"skill.description": "Description",
			"skill.body": "Body (Markdown, optional)",
			"skill.confirmDelete": "Confirm skill deletion",
			"mcp.add": "Add MCP",
			"mcp.remove": "Delete",
			"mcp.enable": "Enable",
			"mcp.disable": "Disable",
			"mcp.serverName": "serverName",
			"mcp.transport": "transport",
			"mcp.command": "command (stdio)",
			"mcp.args": "args (space separated)",
			"mcp.url": "url (streamable-http)",
			"mcp.confirmRemove": "Confirm MCP server removal",
			"mcp.probe": "Test",
			"mcp.checkUpdate": "Check update",
			"mcp.probeOk": "reachable",
			"mcp.probeFail": "unreachable",
			"mcp.updateCmd": "upgrade command",
			"mcp.checking": "Checking…",
			"mcp.probing": "testing…",
			"mcp.remoteNoUpdate": "remote server: no local update applies",
			"mcp.mode.title": "gateway mode",
			"mcp.mode.full": "standard",
			"mcp.mode.lazy": "lazy",
			"mcp.mode.off": "off",
			"mcp.mode.current": "current",
			"mcp.mode.applied": "Applied immediately (gateway-managed, no restart needed).",
			"mcp.mode.managed": "gateway",
			"mcp.sw.on": "ON",
			"mcp.sw.off": "OFF",
			"mcp.fidelity.standard": "full schema",
			"mcp.fidelity.econ": "context-lite",
			"mcp.fidelity.label": "tool params",
			"mcp.fidelity.title": "Toggle between full schema and context-lite stubs",
			"status.title": "MCP Status",
			"status.none": "no MCP servers",
			"phase.active": "connected",
			"phase.failed": "failed",
			"phase.loading": "connecting",
			"phase.pending": "pending",
			"phase.disabled": "disabled",
			"phase.unloading": "stopping",
			"phase.unknown": "unknown",
			"mcp.hotReload": "Hot reload (experimental)",
			"mcp.hotReloadOn": "Hot reload: on",
			"mcp.hotReloadOff": "Hot reload: off",
			"mcp.hotReloadConfirm": "Upstream has not fully validated Web HMR; a failed hot reload may restart the process. Enable anyway?",
			"common.save": "Save",
			"common.cancel": "Cancel",
			"common.enabled": "enabled",
			"common.disabled": "disabled",
			"common.readonly": "read-only",
			"common.builtin": "built-in",
			"plugins.locked": "locked",
			"plugins.confirm": "protected",
			"plugins.free": "third-party",
			"plugins.official": "Official",
			"plugins.other": "Other Plugins",
			"plugins.disable": "Disable",
			"plugins.enable": "Enable",
			"plugins.uninstall": "Uninstall",
			"plugins.forceUninstallConfirm": "The plugin entry cannot be resolved from the web profile (files may already be deleted). Force-remove its registration row anyway?",
			"plugins.confirmDisable": "Disabling an official plugin may affect functionality — continue?",
			"plugins.confirmUninstall": "Uninstall this plugin? Takes effect after restarting dsh web.",
			"skills.other": "Other",
			"skills.official": "Official",
			"plugins.search": "Search plugins by name / entry id / description…",
			"plugins.effectiveConfig": "effective config",
			"plugins.absorbNative": "Absorb native plugin list",
			"plugins.absorbConfirm": "This disables the built-in read-only \"Plugin list\" page (covered by this tab). Takes effect after restart. Continue?",
			"plugins.checkAll": "Check updates",
			"plugins.checking": "Checking for updates…",
			"plugins.update": "Update",
			"plugins.updateAvailable": "update available",
			"plugins.originUnknown": "origin unknown",
			"plugins.originUnknownScan": "Some plugins have no recorded source repo and were skipped (add .dsh-plugin-origin.json to enable updates)",
			"plugins.updatableFound": "Updatable plugins found",
			"plugins.allUpToDate": "All plugins are up to date",
			"git.user": "GitHub username",
			"git.load": "Fetch repos",
			"git.browse": "Browse",
			"git.refresh": "Refresh",
			"git.skillsFound": "Installable skills",
			"git.pluginFound": "Plugin package (root package.json)",
			"git.installSkill": "Install skill",
			"git.installPlugin": "Install plugin",
			"git.overwriteConfirm": "A skill with this name exists locally. Overwrite?",
			"git.none": "Nothing installable found. Plugins need a package.json with a dsh field; skills need SKILL.md. Empty repos have nothing to install.",
			"git.kind.dsh": "DSH plugin",
			"git.kind.mcp": "MCP server package",
			"git.kind.readerror": "read failed",
			"git.kind.unknown": "not a DSH plugin",
			"git.mcpHint": "MCP server package: configure it as a server on the MCP tab instead — no plugin install needed",
			"git.readErrorHint": "Could not read package.json (network/decode). Click Refresh to retry.",
			"git.repoHint": "public repos · read-only integration: browse & install, no remote writes",
			"msg.saved": "Saved",
			"msg.removed": "Removed",
			"msg.pendingRestart": "Written to configuration — restart dsh web to apply."
		};

		function makeT(lang) {
			return function t(key, vars) {
				var dict = lang === "en" ? en : zh;
				var s = dict[key] !== undefined ? dict[key] : (zh[key] !== undefined ? zh[key] : key);
				if (vars) {
					for (var k in vars) {
						if (Object.prototype.hasOwnProperty.call(vars, k)) {
							s = s.split("{" + k + "}").join(String(vars[k]));
						}
					}
				}
				return s;
			};
		}

		// ── remote contribution ─────────────────────────────────────────────────
		var REMOTE_METHODS = ["ping", "list", "getSkill", "createSkill", "updateSkill", "removeSkill", "toggleSkill", "getMcp", "upsertMcp", "removeMcp", "toggleMcp", "probeMcp", "checkMcpUpdate", "listPlugins", "setPluginEnabled", "removePlugin", "checkPluginUpdates", "updateOnePlugin", "precheckPlugin", "restoreRemovedPlugin", "mcpStatus", "getHotReload", "setHotReload", "getLazy", "enableLazy", "disableLazy", "setServerMode", "gitRepos", "gitBrowse", "gitInstallSkill", "gitInstallPlugin", "getState", "setState"];
		function passthroughCodec(typeSymbol) {
			return { mode: "strict", typeSymbol: typeSymbol, schema: { parse: function (v) { return v; } } };
		}
		function makeRemoteContribution() {
			var descriptors = [];
			for (var i = 0; i < REMOTE_METHODS.length; i++) {
				descriptors.push({
					id: "dsh-extension-manager#extensionManager/" + REMOTE_METHODS[i],
					service: "extensionManager",
					namespace: "extensionManager",
					method: REMOTE_METHODS[i],
					invocation: { kind: "direct" },
					parameters: [{ name: "input", wire: "input", source: "json", codec: passthroughCodec("dsh-extension-manager/types#Input") }],
					result: passthroughCodec("dsh-extension-manager/types#Result")
				});
			}
			return { package: "dsh-extension-manager", descriptors: descriptors };
		}
		var REMOTE_CONTRIBUTION = makeRemoteContribution();

		var ctxRef = null;
		var apiRef = null;
		// Translator bound to OUR locale namespace at apply time. Components must
		// prefer this over the shell-injected `t`, which is bound to the settings
		// owner's dictionaries and returns empty strings for our keys.
		var tBound = null;
		var RETRY_DELAYS = [1500, 3000, 6000, 12000, 20000, 30000];
		async function callWithRetry(method, input, attempt) {
			attempt = attempt || 0;
			try {
				var res = await apiRef[method](input || {});
				if (res && res.ok === false) {
					// 业务级错误（质量门拒绝、参数问题等）是确定性结果：
					// 立即抛出，不进入重试循环，避免"点了没反应"的长时间静默
					var err = new Error((res.error && res.error.message) || ("RPC failed: " + method));
					err.business = true;
					throw err;
				}
				if (res && res.ok === true && Object.prototype.hasOwnProperty.call(res, "value")) return res.value;
				return res;
			} catch (error) {
				if (error.business || attempt >= RETRY_DELAYS.length - 1) throw error;
				await new Promise(function (resolve) { setTimeout(resolve, RETRY_DELAYS[attempt]); });
				return callWithRetry(method, input, attempt + 1);
			}
		}
		function call(method, input) {
			if (!apiRef) return Promise.reject(new Error("extensionManager namespace not mounted"));
			return callWithRetry(method, input, 0);
		}

		// ── shared UI atoms ─────────────────────────────────────────────────────
		function Btn(props) {
			var cls = "exm-btn" + (props.kind ? " exm-" + props.kind : "");
			var rest = {};
			for (var k in props) {
				if (k !== "kind" && k !== "children") rest[k] = props[k];
			}
			// Button label(s) arrive as trailing args after props — capture them!
			var children = Array.prototype.slice.call(arguments, 1);
			return h.apply(null, ["button", Object.assign({ className: cls }, rest)].concat(children));
		}
		function Badge(props) {
			var state = props.state || "";
			return h("span", { className: "exm-badge" + (state ? " exm-" + state : "") }, props.text);
		}

		// ── Skills tab ──────────────────────────────────────────────────────────
		function SkillsTab(props) {
			var t = tBound || (props && props.t) || makeT("zh");
			var itemsState = React.useState(null);
			var items = itemsState[0];
			var setItems = itemsState[1];
			var msgState = React.useState(null);
			var msg = msgState[0];
			var setMsg = msgState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var subTabState = React.useState("other");
			var skillSubTab = subTabState[0];
			var setSkillSubTab = subTabState[1];
			var editState = React.useState(null);
			var edit = editState[0];
			var setEdit = editState[1];

			var reload = React.useCallback(function () {
				call("list", {}).then(function (r) {
					setItems((r && r.skills) || []);
				}).catch(function (e) { setMsg({ kind: "err", text: errText(e) }); });
			}, []);
			React.useEffect(function () { reload(); }, [reload]);

			function withBusy(fn) {
				setBusy(true);
				setMsg(null);
				Promise.resolve().then(fn).then(function () { reload(); }).catch(function (e) {
					setMsg({ kind: "err", text: errText(e) });
				}).finally(function () { setBusy(false); });
			}
			function doToggle(item) {
				withBusy(function () {
					return call("toggleSkill", { name: item.name, scope: item.scope, disabled: !!item.enabled });
				});
			}
			function doRemove(item) {
				if (!window.confirm(t("skill.confirmDelete") + ": " + item.name + "?")) return;
				withBusy(function () {
					return call("removeSkill", { name: item.name, scope: item.scope }).then(function () {
						setMsg({ kind: "ok", text: t("msg.removed") });
					});
				});
			}

			function isOfficialSkill(s) {
				var src = String(s.source || "");
				return src.indexOf("shipped:") === 0 || src.indexOf("preset:") === 0 || s.scope === "system";
			}
			var officialSkills = [];
			var otherSkills = [];
			for (var sit of items || []) (isOfficialSkill(sit) ? officialSkills : otherSkills).push(sit);
			var activeSkills = skillSubTab === "official" ? officialSkills : otherSkills;

			var rows = activeSkills.map(function (it) {
				return h("div", { key: it.scope + "/" + it.name, className: "exm-item" },
					h(Badge, { text: it.enabled ? t("common.enabled") : t("common.disabled"), state: it.enabled ? "on" : "off" }),
					it.readOnly ? h(Badge, { text: t("common.readonly"), state: "ro" }) : null,
					h("span", { className: "exm-name" }, it.name),
					h("span", { className: "exm-desc" }, it.description || ""),
					h(Badge, { text: it.source }),
					it.readOnly ? null : Btn({
						onClick: function () { doToggle(it); },
						disabled: busy,
					}, it.enabled ? t("skill.disable") : t("skill.enable")),
					it.readOnly ? null : Btn({
						onClick: function () { setEdit({ name: it.name, scope: it.scope }); },
					}, t("skill.edit")),
					it.readOnly ? null : Btn({
						className: "exm-btn exm-danger",
						onClick: function () { doRemove(it); },
						disabled: busy,
					}, t("skill.delete")));
			});

			return h("div", { className: "exm-wrap" },
				h("div", { className: "exm-toolbar" },
					h("div", { className: "exm-seg" },
						h("button", {
							className: skillSubTab === "other" ? "exm-active" : "",
							onClick: function () { setSkillSubTab("other"); },
						}, t("skills.other")),
						h("button", {
							className: skillSubTab === "official" ? "exm-active" : "",
							onClick: function () { setSkillSubTab("official"); },
						}, t("skills.official"))),
					h("div", { className: "exm-spacer" }),
					h(Badge, { text: String(activeSkills.length) })),
				msg ? h("div", { className: "exm-msg " + (msg.kind === "ok" ? "exm-ok" : "exm-err") }, msg.text) : null,
				edit ? h("div", { className: "exm-modal-mask", onClick: function (e) { if (e.target === e.currentTarget) { setEdit(null); } } },
					h("div", { className: "exm-modal" },
						h(SkillForm, {
							t: t,
							edit: edit,
							onDone: function (saved) {
								setEdit(null);
								if (saved) { setMsg({ kind: "ok", text: t("msg.saved") }); }
								reload();
							},
						}))) : null,
				rows.length ? h("div", { className: "exm-list" }, rows) : h("div", { className: "exm-empty" }, items ? "(empty)" : "…"));
		}

		function SkillForm(props) {
			var t = tBound || (props && props.t) || makeT("zh");
			var edit = props.edit;
			var editing = !!edit;
			var loadedState = React.useState(editing ? null : { name: "", description: "", body: "" });
			var loaded = loadedState[0];
			var setLoaded = loadedState[1];
			var errState = React.useState("");
			var setErr = errState[1];

			React.useEffect(function () {
				if (!editing) return;
				call("getSkill", { name: edit.name, scope: edit.scope }).then(function (s) {
					setLoaded({ name: s.name, description: s.description, body: s.body || "" });
				}).catch(function (e) { setErr(errText(e)); });
			}, [editing, edit && edit.name]);

			if (editing && !loaded) {
				return h("div", { className: "exm-empty" }, "…");
			}
			if (!loaded) return null;

			function field(labelText, inputEl) {
				return h("div", { className: "exm-field" }, h("label", null, labelText), inputEl);
			}
			function save() {
				setErr("");
				var payload = editing
					? { name: edit.name, scope: edit.scope, description: loaded.description, body: loaded.body }
					: { name: loaded.name, description: loaded.description, body: loaded.body };
				call(editing ? "updateSkill" : "createSkill", payload)
					.then(function () { props.onDone(true); })
					.catch(function (e) { setErr(errText(e)); });
			}
			return h("div", { style: { border: "1px solid var(--dsw-alias-border,#e5e6eb)", borderRadius: 12, padding: 12 } },
				field(t("skill.name"), h("input", {
					className: "exm-input",
					value: loaded.name,
					disabled: editing,
					onChange: function (e) { setLoaded(Object.assign({}, loaded, { name: e.target.value })); },
				})),
				field(t("skill.description"), h("input", {
					className: "exm-input",
					value: loaded.description,
					onChange: function (e) { setLoaded(Object.assign({}, loaded, { description: e.target.value })); },
				})),
				field(t("skill.body"), h("textarea", {
					className: "exm-textarea",
					value: loaded.body,
					onChange: function (e) { setLoaded(Object.assign({}, loaded, { body: e.target.value })); },
				})),
				err ? h("div", { className: "exm-msg exm-err" }, err) : null,
				h("div", { className: "exm-toolbar" },
					h("div", { className: "exm-spacer" }),
					Btn({ onClick: function () { props.onDone(false); } }, t("common.cancel")),
					Btn({ kind: "primary", onClick: save }, t("common.save"))));
		}

		// ── MCP tab ─────────────────────────────────────────────────────────────
		function McpTab(props) {
			var t = tBound || (props && props.t) || makeT("zh");
			var itemsState = React.useState(null);
			var items = itemsState[0];
			var setItems = itemsState[1];
			var msgState = React.useState(null);
			var msg = msgState[0];
			var setMsg = msgState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var formOpenState = React.useState(false);
			var formOpen = formOpenState[0];
			var setFormOpen = formOpenState[1];
			// Per-row probe / update-check results, keyed by row id.
			var probesState = React.useState({});
			var probes = probesState[0];
			var setProbes = probesState[1];
			var updatesState = React.useState({});
			var updates = updatesState[0];
			var setUpdates = updatesState[1];
			var hrState = React.useState(false);
			var hotReload = hrState[0];
			var setHotReloadState = hrState[1];
			var lazyActiveState = React.useState(new Set());
			var lazyActive = lazyActiveState[0];
			var setLazyActive = lazyActiveState[1];
			var modeMapState = React.useState({});
			var modeByServer = modeMapState[0];
			var setModeByServer = modeMapState[1];

			function doSetMode(item, mode) {
				withBusy(function () {
					return call("setServerMode", {
						id: item.id,
						serverName: item.serverName,
						mode: mode,
						confirm: true,
					}).then(function () {
						setMsg({ kind: "ok", text: t("mcp.mode.applied") });
					});
				});
			}

			function doToggleHotReload() {
				if (hotReload) {
					setBusy(true);
					// confirm:true 兼容仍在运行的旧 host（其确认门槛不区分方向）
					call("setHotReload", { enabled: false, confirm: true }).then(function () { setHotReloadState(false); })
						.catch(function (e) { setMsg({ kind: "err", text: errText(e) }); })
						.finally(function () { setBusy(false); });
					return;
				}
				if (!window.confirm(t("mcp.hotReloadConfirm"))) return;
				setBusy(true);
				call("setHotReload", { enabled: true, confirm: true }).then(function () {
					setHotReloadState(true);
					setMsg({ kind: "ok", text: t("msg.pendingRestart") });
				}).catch(function (e) { setMsg({ kind: "err", text: errText(e) }); })
					.finally(function () { setBusy(false); });
			}

			function doProbe(item) {
				setProbes(Object.assign({}, probes, { [item.id]: { loading: true } }));
				call("probeMcp", { id: item.id }).then(function (r) {
					var probe = r && r.ok ? r.probe : { reachable: false, detail: r && r.problem };
					setProbes(Object.assign({}, probes, { [item.id]: probe }));
				}).catch(function (e) {
					setProbes(Object.assign({}, probes, { [item.id]: { reachable: false, detail: errText(e) } }));
				});
			}
			function doCheckUpdate(item) {
				setMsg({ kind: "ok", text: t("mcp.checking") });
				call("checkMcpUpdate", { id: item.id }).then(function (r) {
					setUpdates(Object.assign({}, updates, { [item.id]: r || { ok: false, problem: "empty" } }));
				}).catch(function (e) {
					setUpdates(Object.assign({}, updates, { [item.id]: { ok: false, problem: errText(e) } }));
				});
			}

			var reload = React.useCallback(function () {
				call("list", {}).then(function (r) {
					setItems((r && r.mcp) || []);
				}).catch(function (e) { setMsg({ kind: "err", text: errText(e) }); });
				call("getHotReload", {}).then(function (r) { setHotReloadState(!!(r && r.enabled)); }).catch(function () { });
				call("getLazy", {}).then(function (r) {
					var set = new Set((r && r.active) || []);
					setLazyActive(set);
					var map = {};
					((r && r.servers) || []).forEach(function (s) {
						if (s && s.serverName) map[s.serverName] = s.mode || null;
					});
					setModeByServer(map);
				}).catch(function () { });
			}, []);
			React.useEffect(function () { reload(); }, [reload]);

			function withBusy(fn) {
				setBusy(true);
				setMsg(null);
				Promise.resolve().then(fn).then(function () { reload(); }).catch(function (e) {
					setMsg({ kind: "err", text: errText(e) });
				}).finally(function () { setBusy(false); });
			}
			function doRemove(item) {
				if (!window.confirm(t("mcp.confirmRemove") + ": " + item.serverName + "?")) return;
				withBusy(function () {
					return call("removeMcp", { id: item.id }).then(function (r) {
						// M5: absent ids are now reported as a no-op instead of the
						// old silent "已写入配置" success.
						if (r && r.noop) setMsg({ kind: "err", text: t("mcp.removeNoop") });
						else setMsg({ kind: "ok", text: t("msg.pendingRestart") });
					});
				});
			}

			var rows = (items || []).map(function (it) {
				var probe = probes[it.id];
				var upd = updates[it.id];
				var lines = [];
				if (probe) {
					if (probe.loading) lines.push(t("mcp.probing"));
					else if (probe.reachable) lines.push("✓ " + t("mcp.probeOk") + " (" + probe.latencyMs + "ms)" + (probe.serverName ? " · " + probe.serverName : ""));
					else lines.push("✗ " + t("mcp.probeFail") + ": " + (probe.detail || ""));
				}
				if (upd) {
					if (!upd.ok) lines.push(upd.problem);
					else if (upd.status === "no-target") lines.push(t("mcp.remoteNoUpdate"));
					else if (upd.status === "up-to-date") lines.push(t("plugins.allUpToDate"));
					else {
						var bits = [];
						if (upd.target) bits.push(upd.target.pkg + "@" + (upd.target.latest || "?"));
						if (upd.command) bits.push(t("mcp.updateCmd") + ": " + upd.command);
						lines.push(bits.join(" | "));
					}
				}
				var gw = modeByServer[it.serverName] || null;
				var swOn = gw === "full" || gw === "lazy";
			// ONE vocabulary everywhere: 开启 / 关闭. Gateway rows derive the
			// state from the persisted mode; unmanaged rows map it onto the
			// native enabled flag.
			var uiOn = gw ? swOn : !!it.enabled;
			var statusBadge = h(Badge, {
				text: t("mcp.sw." + (uiOn ? "on" : "off")),
				state: uiOn ? "on" : "off",
			});
			var actions = [];
			if (!it.readOnly) {
				// THE one switch for every manageable row (v0.2.2 交互梳理):
				// ON takes the row into the gateway as 标准 (full schemas) —
				// native row pinned, tools registered in-process; OFF keeps it
				// gateway-owned but silent. The old native 启用/禁用 second
				// brain is gone (gateway OFF supersedes it), so a row whose
				// gateway entry was lost can ALWAYS re-enter management.
				actions.push(Btn({
					key: "switch",
					kind: uiOn ? "primary" : undefined,
					onClick: function () { if (!busy) doSetMode(it, uiOn ? "off" : "full"); },
					disabled: busy,
				}, uiOn ? t("mcp.sw.off") : t("mcp.sw.on")));
				if (swOn) {
					// 工具参数: 完整参数(标准) ↔ 省上下文(懒加载) — the button the
					// user knows; one click, no popup, instantly reversible.
					actions.push(Btn({
						key: "fidelity",
						title: t("mcp.fidelity.title"),
						onClick: function () { if (!busy) doSetMode(it, gw === "full" ? "lazy" : "full"); },
						disabled: busy,
					}, t("mcp.fidelity.label") + ": " + (gw === "lazy" ? t("mcp.fidelity.econ") : t("mcp.fidelity.standard"))));
				}
				// Probe/upgrade-check are stdio-only affordances: a real
				// initialize handshake needs a child process, and HTTP rows have
				// no locally upgradable package. Keep the row lean.
				if (it.transport === "stdio") {
					actions.push(
						Btn({ onClick: function () { doProbe(it); }, disabled: busy || !!(probe && probe.loading) }, probe && probe.loading ? t("mcp.probing") : t("mcp.probe")),
						Btn({ onClick: function () { doCheckUpdate(it); }, disabled: busy }, t("mcp.checkUpdate"))
					);
				}
				actions.push(Btn({ className: "exm-btn exm-danger", onClick: function () { doRemove(it); }, disabled: busy }, t("mcp.remove")));
			}
			return h("div", { key: it.id + "/" + it.scope, className: "exm-row" },
				h("div", { className: "exm-main" },
					h("div", { className: "exm-name-line" },
						statusBadge,
						h("span", { className: "exm-name" }, it.serverName),
						it.readOnly ? h(Badge, { text: t("common.readonly"), state: "ro" }) : null,
						h(Badge, { text: it.transport || "?" })),
					h("div", { className: "exm-sub" }, it.id + " · " + (it.source || "")),
					lines.map(function (L, i) {
						return h("div", { key: i, className: "exm-sub", style: L.indexOf("✗") === 0 ? { color: "#d54941" } : null }, L);
					})),
				h("div", { className: "exm-actions" }, actions));
			});

			return h("div", { className: "exm-wrap" },
				h("div", { className: "exm-toolbar" },
					Btn({
						onClick: function () { doToggleHotReload(); },
						disabled: busy,
					}, hotReload ? t("mcp.hotReloadOn") : t("mcp.hotReloadOff")),
					h("div", { className: "exm-spacer" }),
					Btn({ kind: "primary", onClick: function () { setFormOpen(!formOpen); } }, t("mcp.add"))),
				msg ? h("div", { className: "exm-msg " + (msg.kind === "ok" ? "exm-ok" : "exm-err") }, msg.text) : null,
				formOpen ? h("div", { className: "exm-modal-mask", onClick: function (e) { if (e.target === e.currentTarget) setFormOpen(false); } },
					h("div", { className: "exm-modal" },
						h(McpForm, { t: t, onDone: function () { setFormOpen(false); reload(); } }))) : null,
				rows.length ? h("div", { className: "exm-list" }, rows) : h("div", { className: "exm-empty" }, items ? "(empty)" : "…"));
		}

		function McpForm(props) {
			var t = tBound || (props && props.t) || makeT("zh");
			var st = React.useState({ serverName: "", transport: "streamable-http", command: "", args: "", url: "" });
			var v = st[0];
			var setV = st[1];
			var errState = React.useState("");
			var err = errState[0];
			var setErr = errState[1];

			function field(labelText, inputEl) {
				return h("div", { className: "exm-field" }, h("label", null, labelText), inputEl);
			}
			function save() {
				setErr("");
				var payload = { serverName: v.serverName, transport: v.transport };
				if (v.transport === "stdio") {
					payload.command = v.command;
					payload.args = v.args.trim() === "" ? [] : v.args.trim().split(/\s+/);
				} else {
					payload.url = v.url;
				}
				call("upsertMcp", payload)
					.then(function () { props.onDone(true); })
					.catch(function (e) { setErr(errText(e)); });
			}
			return h("div", { style: { border: "1px solid var(--dsw-alias-border,#e5e6eb)", borderRadius: 12, padding: 12 } },
				field(t("mcp.serverName"), h("input", {
					className: "exm-input",
					value: v.serverName,
					onChange: function (e) { setV(Object.assign({}, v, { serverName: e.target.value })); },
				})),
				field(t("mcp.transport"), h("select", {
					className: "exm-select",
					value: v.transport,
					onChange: function (e) { setV(Object.assign({}, v, { transport: e.target.value })); },
				},
					h("option", { value: "streamable-http" }, "streamable-http"),
					h("option", { value: "stdio" }, "stdio"))),
				v.transport === "stdio"
					? [
						field(t("mcp.command"), h("input", {
							className: "exm-input",
							value: v.command,
							onChange: function (e) { setV(Object.assign({}, v, { command: e.target.value })); },
						})),
						field(t("mcp.args"), h("input", {
							className: "exm-input",
							value: v.args,
							onChange: function (e) { setV(Object.assign({}, v, { args: e.target.value })); },
						})),
					]
					: field(t("mcp.url"), h("input", {
						className: "exm-input",
						value: v.url,
						onChange: function (e) { setV(Object.assign({}, v, { url: e.target.value })); },
					})),
				err ? h("div", { className: "exm-msg exm-err" }, err) : null,
				h("div", { className: "exm-toolbar" },
					h("div", { className: "exm-spacer" }),
					Btn({ onClick: function () { props.onDone(false); } }, t("common.cancel")),
					Btn({ kind: "primary", onClick: save }, t("common.save"))));
		}

		// ── Plugins tab ─────────────────────────────────────────────────────────
		function tierBadge(t, item) {
			if (item.tier === "locked") return h(Badge, { text: t("plugins.locked"), state: "ro" });
			if (item.tier === "confirm") return h(Badge, { text: t("plugins.confirm"), state: "ro" });
			return null;
		}
		function PluginsTab(props) {
			var t = tBound || (props && props.t) || makeT("zh");
			var itemsState = React.useState(null);
			var items = itemsState[0];
			var setItems = itemsState[1];
			var msgState = React.useState(null);
			var msg = msgState[0];
			var setMsg = msgState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var queryState = React.useState("");
			var query = queryState[0];
			var setQuery = queryState[1];
			var subTabState = React.useState("other");
			var subTab = subTabState[0];
			var setSubTab = subTabState[1];
			// name -> true for plugins flagged update-available by the last scan
			var updState = React.useState({});
			var updatable = updState[0];
			var setUpdatable = updState[1];
			// ZIP/manual installs WITHOUT recorded origin: shown as a hint badge
			// (来源未记录) instead of an update button — nothing to auto-update
			// against until the source is recorded.
			var unknownState = React.useState({});
			var originUnknownMap = unknownState[0];
			var setOriginUnknown = unknownState[1];

			var reload = React.useCallback(function () {
				call("listPlugins", {}).then(function (r) {
					setItems((r && r.plugins) || []);
				}).catch(function (e) { setMsg({ kind: "err", text: errText(e) }); });
				// 生效配置由 host 从 loader entries 直读并随行返回（item.cfg），
				// 不再依赖浏览器端 pluginInventory remote。
			}, []);
			React.useEffect(function () { reload(); }, [reload]);

			function doToggle(item) {
				var targetEnabled = !item.enabled;
				if (!targetEnabled && item.tier === "confirm" && !window.confirm(t("plugins.confirmDisable"))) return;
				setBusy(true);
				setMsg(null);
				call("setPluginEnabled", { id: item.entryId, enabled: targetEnabled })
					.then(function () {
						setMsg({ kind: "ok", text: t("msg.pendingRestart") });
						reload();
					})
					.catch(function (e) { setMsg({ kind: "err", text: errText(e) }); })
					.finally(function () { setBusy(false); });
			}
			function doRemove(item) {
				if (!window.confirm(t("plugins.confirmUninstall") + " [" + item.name + "]")) return;
				runRemove(item, false);
			}
			function runRemove(item, force) {
				setBusy(true);
				setMsg(null);
				call("removePlugin", force ? { id: item.entryId, force: true } : { id: item.entryId })
					.then(function (r) {
						setMsg(r && r.ok ? { kind: "ok", text: r.message || t("msg.pendingRestart") } : { kind: "err", text: r && r.message ? r.message : "failed" });
						reload();
					})
					.catch(function (e) {
						var msgText = errText(e);
						// S3 escape hatch: an unresolvable entry (files already gone)
						// used to be permanently uninstallable. Offer one explicit
						// force pass; everything else stays a plain error.
						if (!force && msgText.indexOf("无法从 web profile 解析") >= 0 &&
							window.confirm(t("plugins.forceUninstallConfirm"))) {
							return runRemove(item, true);
						}
						setMsg({ kind: "err", text: msgText });
					})
					.finally(function () { setBusy(false); });
			}
			function doCheckUpdates() {
				setBusy(true);
				setMsg(null);
				call("checkPluginUpdates", {}).then(function (r) {
					// Field contract: core returns `updateable` (git/npm/zip → auto
					// updatable; the zip path downloads+validates+swaps with backup).
					// The old client read `updateAvailable`/`hasUpdate` — a name
					// mismatch that left the 更新 button dead since v0.2.0.
					var found = {};
					var unknown = {};
					var candidates = null;
					if (r && Array.isArray(r.plugins)) candidates = r.plugins;
					else if (r && Array.isArray(r.items)) candidates = r.items;
					else if (Array.isArray(r)) candidates = r;
					if (candidates) {
						for (var i = 0; i < candidates.length; i++) {
							var it = candidates[i] || {};
							var nm = it.name || it.pkg || it.id;
							if (!nm) continue;
							if (it.kind === "zip" && it.originUnknown === true) { unknown[nm] = true; continue; }
							var flag = it.updateable === true || it.updateAvailable === true || it.hasUpdate === true || it.status === "update-available";
							if (nm && flag) found[nm] = true;
						}
					}
					setUpdatable(found);
					setOriginUnknown(unknown);
					var names = Object.keys(found);
					var unknownCount = Object.keys(unknown).length;
					setMsg({ kind: "ok", text: names.length ? t("plugins.updatableFound") + ": " + names.join(", ") : (unknownCount ? t("plugins.originUnknownScan") : t("plugins.allUpToDate")) });
				}).catch(function (e) { setMsg({ kind: "err", text: errText(e) }); })
					.finally(function () { setBusy(false); });
			}
			function doUpdateOne(item) {
				setBusy(true);
				setMsg(null);
				call("updateOnePlugin", { name: item.name }).then(function (r) {
					setMsg(r && r.ok !== false ? { kind: "ok", text: t("msg.pendingRestart") } : { kind: "err", text: (r && r.message) || "failed" });
				}).catch(function (e) { setMsg({ kind: "err", text: errText(e) }); })
					.finally(function () { setBusy(false); });
			}

			var q = query.trim().toLowerCase();
			function matches(item) {
				if (!q) return true;
				return (
					String(item.name || "").toLowerCase().indexOf(q) >= 0 ||
					String(item.entryId || "").toLowerCase().indexOf(q) >= 0 ||
					String(item.description || "").toLowerCase().indexOf(q) >= 0
				);
			}

			var official = [];
			var other = [];
			for (var it of items || []) if (matches(it)) (it.official ? official : other).push(it);
			var activeArr = subTab === "official" ? official : other;

			function pluginRow(item) {
				var inv = item.cfg;
				var canUpdate = !item.official && !!updatable[item.name];
				// ZIP/manual installs without a recorded source: hint badge only —
				// once the source is recorded (or auto-confirmed), they upgrade
				// through the SAME one-click path as git/npm rows.
				var originUnknown = !item.official && !!originUnknownMap[item.name];
				return h("div", { key: item.entryId, className: "exm-row" },
					h("div", { className: "exm-main" },
						h("div", { className: "exm-name-line" },
							h(Badge, { text: item.enabled ? t("common.enabled") : t("common.disabled"), state: item.enabled ? "on" : "off" }),
							h("span", { className: "exm-name" }, item.name || item.entryId),
							tierBadge(t, item),
							canUpdate ? h(Badge, { text: t("plugins.updateAvailable"), state: "on" }) : null,
							originUnknown ? h(Badge, { text: t("plugins.originUnknown"), state: "ro" }) : null,
							item.phase ? h(Badge, { text: item.phase }) : null),
						h("div", { className: "exm-sub", title: item.description || "" }, item.description || ""),
						h("div", { className: "exm-sub" }, [item.entryId || "", item.moduleName || ""].filter(Boolean).join(" · ")),
						inv ? h("details", { style: { marginTop: 2 } },
							h("summary", { style: { cursor: "pointer", fontSize: 11, color: "var(--dsw-alias-label-secondary,#646a73)" } },
								t("plugins.effectiveConfig")),
							h("pre", {
								className: "exm-textarea",
								style: { minHeight: 0, maxHeight: 180, overflow: "auto", margin: "4px 0 0" }
							}, JSON.stringify(inv, null, 2))) : null),
					h("div", { className: "exm-actions" },
						canUpdate ? Btn({ onClick: function () { doUpdateOne(item); }, disabled: busy }, t("plugins.update")) : null,
						item.tier !== "locked"
							? Btn({ onClick: function () { doToggle(item); }, disabled: busy }, item.enabled ? t("plugins.disable") : t("plugins.enable"))
							: null,
						item.tier === "free"
							? Btn({ className: "exm-btn exm-danger", onClick: function () { doRemove(item); }, disabled: busy }, t("plugins.uninstall"))
							: null));
			}
			return h("div", { className: "exm-wrap" },
				msg ? h("div", { className: "exm-msg " + (msg.kind === "ok" ? "exm-ok" : "exm-err") }, msg.text) : null,
				h("div", { className: "exm-toolbar" },
					h("div", { className: "exm-seg" },
						h("button", {
							className: subTab === "other" ? "exm-active" : "",
							onClick: function () { setSubTab("other"); },
						}, t("plugins.other")),
						h("button", {
							className: subTab === "official" ? "exm-active" : "",
							onClick: function () { setSubTab("official"); },
						}, t("plugins.official"))),
					subTab === "other"
						? Btn({ onClick: function () { setMsg({ kind: "ok", text: t("plugins.checking") }); doCheckUpdates(); }, disabled: busy }, t("plugins.checkAll"))
						: null,
					(function () {
						if (subTab !== "official") return null;
						// 按钮只在只读清单页仍启用时出现；选项 A 下 settings-plugins
						// （配置卡片）是刻意保留启用的，不算待融合目标。
						var nativeInv = null;
						for (var x of items || []) {
							if (String(x.name || "") === "@deepseek-ai/dsh-client-ui-settings-plugin-inventory") nativeInv = x;
						}
						if (!nativeInv || !nativeInv.enabled || nativeInv.tier === "locked") return null;
						return Btn({
							onClick: function () {
								if (!window.confirm(t("plugins.absorbConfirm"))) return;
								setBusy(true);
								setMsg(null);
								call("setPluginEnabled", { id: nativeInv.entryId, enabled: false })
									.then(function () {
										setMsg({ kind: "ok", text: t("msg.pendingRestart") });
										reload();
									})
									.catch(function (e) { setMsg({ kind: "err", text: errText(e) }); })
									.finally(function () { setBusy(false); });
							},
							disabled: busy,
						}, t("plugins.absorbNative"));
					})(),
					h("div", { className: "exm-spacer" }),
					h(Badge, { text: String(activeArr.length) })),
				h("input", {
					className: "exm-input",
					placeholder: t("plugins.search"),
					value: query,
					onChange: function (e) { setQuery(e.target.value); },
				}),
				items === null
					? h("div", { className: "exm-empty" }, "…")
					: activeArr.length === 0
						? h("div", { className: "exm-empty" }, "(empty)")
						: h("div", { className: "exm-list" }, activeArr.map(pluginRow)));
		}

		// ── error boundary: any child crash shows its message instead of blanking ─
		class ExmErrorBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error: error };
			}
			render() {
				if (this.state && this.state.error) {
					var msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
					return h("div", { className: "exm-msg exm-err", style: { whiteSpace: "pre-wrap" } },
						"扩展管理渲染错误（请截图反馈）：\n" + msg);
				}
				return this.props.children === undefined ? null : this.props.children;
			}
		}

		// ── Git 仓库 tab ────────────────────────────────────────────────────────
		function GitTab(props) {
			var t = tBound || (props && props.t) || makeT("zh");
			var userState = React.useState("");
			var user = userState[0];
			var setUser = userState[1];
			var reposState = React.useState(null);
			var repos = reposState[0];
			var setRepos = reposState[1];
			var selState = React.useState(null); // selected repo fullName
			var selected = selState[0];
			var setSelected = selState[1];
			var unitsState = React.useState(null);
			var units = unitsState[0];
			var setUnits = unitsState[1];
			var msgState = React.useState(null);
			var msg = msgState[0];
			var setMsg = msgState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];

			React.useEffect(function () {
				call("getState", {}).then(function (s) {
					if (s && s.gitUser) setUser(s.gitUser);
				}).catch(function () { });
			}, []);

			function loadRepos(u) {
				setBusy(true);
				setMsg(null);
				setRepos(null);
				setSelected(null);
				setUnits(null);
				call("gitRepos", { user: u }).then(function (r) {
					if (r && r.ok) {
						var list = (r.repos || []).filter(function (x) { return !x.isFork; });
						setRepos(list);
						call("setState", { patch: { gitUser: u } }).catch(function () { });
					} else {
						setMsg({ kind: "err", text: (r && r.message) || "failed" });
					}
				}).catch(function (e) { setMsg({ kind: "err", text: errText(e) }); })
					.finally(function () { setBusy(false); });
			}
			function browse(repo, branch) {
				setSelected(repo);
				setUnits(null);
				setBusy(true);
				call("gitBrowse", { repo: repo, ref: branch }).then(function (r) {
					setUnits(r && r.ok ? r : { ok: false, message: r && r.message });
					// 面板在列表上方，滚动定位让用户立刻看到结果
					setTimeout(function () {
						var el = document.getElementById("exm-git-panel");
						if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
					}, 50);
				}).catch(function (e) { setUnits({ ok: false, message: errText(e) }); })
					.finally(function () { setBusy(false); });
			}
			function doInstallSkill(item, repo, branch) {
				setBusy(true);
				setMsg(null);
				call("gitInstallSkill", { repo: repo, ref: branch, path: item.path, name: item.name })
					.then(function (r) {
						if (r && r.exists && !r.ok) {
							if (!window.confirm(t("git.overwriteConfirm") + " [" + r.name + "]")) return;
							return call("gitInstallSkill", { repo: repo, ref: branch, path: item.path, name: item.name, force: true })
								.then(function () { setMsg({ kind: "ok", text: t("msg.saved") }); });
						}
						setMsg({ kind: "ok", text: t("msg.saved") + ": " + (r && r.name || "") });
					})
					.catch(function (e) { setMsg({ kind: "err", text: errText(e) }); })
					.finally(function () { setBusy(false); });
			}
			function doInstallPlugin(repo, subdir) {
				if (!window.confirm(t("git.installPlugin") + ": " + repo + (subdir ? " / " + subdir : "") + "?")) return;
				setBusy(true);
				setMsg(null);
				call("gitInstallPlugin", { repo: repo, subdir: subdir }).then(function (r) {
					setMsg(r && r.ok !== false
						? { kind: "ok", text: (r && r.message) || t("msg.pendingRestart") }
						: { kind: "err", text: (r && r.message) || "failed" });
				}).catch(function (e) { setMsg({ kind: "err", text: errText(e) }); })
					.finally(function () { setBusy(false); });
			}

			var repoRows = (repos || []).map(function (rp) {
				return h("div", { key: rp.fullName, className: "exm-row" },
					h("div", { className: "exm-main" },
						h("div", { className: "exm-name-line" },
							h("span", { className: "exm-name" }, rp.name),
							rp.description ? h(Badge, { text: rp.description.slice(0, 40) }) : null),
						h("div", { className: "exm-sub" }, rp.fullName + " · " + (rp.defaultBranch || "main"))),
					h("div", { className: "exm-actions" },
						Btn({
							onClick: function () { browse(rp.fullName, rp.defaultBranch); },
							disabled: busy,
						}, t("git.browse"))));
			});

			var unitPanel = null;
			if (selected && units) {
				var skillRows = (units.skills || []).map(function (sk) {
					return h("div", { key: sk.path, className: "exm-row" },
						h("div", { className: "exm-main" },
							h("div", { className: "exm-name-line" }, h("span", { className: "exm-name" }, sk.name)),
							h("div", { className: "exm-sub" }, sk.path)),
						h("div", { className: "exm-actions" },
							Btn({ onClick: function () { doInstallSkill(sk, selected, units.ref || "main"); }, disabled: busy }, t("git.installSkill"))));
				});
				var pluginRows = (units.plugins || []).map(function (pl) {
					var kind = pl.kind || "unknown";
					var kindText = kind === "dsh-plugin" ? t("git.kind.dsh")
						: kind === "mcp-server" ? t("git.kind.mcp")
						: kind === "read-error" ? t("git.kind.readerror") : t("git.kind.unknown");
					var note = kind === "mcp-server" ? t("git.mcpHint")
						: kind === "read-error" ? t("git.readErrorHint") : null;
					return h("div", { key: pl.path || "(root)", className: "exm-row" },
						h("div", { className: "exm-main" },
							h("div", { className: "exm-name-line" },
								h("span", { className: "exm-name" }, pl.label),
								h(Badge, { text: kindText, state: kind === "dsh-plugin" ? "on" : "ro" }),
								pl.name ? h(Badge, { text: pl.name }) : null),
							h("div", { className: "exm-sub" }, t("git.pluginFound") + (pl.path ? " · " + pl.path : "")),
							note ? h("div", { className: "exm-sub", style: { color: "#b58a00" } }, note) : null),
						h("div", { className: "exm-actions" },
							kind === "dsh-plugin"
								? Btn({ onClick: function () { doInstallPlugin(selected, pl.path); }, disabled: busy }, t("git.installPlugin"))
								: null));
				});
				unitPanel = h("div", { id: "exm-git-panel", style: { border: "1px solid var(--dsw-alias-border,#e5e6eb)", borderRadius: 12, padding: 12 } },
					h("div", { className: "exm-name-line", style: { marginBottom: 6 } },
						h("span", { className: "exm-name" }, selected),
						h(Badge, { text: t("git.repoHint"), state: "ro" })),
					units.ok === false ? h("div", { className: "exm-msg exm-err" }, units.message) : null,
					h("div", { className: "exm-sub", style: { fontWeight: 600 } }, t("git.skillsFound") + " (" + (units.skills || []).length + ")"),
					skillRows.length ? h("div", { className: "exm-list" }, skillRows) : null,
					h("div", { className: "exm-sub", style: { fontWeight: 600, marginTop: 8 } }, t("git.pluginFound") + " (" + pluginRows.length + ")"),
					pluginRows.length ? h("div", { className: "exm-list" }, pluginRows)
						: (!skillRows.length ? h("div", { className: "exm-empty" }, t("git.none")) : null));
			}

			return h("div", { className: "exm-wrap" },
				msg ? h("div", { className: "exm-msg " + (msg.kind === "ok" ? "exm-ok" : "exm-err") }, msg.text) : null,
				h("div", { className: "exm-toolbar" },
					h("input", {
						className: "exm-input",
						style: { maxWidth: 260 },
						placeholder: t("git.user"),
						value: user,
						onChange: function (e) { setUser(e.target.value); },
					}),
					Btn({ kind: "primary", onClick: function () { loadRepos(user.trim()); }, disabled: busy || !user.trim() }, t("git.load")),
					h("div", { className: "exm-spacer" }),
					h(Badge, { text: repos ? String(repos.length) : "", state: "ro" })),
				unitPanel,
				repoRows.length ? h("div", { className: "exm-list" }, repoRows)
					: h("div", { className: "exm-empty" }, repos ? "(0)" : "…"));
		}

		// ── section root ────────────────────────────────────────────────────────
		function ExtensionManagerSection(props) {
			// Always prefer our namespace-bound translator; the shell-injected `t`
			// does not know our dictionary keys and yields empty labels.
			var t = tBound || (props && props.t) || makeT("zh");
			var tabState = React.useState("skills");
			var tab = tabState[0];
			var setTab = tabState[1];
			return h("div", { className: "exm-wrap" },
				h("div", { className: "exm-tabs" },
					h("button", {
						className: "exm-tab" + (tab === "skills" ? " exm-active" : ""),
						onClick: function () { setTab("skills"); },
					}, t("tab.skills")),
					h("button", {
						className: "exm-tab" + (tab === "mcp" ? " exm-active" : ""),
						onClick: function () { setTab("mcp"); },
					}, t("tab.mcp")),
					h("button", {
						className: "exm-tab" + (tab === "plugins" ? " exm-active" : ""),
						onClick: function () { setTab("plugins"); },
					}, t("tab.plugins")),
					h("button", {
						className: "exm-tab" + (tab === "git" ? " exm-active" : ""),
						onClick: function () { setTab("git"); },
					}, t("tab.git"))),
				tab === "skills" ? h(ExmErrorBoundary, null, h(SkillsTab, { t: t })) : null,
				tab === "mcp" ? h(ExmErrorBoundary, null, h(McpTab, { t: t })) : null,
				tab === "plugins" ? h(ExmErrorBoundary, null, h(PluginsTab, { t: t })) : null,
				tab === "git" ? h(ExmErrorBoundary, null, h(GitTab, { t: t })) : null);
		}

		// ── plugin face ──────────────────────────────────────────────────────────
		var inject = ["slots", "connection", "remote", "locale"];
		async function apply(ctx) {
			ctxRef = ctx;
			ctx.locale.register(NS, { zh: zh, en: en });
			// Mount the Remote contribution so the `extensionManager` namespace
			// exists. Self-created dependency: resolve via reflect, never inject.
			await ctx.remote.$mount(REMOTE_CONTRIBUTION);
			apiRef = ctx.reflect.get("remote.extensionManager");
			if (!apiRef) throw new Error("extensionManager namespace failed to mount");
			tBound = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "extension-manager",
					order: 95,
					label: function () { return tBound("nav"); },
				}, ExtensionManagerSection);
			});
			// Sidebar live-status widget removed by product decision (user, 2026-08).
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
