---
title: "在四块 2080 Ti 上跑 Qwen3.8-Flash-Next（Strata）"
author: "Lee"
pubDatetime: 2026-10-22T00:00:00Z
featured: false
draft: false
tags:
  - LLM
  - Inference
  - Hardware
  - Strata
  - Qwen3
  - Flash-Next
description: "4×RTX 2080 Ti + 188 GB RAM，用 Strata 跑 125B MoE：71–85 tok/s 解码、1.4K tok/s prefill，专家缓存驻留显存，HumanEval 40/41。附部署过程、coding bench、调参结论和踩坑清单。"
timezone: "Asia/Shanghai"
---

## 目录

先说结论：在一台 **4×RTX 2080 Ti（44 GB）+ 188 GB 内存**的老机器上，用 Strata 跑 **Qwen3.8-Flash-Next（125B MoE，激活 6B）**，IQ2_XS 量化常驻显存，解码 **71–85 tok/s**、7.4K prompt 的 prefill **1.4K tok/s**，是手上那台跑 27B Q8 机器的 **3 倍多**。专家槽位 **92.6%** 命中，解码期间不读内存里的专家、也不读盘。

这台机器现在的定位是本地 code agent 的推理后端：质量上并没有超过手上那台 27B Q8，但速度快了三倍多，写代码时等它比等人快。

---

## 1. 为什么是这台机器

对照的那台是 5×RTX 3060（60 GB），跑 llama.cpp + Qwen3.8-27B UD-Q8_K_L，解码 24.5 tok/s、prefill 396–837。它显存已经占满（单 slot、163840 上下文），塞不下第二个模型；驱动 570 低于引擎要求的 580.65，只能用 experimental 的 CUDA 12 分支，系统版本也不在支持列表里。

4×RTX 2080 Ti 这台虽然老，但 GPU 空闲、驱动和系统都在官方支持范围内，11 GB × 4 = 44 GB 显存加 188 GB 内存刚好够 Strata 的三档布局。

**为什么用 Strata 而不是 llama.cpp**：Flash-Next 是 125B MoE，外加一张 51B 的 n-gram 表（实际落盘约 29 GB），llama.cpp 放不进 44 GB。Strata 的三档设计正好对路——专家缓存进显存、全量专家驻内存、n-gram 表留在 SSD。

---

## 2. 硬件与系统

| 项 | 实测 |
|---|---|
| GPU | 4 × RTX 2080 Ti 11,264 MiB（合计 44 GB），sm_75，616 GB/s，250 W |
| CPU | 2 × Xeon E5-2690 v4 @2.6 GHz，28C/56T，只有 AVX2，没有 AVX-512 |
| 内存 | 188 GB |
| 系统 | Ubuntu 22.04.5 LTS，glibc 2.35，kernel 5.19 |
| 驱动 | 580.126.09 → 走官方 CUDA 13 引擎（不是 experimental） |
| PCIe | Gen3；其中一张是 x8（实测 6.0 GB/s），其余 x16（11.8 GB/s）；无 NVLink |
| NUMA | 一张卡挂在 node0，另外三张在 node1，跨 socket 交接 |
| 磁盘 | 3.7 T NVMe 形态 SSD，模型放在 `models/strata` |
| 网络 | HuggingFace 不通；ModelScope 通（约 18 MB/s）；GitHub 通但慢（约 0.5 MB/s），走 gh-proxy |

---

## 3. 部署过程

### 3.1 装控制端

```bash
curl -fsSL https://github.com/Niko1221/Strata/releases/latest/download/install.sh -o /tmp/strata-install.sh
sh /tmp/strata-install.sh          # 约 99 MB，校验 SHA-256 与签名 feed
# => ~/.local/bin/strata，版本 0.2.1（build 0.1.46.3）
```

### 3.2 引擎与模型

```bash
# 引擎 605 MB：直连约 0.5 MB/s，走 gh-proxy 约 2.5 MB/s
strata launch --model q2_0 --data-dir <模型目录> \
  --gpu 0,1,2,3 --context 131072 --kv int8 --vision cpu --parallel 1 \
  --feed "https://github.com/Niko1221/Strata/releases/latest/download" \
  --set STRATA_STAGE_TRIM=1 --yes --no-tui

# 用 ModelScope（官方支持）
export STRATA_SOURCE=modelscope
```

