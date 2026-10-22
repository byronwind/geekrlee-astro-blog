---
title: "Pi：一个最小 agent harness，和我怎么把它跑在本地"
author: "Lee"
pubDatetime: 2026-10-22T05:00:00Z
featured: false
draft: false
tags:
  - Agent
  - Pi
  - LLM
  - Tooling
  - Local-models
description: "Pi 1.2.0 的设计理念和架构：agent loop、JSONL 会话树、context 组装。记录本地部署、接 llama.cpp/Ollama 本地模型，以及 pi-web-ui 这个浏览器界面日常用下来的感受。"
timezone: "Asia/Shanghai"
---

## 目录

Pi 不是"功能最全的 coding agent"。它更像一个 agent harness：模型调用、工具执行、上下文组装、会话存储，这四件事做得干净，其余一概不管。没有内置 sub-agent，没有 plan mode，也没有花哨的工作流——取舍很明确，内核最小，扩展面完整。我目前用它跑本地模型加浏览器界面（pi-web-ui），日常写代码够用，比那些大而全的 CLI 更省心。

版本基线是 `pi --version` → 1.2.0，Node ≥ 22.19。

---

## 1. 设计理念

Pi 官方 README 里那句话基本就是全部哲学：

> Adapt Pi to your workflows, not the other way around.

拆开看有三层意思。

**第一层：内核只做必要的事。** 一个 agent harness 的最小职责是：收到消息 → 组装请求（system prompt + 历史 + 工具定义）→ 发给 provider → 流式拿回复 → 执行 tool call → 记录结果 → 决定要不要再来一轮。Pi 就做到这里为止。

**第二层：可扩展性靠机制，不靠功能。** extensions（TypeScript 模块，注册工具/命令/快捷键/provider/渲染器）、skills（按需加载的指令文件）、prompt templates、themes，这四类是一等公民，可以打包成 Pi package 用 npm 或 git 分发。想要 sub-agent？装个包，或者让 Pi 自己写一个 extension。

**第三层：界面是壳，机制只有一套。** interactive TUI、print/JSON 模式、RPC、TypeScript SDK、以及第三方 web UI，全都走同一个 agent 和 session 实现。这一点很关键——它意味着 web UI 不是"另一套产品"，只是同一内核换了个前端。后面讲 pi-web-ui 时你会看到这点带来的实际好处（会话共享）。

我喜欢的地方：它不替我决定工作流。我的 skills/extensions 里放的是我自己的流程，而不是某个厂商的"最佳实践"。

---

## 2. 架构

### 2.1 agent loop

一轮（turn）的生命周期：

```text
提交消息 → 加入 active branch
         → 组装请求：system prompt + active branch + tools + model settings
         → provider 流式返回（文本 + tool calls）
         → 执行每个 tool call，记录结果
         → 需要再问模型则进入下一轮，否则结束
```

steering message（中途插话）在**当前 assistant turn 结束后**注入，follow-up 在 agent 干完手头的活之后才生效。这个语义和 TUI、web UI、RPC 是一致的——同一个 loop，不同接口只是喂消息的方式不同。

### 2.2 session 是一棵树

Pi 的会话不是线性数组，是 JSONL 文件里的**树**：每条 entry 有 id，指向它的 parent；当前 entry 所在的路径就是 active branch，下一次请求的历史由它提供。

这个设计带来两个很实用的后果：

- 从中间某条 entry 继续（`/tree`、web UI 里的 edit & re-ask）= 在同一文件里开一条新分支，原对话完全不动。探索另一种方案时不用丢掉历史。
- compaction 不是删历史，是插入一条 summary entry，后续请求用摘要替代老消息，原始 entry 仍在树里。所以压缩之后你还能翻回原文。

### 2.3 context 组装

system prompt = 基础指令 + 从工作目录发现的上下文文件（AGENTS.md 之类）。工具定义和 skill 描述随请求一起发出去；skill 的全文按需加载，不是每次都塞进 prompt——这点在 skills 多的时候对 token 开销影响很大。

### 2.4 接口层

| 模式 | 用途 |
|---|---|
| interactive（TUI） | 日常交互 |
| print / JSON | 脚本、CI，输出最终回复或 JSONL 事件流 |
| RPC | stdin/stdout 控制一个独立 Pi 进程 |
| TypeScript SDK | 在应用内跑 agent session（pi-web-ui 就是这么接的） |

---

## 3. 本地部署

安装走官方脚本最省事，它会把依赖 pin 住：

```bash
curl -fsSL https://pi.dev/install.sh | sh
# 或 npm（不 pin 传递依赖）
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi 正常运行不需要依赖的 lifecycle script，所以 `--ignore-scripts` 是安全的。Node 要求 ≥ 22.19——我机器上跑的是 v22.19 和 v24.15 两个版本，注意 nvm 默认版本要对得上。

进项目目录再启动，工作目录影响上下文文件发现和会话分组：

```bash
cd /path/to/project
pi
```

`/login` 选 provider（订阅或 API key），凭据存在 `~/.pi/agent/auth.json`；`/model` 选模型。配置目录 `~/.pi/agent` 下就是 `auth.json`、`models.json`、`sessions/`、skills 这些，整个状态都在明文文件里，备份和迁移都很直接。

### 3.1 接本地模型

两条路。

**llama.cpp router。** 启动 `llama-server` 时**不要**带 `--model`（带了就是单模型模式），用 `--models-dir` 让它进 router：

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 --port 8080 \
  -ngl 999 -c 32768
```

Pi 里用 `/llama` 管理 router，`/model` 选它已加载的模型。`--no-models-autoload` 让加载显式化——router 按需装卸 GGUF，多模型共用一个 server，这个比手动开多个 server 舒服很多。多 shard / 多模态模型放子目录，单文件模型直接放根目录。

