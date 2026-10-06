<div align="center">

<img src="assets/poster.jpg" width="620" alt="dsh-rehearsal 海报：在隔离 DSH_HOME 中用会话副本预演 DeepSeek Harness 升级">

# dsh-rehearsal

DeepSeek Harness（`dsh`）升级预演工具。升级前用现有会话的副本把候选版本完整跑一遍，包括"迁移成功但写不回去"这类只读检查发现不了的故障，输出可核验的升级决策报告。

[简体中文](README.md) | [English](README.en.md)

[![license](https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square)](LICENSE)
[![release](https://img.shields.io/github/v/release/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/releases)
[![npm](https://img.shields.io/npm/v/dsh-rehearsal?style=flat-square)](https://www.npmjs.com/package/dsh-rehearsal)
[![CI](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/stargazers)
[![topic](https://img.shields.io/badge/topic-dsh-4d6bfe?style=flat-square)](https://github.com/topics/dsh)
[![listed](https://img.shields.io/badge/listed%20in-awesome--deepseek--harness-4d6bfe?style=flat-square)](https://github.com/Dominic789654/awesome-deepseek-harness#session--memory-management)
[![tested](https://img.shields.io/badge/tested%20on-DSH%200.2.0--rc.2-4d6bfe?style=flat-square)](#兼容性)

</div>

---

## 这是什么

核心是两条命令（另有 `report` 与 `clean`）：

- **`check`** —— 只读预检。解析 profile、patch 叠层、锁文件与 peer 图，统计会话格式代际。不安装任何东西，不写任何会话。
- **`run`** —— 预演。把候选版本装进私有 npm 前缀，在影子 `DSH_HOME` 里冷启动两次，对会话副本触发 `v0→…→v4` 迁移，校验读侧完整性，再可选执行一次无需 API 键的写回合。

两者要区分开的核心原因：

> **迁移成功，不等于迁移后的会话还能正常写回。**

格式迁移是惰性的、只在会话被打开时发生；只读校验对"能打开但写不进去"的数据会判通过。上游 [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) 就是一份打开正常、每个写回合都失败的会话。读侧静态检查对这类损坏在结构上无法判定（七个同类工具的逐项对照见 [docs/architecture.md](docs/architecture.md#与同类工具的分工)）。无键、以用户自身会话的迁移副本为对象、真的执行一次写回合——截至 2026-10-02 逐项核对，只有本工具同时做到这三件事。写回合用官方 `@deepseek-ai/dsh-llm-replay` 重建该会话自己录制流中的模型响应，因此不需要 API 键，也不会发起真实的模型请求。

## 什么时候需要它

- 升级前想知道插件与 peer 依赖会不会在新版本上坏：`check` 逐条列出依赖冲突，并区分"新破坏"与"既有问题"。
- 官方桌面或社区桌面（如 AnywhereLab 的 DSH Desktop）托管着会话，升级前不想手工搬 home：省略 `--home`，`check` 与 `run` 会自动发现并验证已登记桌面宿主的 home，报告写明来源。
- 会话历史不可替代，升级需要退路：预演全程在影子 `DSH_HOME` 里进行，真实安装与会话原样不动，`clean` 之后不留痕迹。
- 老格式的会话升级后还能不能打开、还能不能写：`run` 对会话副本触发迁移并验证写回，"写不进去"由此有判定，而不是靠猜。
- 升级决策要有可核验的依据：每次预演落盘 `report.json` 与 `report.md`，判定来自产物，报告写盘前脱敏。

## 为什么是独立 CLI，而不是插件

预演要安装候选版本、以私有 `DSH_HOME` 冷启动它。装在 profile 里的工具做不到这两件事：它随宿主一起被替换，也拿不到私有的影子环境。更要紧的是时机：被测试的 profile 起不来时，恰是最需要工具的时刻，工具必须还活着。这一判断出自 [`dsh-plugin-gating-hub`](https://github.com/Noob-stupid/dsh-plugin-gating-hub)（npm 包名 `@noob-stupid/dsh-plugin-console`，`README.zh.md:282`）；本工具把它落成安装形态——独立 CLI，不经过 `dsh plugin add`。

## 安装

```sh
npm install -g dsh-rehearsal                        # npm registry
npm install -g github:wuwaka/dsh-rehearsal#v0.3.15   # 或固定到 GitHub tag
```

两条路径都不需要 npm 账号。需要把安装内容固定到字节时，用 Release 附带的 tarball 与 `.sha256`（校验步骤见 [PUBLISHING.md](https://github.com/wuwaka/dsh-rehearsal/blob/main/PUBLISHING.md)）。

## 快速开始

```sh
dsh-rehearsal check --candidate 0.2.0-rc.2     # 只读，秒级
dsh-rehearsal run --to 0.2.0-rc.2 --sample 20  # 会安装候选版本、会复制会话副本
dsh-rehearsal clean --yes                       # 清理产物
```

常用选项：

| 选项 | 作用 |
|---|---|
| `--profile` / `--home` | 指定 profile 与 `DSH_HOME`；省略 `--home` 时按 `DSH_HOME` → 默认 home → 已登记桌面宿主（官方 DeepSeek Harness Desktop、社区 DSH Desktop/DSHDesktop）的顺序发现并验证 |
| `--sample N` / `--full` | 限制或放开参与预演的会话数 |
| `--skip-write` | 跳过写回合 |
| `--keep` | 保留影子数据用于调试（内含会话明文副本） |
| `--shadow-dir <dir>` / `--prefix-dir <dir>` | 指定影子 home / 候选安装目录；两处目录**不会自动清理**（影子 home 内含会话明文副本），非空且无本工具 ownership 标记的目录会被拒绝写入，`clean --yes` 只清理带标记的默认产物目录 |
| `--allow-tools` | 显式允许执行历史工具调用 |

其余选项以 `dsh-rehearsal --help` 为准。

## 输出长什么样

`check` 的实际输出（`profiles` 与代际分布做了省略，本机 profile 名不在其中）：

```text
dsh-rehearsal check — verdict: upgrade-with-conditions
  [PASS        ] a-inventory — home=default; profiles=[…]; live=desktop (bundles=11,
                 patchRows=16, plugins=10, 3 non-reproducible); sessions=52 (…)
  [WARN        ] b1-peer-graph — 10 plugins analyzed against candidate=0.2.0-rc.2
                 current=0.2.0-rc.2; 19 findings (0 newly-broken high, 9 pre-existing)
rollback note: sessions migrated to v4 are REFUSED (not rewritten) by older hosts —
downgrade after migration is not possible; rollback relies on a pre-upgrade snapshot
```

`home=default` 而不是路径：报告里的 DSH_HOME 字段只写形状或来源（`default` / `custom` / `desktop:<host-id>`），绝对路径不进入字符串。

退出码：

| 退出码 | 含义 |
|---:|---|
| `0` | 检查通过，可升级 |
| `1` | 有条件升级，或结果不完整 |
| `2` | 不建议升级 |
| `3` | 预演本身失败 |

阶段判定来自产物，不来自候选 `dsh` 自身进程的退出码。

## 报告

每次预演输出两份文件：`report.json`（机器可读）与 `report.md`（人读摘要）。`report.json` 是覆盖率、阶段判定、`warnings[]` 与 evidence 的事实来源。

## 覆盖范围

迁移覆盖与写回合覆盖是两件事，不要互换引用。写回合只覆盖"录制中出现过的工具全部为只读"的会话。

一次 Windows 运行的实测（2026-10-02）：

| | 会话数 | 占比 |
|---|---:|---:|
| 总数 | 52 | — |
| 可预演（未迁移至 v4 且 cwd 可用） | 24 | 46% |
| 通过只读工具闸门 | 5 | 全库 9.6% |

写回合占比不是迁移覆盖率。逐会话的覆盖情况由报告本身给出（`coverage` 节）。

## 安全摘要

- 候选版本装入私有 npm 前缀，`DSH_HOME` 指向影子目录。
- 会话副本的 `cwd` 重写入影子工作区。
- 真实 home 与桌面宿主安装目录只读；发现与探测只做文件解析。
- 形如凭据的环境变量全部剔除，保留变量的 URL 值再剥掉内嵌的 userinfo 凭据；遥测强制关闭。
- 历史工具调用默认不执行（fail-closed 只读允许清单）。
- 报告写盘前脱敏，脱敏未过则拒绝出报告；影子数据除 `--keep` 与显式 `--shadow-dir` 外一律清理，`clean` 只删除带 ownership 标记的产物目录。

准确的保证、显式危险的选项、以及范围之外，见 [SECURITY.md](SECURITY.md)。

## 兼容性

| 项目 | 状态 |
|---|---|
| Node.js | `>=22.19`（需 `node:zlib` 的 zstd） |
| `run` | Tested：Windows 真机会话 |
| `check` | Tested：Windows；CI：macOS / Linux / Windows |
| Desktop 托管 profile（会话迁移演练） | Tested：社区桌面托管数据，Windows（2026-10-02） |
| Desktop home 自动发现 | Windows：官方默认安装与社区 bundle 实测；macOS / Linux：Inferred（按上游布局），未在真机验证 |
| 桌面内置运行时探测 | 官方 Windows 默认安装实测（asar 描述文件）；自定义安装目录与 Linux AppImage：Not covered |
| 桌面内置运行时作为预演对象 | Not tested（预演对象是 npm 候选，报告带范围警告） |
| 候选来源 | npm / 自托管的 `web`、`headless` profile |
| 运行时依赖 | `semver` |

Tested 版本：候选 `dsh` `0.2.0-rc.2`、Node `22.22.2`、Windows、会话代际 `v0`/`v3`/`v4`（Tested on 2026-10-02）；桌面探测：Windows 官方 0.2.0-rc.2 静默安装，2026-10-05。Tested ≠ supported：未列出的组合按未测试处理。

## 限制

- `run` 预演的是自装 npm 候选，不是桌面应用内置运行时：对桌面托管的 home，判定覆盖 npm 依赖闭包与会话数据格式，桌面应用自身的更新通道不在预演范围内（警告与报告中的 `coverage.host` 字段写明这一范围）。
- 桌面探测只覆盖默认安装位置：官方与社区桌面的安装器都允许自选目录，自定义安装的宿主探测不到内置运行时版本，用 `--current` 手工指定。
- macOS 的官方/社区桌面路径按上游布局推断，未在真机验证；Linux 官方桌面是 AppImage，外部不可读，明确不支持。
- 经 anywhere-labs Recovery 自选数据目录、或 `DSH_DATA_ROOT` / 便携版 `DSH_HOME` 重定向过的桌面 home 不在自动发现范围内，用 `--home` 指定。
- 同机多个桌面宿主的内置运行时版本不一致时 `current` 判为未知（报告列 `currentAmbiguous`），用 `--current` 指定，或卸载闲置宿主；判定方向刻意保守。
- 写回合覆盖窄于迁移覆盖，见[覆盖范围](#覆盖范围)。
- 带 `agentPreset` 的会话只做格式级验证，预设组合不重建。
- 附件旁路数据（`~/.dsh/attachments` 等）不复制、不校验。
- 预演证明写路径可通行，不证明自由行为：replay 脚本只包含该会话录制里出现过的调用。

## 深入

- [docs/architecture.md](docs/architecture.md) —— 为什么是外部 CLI、模块划分、与同类工具的分工
- [docs/FAILURE_MODES.md](docs/FAILURE_MODES.md) —— 每条日志形态能证明什么、不能证明什么
- [SECURITY.md](SECURITY.md) · [AUDIT.md](https://github.com/wuwaka/dsh-rehearsal/blob/main/AUDIT.md) · [CHANGELOG.zh.md](CHANGELOG.zh.md) · [PUBLISHING.md](https://github.com/wuwaka/dsh-rehearsal/blob/main/PUBLISHING.md)

## 开发

```sh
npm install && npm test
node src/cli.js check --candidate 0.2.0-rc.2
```

CI 跑 `npm ci` + `npm test`，矩阵 windows / macOS / linux × Node 22.19 / 24.x。CI 不跑 `run`：它会安装约 500 个包并重放会话副本，在共享 runner 上既不确定也不合适。发布流程见 [PUBLISHING.md](https://github.com/wuwaka/dsh-rehearsal/blob/main/PUBLISHING.md)。

MIT License。与 DeepSeek 无关联、未获其背书。上游 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（官方桌面在其 `apps/desktop`）；社区桌面宿主与活跃缺陷跟踪 [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop)。
