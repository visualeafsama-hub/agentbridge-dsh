# Changelog

本仓库每次修复/功能的变更记录。格式：`日期 · 提交` — 说明。

## 2026-08-19

### `b6b45fa` — standby 模式：对端没起来不再崩溃
- `abg dsh --pair <新名>` 新建 pair 后若对端 daemon 未运行，attach 和 channel 都连不上时会**崩溃**（未捕获的 WS 连接异常），DSH web/chromium 都没来得及启动。
- 现在回退到 **standby 引擎**：MCP、DSH web、chromium 照常启动；面板基于文件（daemon.json/rollout/bridge.pair）实时跟随 pair；`send_message`/`get_messages` **惰性重连**——`abg claude --pair X` 起来后直接可用，无需重启 `abg dsh`。
- `pair_status` 增加 `mode: "standby"` 状态上报；`cmdEnv` 的 engine 初始化加 try/catch 兜底。

### `418e660` — pair 发现：`--pair <新名>` 自动新建
- 适配器的 `discoverPair` 是残缺重写：匹配不到名字时**静默回退到同目录 live 的旧 pair**（`--pair A` 落到 CS 的根因）。
- 现在镜像真实 abg 的 `resolvePair`：名字匹配不到 → **自动新建**（`pairId = 名字-8位sha256`、最低空闲 slot、端口按 slot 推导）；跨目录引用已有 pair 报错（PAIR_CROSS_CWD 语义）；重复发现幂等。
- 新建时给出提示：`start the codex/daemon side with: abg claude --pair <name>`。

### `dsh` web+chrome 包装脚本（`bin/dsh` + install.sh）
- 裸 `dsh` / `dsh web` 现在默认：后台起 `dsh web` → 轮询等 3080 就绪 → 打开 chromium `--app` 窗口（已开则跳过，幂等）。
- 自定位真实 dsh（跳过自身），任意 PATH 位置可用；与 abg 共享 `~/agentbridge-dsh/run/` 的 pid/日志约定，`abg dsh --pair X` 后续运行会自动跳过 web/chrome，只补 MCP。
- chromium 检测用 **pid 文件 + `kill -0` + `/proc/<pid>/cmdline`**；abg-dsh 的 `chromiumAppRunning` 同步加固（原先的 `ps|grep "chromium.*--app="` 会把自己/父 shell 的 cmdline 匹配进去——假阳性）。

## 2026-08-14

### `535862f` — agentbridge-dsh 初始提交
- DSH ↔ agent-bridge 适配器：`abg dsh` 启动 MCP 桥 + DSH web + chromium，attach 模式让 DSH 接管 claude 席位。

### `63a4c55` — install.sh
- 可移植的 `abg dsh` shim 安装器（`~/.bun/bin/abg`，其余命令透传真实 abg）。

### 后续（`5237b1d`/`13afef2`/`18f6937`/`8c613f1`）
- README：验证状态如实标注、agent-bridge 文档链接、与 dsh-pair-panel 互链、chromium 依赖说明、预览图。