| 文件 | 体积 | 备注 |
|---|---:|---|
| Q2_0（2 shard） | 66.4 GB | 37.6 + 28.8 |
| IQ2_XS（2 shard） | 64 GB | 后装，与 Q2_0 共享 MTP / vision |
| MTP draft 层 | 5.2 GB | 投机解码 |
| vision（mmproj BF16） | 0.9 GB | 每卡余量不足 24 GB，所以读图走 CPU |
| **合计** | **109 GB** | 盘上还剩约 390 GB |


### 3.3 关键配置

profile 里这几项是「必须这样设」，理由各不相同：

| 参数 | 原因 |
|---|---|
| `STRATA_STAGE_TRIM=1`（环境变量） | 每张卡只加载自己那几层的 dense（约 800 MiB/卡，而不是全量 3.4 GB），腾出约 2.5 GB/卡给专家缓存 |
| `--prefill 2048` | 11 GB 卡上的分块甜点；7.4K prompt 的 prefill 从 879 提到 1,378–1,531 tok/s（+57~59%） |
| `--kv int8 --kv-resident 32768` | 128K 上下文只在显存放 32K 窗口，其余流式（全量 KV 约 1.8 GB/卡） |
| `--ple-io ram` | 29 GB n-gram 表常驻内存（188 GB 充裕），避免每个 token 随机读盘 |

另外：`reasoning_effort: "none"`（服务端默认关思考）、`--spec 4 --spec-min-p 0.5`、`--expert-cache auto`。

### 3.4 做成 systemd user service

不需要 sudo，`~/.config/systemd/user/strata-flash-next.service`：

```ini
[Unit]
Description=Strata: Qwen3.8-Flash-Next IQ2_XS (4x RTX2080Ti, LAN, thinking off)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=<terminal 当前版本目录>
ExecStart=<strata 可执行文件> serve --profile <profile 路径> --host 0.0.0.0 --port 8080
Restart=always
RestartSec=5
TimeoutStartSec=900
KillSignal=SIGINT
StandardOutput=append:<日志路径>
StandardError=append:<日志路径>

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now strata-flash-next
loginctl enable-linger <用户名>     # Linger=yes，重启后免登录自启
```

冷启动到就绪 60 s（首次）/ 65 s（restart），`NRestarts=0`。

### 3.5 接入 agent

| 项 | 值 |
|---|---|
| OpenAI 兼容 | `http://<内网 IP>:8080/v1` |
| Anthropic | `http://<内网 IP>:8080/v1/messages`（Claude Code 的 `ANTHROPIC_BASE_URL` **不带 /v1**） |
| 鉴权 | 必须带 key，无 key 直接 401；key 写在 profile 里 |
| 模型名 | 别名 `flash-next` / `qwen3.8-flash-next`，全名 `qwen3.8-flash-next-iq2_xs` |

Codex CLI 用 `wire_api = "responses"`，Claude Code 用 `ANTHROPIC_MODEL=flash-next`。

---

## 4. 性能数据

所有数字来自引擎自报（`GET /metrics` 里的 `requests[].prompt_ms / decode_tok_s`）。客户端测的解码速度会被流式首包和缓冲干扰，实测能虚高 3–4 倍，不作为依据。

### 4.1 显存与专家驻留（决定一切）

| 量化 | 专家体积 | 显存内槽位 | 驻留率 | 专家缓存 | VRAM 余量 |
|---|---:|---:|---:|---:|---:|
| Q2_0 | 34 GB | 23,859 / 24,576 | **97.1%** | 31.4 GiB | 490 MiB |
| IQ2_XS | 36 GB | 22,763 / 24,576 | **92.6%** | 31.3 GiB | 494 MiB |
| IQ3_XXS | 43 GB | 18,337 / 24,576 | 74.6% | 29.8 GiB | 478 MiB |
| IQ3_S | 50 GB | 不建议（预估约 65%） | — | — | — |