**OpenAI/Anthropic/Google 兼容端点。** Ollama、LM Studio、vLLM、SGLang 走 `models.json`：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

`apiKey` 写个占位值让模型出现在选择器里就行（Ollama 会忽略它）。需要真凭据的话，`apiKey` 和 header 支持 `$NAME` / `${NAME}` 环境变量插值、字面值，或者 `!command`（请求时执行，不缓存）。打开 `/model` 会重新读文件，改完不用重启。

我的判断：本地模型走 router/兼容端点就够了；只有 provider 协议或鉴权流程特殊才需要写 provider extension。另外 `pi update --models` 刷新模型目录，离线时缓存数据仍可用——在网不通的环境里这个细节挺关键。

---

## 4. pi-web-ui

[pi-web-ui](https://github.com/xing-shuyin/pi-web-ui)（作者 xing-shuyin）是社区做的浏览器前端：agent 跑在服务端，事件通过 WebSocket 推到浏览器。它不是"给 pi 加了个网页"，而是把日常开发需要的那几块拼在一个 tab 里——chat、文件、终端、Git、模型管理。

安装和运行：

```bash
npm i -g --allow-scripts=node-pty pi-web-ui   # npm 12+ 默认拦 install script，node-pty 是原生模块
pi-web-ui                                      # http://localhost:8787
```

Linux 上 node-pty 没有 prebuild，必走 `node-gyp`，先装好 `build-essential python3`。macOS/Windows 有预编译。

我把它装成了系统服务（`pi-web-ui server install`，macOS 上生成 launchd plist、Linux 开机自启），工作目录固定，`PI_WEB_PORT`、`PI_WEB_CWD`、`PI_WEB_DATA_DIR` 这些环境变量写在 plist 里，崩了自动拉起。

### 4.1 实际用得最顺的几块

**会话和 CLI 共享。** web UI 读的是 `<agentDir>/sessions/--<cwd>--/`，也就是 pi CLI/TUI 写的同一份 transcript。浏览器里看到的和终端 `pi` 打开的是同一个项目、同一份历史——我经常终端起一个任务、浏览器里看进度，或者反过来。

**steer / follow-up 队列。** agent 正在回复时插话会被排队，等当前 turn 的 tool call 收尾后注入。语义和 TUI 里的 Interrupt 等价。排队的气泡可以丢弃或撤回成草稿，这个比"打断重打一遍"温和很多。

**subagent。** pi 内核故意不做 sub-agent，pi-web-ui 用工具层补上了：`subagent` 工具 spawn 独立的后台会话做并行探索/实现/review，`action="wait_all"` 收集结果不用轮询；模板（Settings → Subagent templates）配 role prompt、skills/extensions 白名单、模型和 thinking level。内置 13 个模板里 review / implement / research / scout / audit 这几个我常直接用。注意这些是 web UI 加的，不是 pi 内核的能力——用 SDK 或 CLI 时想要同样的东西得自己装包或写 extension。

**Git panel 和终端。** status/diff/history、单文件 stage、commit box、分支选择器；写入操作跑在可见终端里，面板跟着走。外部提交的 commit 会自动出现（30s 兜底轮询）。内置终端是 xterm.js + node-pty，支持"terminal-backed bash"——agent 的 bash tool 跑在一个持久可见的终端里，`cd`、venv、ssh 状态跨调用保留。默认关闭，我开着，调试长任务时很值。

**模型管理。** UI 里直接编辑 `models.json`、每个 provider 存多个命名 key、Custom providers 支持 server 端 probe `/models`（所以局域网/loopback 端点不受 CORS 影响）。key 和 header 不出服务端，只回昵称。

### 4.2 两个容易踩的坑

**SDK 副本问题。** pi-web-ui 依赖 `@earendil-works/pi-coding-agent`，npm 全局安装会把依赖嵌套，Node 先解析嵌套副本——所以升级全局 pi CLI **不会**改变服务端实际跑的 SDK。看用哪个副本：`curl /api/health`（`piSdkCopies` 第一项是生效的）。想让服务跟随较新的全局 SDK，用 `PI_WEB_SDK=global` 启动。我一开始被这个绕了一圈，后来干脆只升级 pi-web-ui 本身。

**安全边界。** web UI 默认只听 loopback；provider key、header 不下发到浏览器。但要清楚：pi 的工具和 extension 以进程权限运行，trust 决定加载哪些项目资源，**不**沙箱 tool call。这个限制对 CLI 和 web UI 同样成立——在不信任的目录里跑之前先看 [Security](https://github.com/earendil-works/pi/blob/main/docs/security.md) 那页。

---

## 5. 我的用法小结

分工大概是：终端 `pi` 做短任务和小改动；需要挂着跑、要看文件树/Git/多会话并行时切浏览器；脚本和 CI 用 print/JSON 模式。skills 放流程性指令（比如审计、批量处理这类），extensions 放真正需要执行代码的集成——这两层就是 Pi 的全部"个性化"，内核保持干净。

Pi 的价值在于它把 harness 这一层做得稳：会话是文件、分支可回溯、compaction 不丢原文、接口共用同一机制。功能上它故意留白，而这些留白恰好是可以用 extension/skill 精确补上的部分。如果你要的是"开箱即用但工作流属于自己"，这个组合比大部分同类更合手。

---

## 参考

- Pi 仓库与文档：[github.com/earendil-works/pi](https://github.com/earendil-works/pi)（`docs/how-pi-works.md`、`docs/models.md`、`docs/llama-cpp.md`）
- pi-web-ui：[github.com/xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui)