`hit_rate 0.99–1.00`、`ram_blobs=0`、`file_blobs=0`，也就是解码期间不读内存专家、不读盘。四卡各占约 10.3 GB（总 41.9 / 44 GiB），温度 32–46 ℃，功耗 220–480 W。

### 4.2 吞吐（4 卡、trim、128K ctx、单流）

| 场景 | Q2_0（chunk 2048） | IQ2_XS（chunk 2048） | 27B Q8 对照 |
|---|---:|---:|---:|
| decode（4K 上下文） | **88–92 tok/s** | **71–85 tok/s** | 24.5 |
| decode（32K 上下文，chunk 8192） | 79.8 | 未测 | 22.5 |
| prefill 523 tok | 410 | 357 | 396 |
| prefill 1,906 tok | 739 | 668 | 576 |
| prefill 7,439 tok | **1,531** | **1,378** | 837 |
| prefill 29,575 tok（chunk 8192） | 2,018 | 未测 | — |
| MTP 投机接受率 | 77–84% | — | 46–65% |

### 4.3 prefill 分块扫描（最实用的一条调参结论）

| chunk | IQ2_XS @7.4K | IQ2_XS @9.6K | Q2_0 @7.4K |
|---|---:|---:|---:|
| 8192（默认） | 879 | — | 960 |
| 1024 | 1,166 | — | — |
| **2048** | **1,378** | **1,484** | **1,531** |
| 512 | — | 920 | — |

原因：11 GB 卡上 8K 分块的 prompt buffers 要去借专家缓存，而且四段流水重叠得不好；换成 2048 之后四张卡真正流水起来了。收益 +57~59%，跟量化无关。

### 4.4 端到端延迟（真实工作负载）

一次典型请求：约 3.2K token 输入 + 60 token 输出。

| 指标 | 数值 |
|---|---|
| prefill | 3,212 ms（994 tok/s，chunk 2048）/ 3,809 ms（chunk 8192） |
| 关思考端到端 | **4.1 s** |
| low 思考端到端 | 15–18 s |
| 27B Q8 对照 | 约 20 s/条 |

同样一条请求，从 20 s 降到 5 s。对交互式使用来说这个差值比峰值 tok/s 更直观。

### 4.5 视觉 / OCR

- 转写一张聊天截图：Q2_0 **5.3 s**、131 token（CPU reader）
- 27B VL 关思考：13–23 s；同网段另一台 1–14 s
- 27B VL 开思考：30–60 s，16 张里有 1 张撞 `max_tokens` 输出为空

关键开关不是 `/no_think` 文本前缀（**实测无效**：909 token 里 840 是思考），而是 `chat_template_kwargs:{enable_thinking:false}`——143 token、0 reasoning，冷启 16 s vs 43 s。

### 4.6 Coding bench（HumanEval 41 题）

做法：每 4 题取 1（共 41 题），生成后在本地跑官方 `check()`，temp 0，每题单独计时。对照组是 llama.cpp 上的 27B Q8。

| 配置 | pass@1 | 中位耗时 | 失败题 |
|---|---:|---:|---|
| Q2_0 关思考 | 38/41（92.7%） | **1.5 s** | 32, 120, 132 |
| Q2_0 low 思考 | 39/41（95.1%） | 3.8 s | 108, 160 |
| **IQ2_XS 关思考** | **40/41（97.6%）** | **1.5 s** | 32 |
| IQ2_XS low 思考 | 40/41（97.6%） | 4.9 s | 32 |
| 27B Q8 关思考 | 40/41（97.6%） | 4.8 s | 132 |
| 27B Q8 默认开思考 | 29–31/41（71–76%） | 18–29 s | 10 题 |

三点读数：

1. **pass@1 相同，体感完全不同**。IQ2_XS 关思考与 27B Q8 都是 40/41，但每题 1.5 s vs 4.8 s。批量跑 41 题，一个是 1 分钟量级，另一个是 3 分钟量级；agent 反复生成、失败、重试时这个差距会被放大好几倍。
2. **开思考对 coding 是负收益**。27B 默认开思考掉到 71–76%，耗时涨到 18–29 s——不是想得更深，而是长输出撞上限、格式漂移。Flash-Next 服务端默认 `reasoning_effort: none`，这个默认值是对的。
3. **量化升级换不来 coding 质量**。Q2_0 → IQ2_XS 是 ±2 题，41 题样本下 ±1 题就是 ±2.4pp，属噪声。花的是解码速度（88–92 → 71–85）。

**失败题的分布比分数更有信息量。** 两边都失败的题集中在同一类：滑动窗口 / 边界条件 / off-by-one（第 32、132 题）。Q2_0 额外挂在 120、132，IQ2_XS 只挂在 32——说明 2-bit 在「状态边界需要精确推理」上有稳定短板，而不是随机抖动。这类题单独跑时加 low 思考就能救回来（Q2_0 的 108、160 也是同理），但代价是耗时从 1.5 s 涨到 3.8–4.9 s。

**三道工程题**（严格断言，不是单函数补全）：

| 题目 | 类型 | Q2_0 | IQ2_XS | 27B 关思考 | 27B 开思考 |
|---|---|---|---|---|---|
| `dedupe_summarise` | 中文集合去重 + 统计 | ✅ | ✅ | ✅ | ❌ |
| `fix_parse_when` | 日期解析修 bug | ✅ | ✅ | ✅ | ❌ |
| `rate_limiter` | 滑动窗口边界 | ✅ | ✅ | ✅ | ❌ |

三道题更接近日常用法：给一段已有代码、找错、改对。三个 2-bit 量化全部通过，开思考的 27B 反而只过 1/3——断言严格时「多说」不等于「更对」。

**工具调用**：Anthropic 格式 `tools` → `stop_reason=tool_use`，参数正确、没有多余解释，**1.6 s**。这条对 agent 很关键，因为它决定了每轮 turn 的固定开销；按 16 个 turn 算，光 tool_use 就省下半分钟。

### 4.7 跟 27B 的总账

| | Flash-Next IQ2_XS | Qwen3.8-27B Q8 |
|---|---|---|
| decode | 71–85 tok/s | 24.5 tok/s |
| prefill @7.4K | 1,378 | ~800 |
| HumanEval | 97.6% | 97.6% |
| 每题耗时 | **1.5 s** | 4.8 s |
| 权重体积 | 64 GB（2 bit） | 27 GB（8 bit） |
| 适合 | coding agent / 通用问答 | 需要更稳判断质量的任务 |

### 4.8 一个真实 agent 任务（不只是补全）

HumanEval 只测「给签名写函数」。日常用法是另一回事：多文件、已有实现、失败测试、不许改测试。所以拿一个小项目跑了一遍——CSV 记录去重与统计：按「人 + 起止日期 + 集合」去重并保留最新创建时间，规范化字段，汇总统计，CLI 输出 JSON 与错误退出码。硬约束是**不许改 `tests/`**、只用标准库。8 个用例原本 7 个失败。

结果：51 s 内 **8/8 通过**；`tests/` 运行前后 md5 一致；CLI 输出正确（`total 7 / duplicates 3`，并列名次按姓名升序），缺文件时走 stderr 并返回退出码 2；依赖只有 `re/csv/json/argparse/sys/collections`。

轨迹是 16 个 assistant turn、17 次工具调用（bash ×14、write ×3），11.3K in / 2.2K out，端到端约 43 tok/s，思考关闭。

顺序大致是：先 `ls/cat` 摸清 README、测试和源码 → 跑一次 pytest 拿基线 → 三个文件整文件重写 → 自测 pytest 与 CLI → 测试仍不过时用 `csv` 模块、`cat -A`、`od -c`、`grep` 排查，定位到**样例数据里某个含逗号的字段没加引号导致列偏移**（夹具本身的坑），改成中文逗号 → 复查没有 `.bak/.git` 残留 → 复验退出码。

两点观察：

1. 它改了数据样例让测试变绿。这次确实是夹具坏了（我埋的坑），它也给了诊断。但在真实仓库里这是「改输入而不是改逻辑」的经典异味，后续评测应该把 `data/` 也设为只读。
2. 用 `id(row)` 做行身份标记，逻辑正确但脆弱——对象一旦被复制就失效。属于可接受的实现选择。

值得肯定的是自验证闭环：改完主动跑测试和 CLI，而不是交差。代码本身也挑不出毛病（不可变复制、`Counter` 统计、并列名次按姓名升序、`FileNotFoundError → 退出码 2`）。

### 4.9 双 slot（`parallel=2`）值不值

条件：IQ2_XS、4 卡、`--prefill 2048`、关思考；每次请求约 600 token prompt + 256 token 输出，3 轮取中位。

| 配置 | 专家槽位 | 缓存 | 单流 decode | 2 并发聚合（墙钟） | 每流 decode | 2 并发 TTFT |
|---|---:|---:|---:|---:|---:|---:|
| `parallel=1`（现网） | 22,763 | 31.3 GiB | **81.2** | 44.4（串行排队） | 84.8 | 3.34 s |
| `--batch 2` | 21,477（−5.7%） | 29.6 GiB（−1.8） | 80.6（噪声内） | **53.5（+20.5%）** | **48.5（−43%）** | **2.31 s（−31%）** |
| `--batch 2 --batch-groups 2` | 21,477 | 29.6 GiB | 81.5 | 49.4（+11%） | 47.5 | 2.33 s |

只算 decode 稳态聚合：p1 的 84.8 → p2 约 97 tok/s（+14%），batch-groups 没有额外收益。

双 slot 是拿延迟换吞吐：总吞吐 +14~20%，但每条流只剩约 57% 速度；单流本身不受影响。代价很小（缓存 −1.8 GiB，驻留率 92.6% → 90.9%）。**给单个交互式 agent 用，保持 `parallel=1`**；只有多人或多 agent 同时用才值得开 2。`--batch-groups 2` 在这台四段 CUDA split 上没有收益，不建议叠加。

### 4.10 换 IQ3_XXS 的性价比

| 量化 | 专家槽位 | 缓存 | decode（600 tok prompt） | prefill | HumanEval | 工程题 | 冷加载 |
|---|---:|---:|---:|---:|---|---|---|
| IQ2_XS（默认） | 22,763（92.6%） | 31.3 GiB | **77.8–81.2** | ~1,600 ms | **40/41** | 3/3 | ~65 s（热） |
| IQ3_XXS | 18,337（74.6%） | 29.8 GiB | 72.3（−8~10%） | ~1,815 ms（−13%） | 38–39/41 | 3/3 | **5–15 min**（冷） |

缓存只比预估好一点（74.6% vs 预估 78%），因为 3-bit blob 更大（1.75 MB/槽）。decode 落在预估区间的上沿。

**coding 没有提升**：41 题样本下 ±1 题就是 ±2.4pp，38–39 与 40 属噪声，而且不高于 IQ2_XS。工程题两边都是 3/3。也就是说 3-bit 买不到 coding 上的好处，只买到更慢的解码。

真正有差别的是细粒度判断类任务（区间包含、字段覆盖这种容易「过于字面」的题）：IQ3_XXS 在 low 思考下能全对，Q2_0 和 IQ2_XS 都会漏一条。这类活儿不在 HumanEval 里，但在真实工作里常见——如果哪天要它做判断而不是写代码，3-bit 值得单独测。

加载是真成本：冷加载 5–15 min（47 GB 专家 + 28.8 GB PLE 表从盘读，实测约 123 MB/s），切模型还会把另一个模型的页缓存挤掉，切回来又要 4–9 min。磁盘多占 47 GB。

所以 coding 后端保持 IQ2_XS，IQ3_XXS 作为判断类备选保留，不设默认。

### 4.11 decode 跟内容有关（这条是修正）

前面 §4.2 的 77–85 tok/s 是「代码 / 结构化输出」口径。同样配置下按内容分类复测（temp 0、单流、prompt 41–560 token、输出 393–600 token）：

| 内容类型 | MTP 接受率 | decode |
|---|---:|---:|
| JSON 结构化（40 条记录） | **96.9%** | **81.2** |
| Python 代码（约 600 tok） | 79.3% | 70.9 |
| 英文技术散文 | 58.4% | 57.7 |
| 中文散文 | 56.2% | **56.2** |

decode 几乎完全由投机接受率决定（56% → 56 tok/s，97% → 81 tok/s，近似线性）。两个推论：

1. 对描述性任务（中文长篇解释、写报告），实际带宽是 **56–58 tok/s**，比代码低约 25%，别再拿 77–85 做预期。
2. 调 `--spec` / `--spec-min-p` 对散文类收益最大，代码类已经接近上限。

---

## 5. Coding bench 的局限

四十一题、每四题取一，这个样本量撑不起「哪个量化更好」这种结论。±1 题就是 ±2.4pp，38/41 和 40/41 之间没有可区分的差异。真正站得住的只有速度差和「开思考反而变差」这两条。

另外 HumanEval 测的是单函数补全，跟实际用法（多文件、已有实现、失败测试、不许改测试）差得远。§4.8 那个小项目更接近日常，但一次跑通也不代表稳定——要判断「会改」而不只是「会写」，需要把 `tests/` 和 `data/` 都设成只读，跑几十次看失败模式。

所以这份 bench 的结论只到这儿：**2-bit 量化在 coding 上没有可测量的质量损失，速度是它的唯一卖点。** 要往下走需要 MBPP 或 LiveCodeBench 的量级，加上多文件任务。

---

## 6. 踩坑清单

1. **`/no_think` 文本前缀无效**：必须用 `chat_template_kwargs:{enable_thinking:false}`，否则思考 token 吃满 `max_tokens`、`content` 为空。
2. **思考模式会截断**：开思考在长图/难题上有约 1/16 概率撞上限输出空；OCR 用「关思考 + 转写过短自动重试」。
3. **多卡不加速 decode**：单个 token 必须串行过完 48 层，多卡只买到更大的专家缓存和 prefill 流水。decode 上限约等于单卡在专家全驻留时的速度。
4. **11 GB 卡两个硬约束**：dense 全量拷贝会吃掉 3.4 GB/卡（必须 `STRATA_STAGE_TRIM=1`）；prompt chunk 上限低，2048 是甜点。
5. **量化阶梯不是线性的**：Q2_0 97.1% 驻留 → IQ2_XS 92.6% → 慢 10–15%；IQ3_S 在 44 GB 上只剩约 65% 驻留，不值得。
6. **2-bit 的边界短板**：HumanEval 里滑动窗口 / off-by-one 那几题（32、132）在 Q2_0 和 IQ2_XS 都失败。边界密集型代码建议 IQ2_XS + 思考，或者换更大缓存的机器。
7. **bench 要跑本地断言**：只比对文本会高估质量；同一份答案跑官方 `check()` 才算过。另外别用客户端测 decode，流式首包和缓冲会让数字虚高 3–4 倍。

---

## 7. 日常快检（约 60 s）

确认「服务还在、还是那个配置、还能用」：

```bash
# 1. 进程与重启计数（NRestarts 应为 0）
systemctl --user is-active strata-flash-next
systemctl --user show strata-flash-next -p NRestarts,ActiveEnterTimestamp --no-pager

# 2. 鉴权（期望 401）
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/v1/models

# 3. 别名（期望 3 条：全名 + 两个别名）
curl -s -H "Authorization: Bearer $K" http://localhost:8080/v1/models | jq -c '.data[].id'

# 4. 引擎自报配置，必须与 profile 一致
curl -s -H "Authorization: Bearer $K" http://localhost:8080/metrics \
 | jq -c '{model:.engine.model, prefill_cap:.engine.prefill_cap, kv:.engine.kv,
          kv_res:.engine.kv_resident, ctx:.engine.context,
          slots:.engine.expert_slots, vram_free:.engine.vram_free_mib}'

# 5. 请求级健康：hit_rate 应 ~0.99+，ram_blobs / file_blobs 应为 0
curl -s -H "Authorization: Bearer $K" http://localhost:8080/metrics \
 | jq -c '.requests[0]|{prompt_tokens,output_tokens,prompt_ms,decode_tok_s,hit_rate,ram_blobs,file_blobs}'
```

注意 `hit_rate / ram_blobs / file_blobs` 是**请求级**字段（在 `requests[]` 里），不在 `engine` 下；服务重启后 `requests[]` 清空，要先发一个请求再查。

