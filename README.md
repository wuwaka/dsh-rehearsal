<div align="center">

<img src="assets/poster.jpg" width="620" alt="dsh-rehearsal 海报：在隔离 DSH_HOME 中用会话副本预演 DeepSeek Harness 升级">

# dsh-rehearsal

DeepSeek Harness（`dsh`）升级预演工具。不改动当前安装，用现有会话的副本对候选版本跑一遍，输出升级决策报告。

[简体中文](README.md) | [English](README.en.md)

[![license](https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square)](LICENSE)
[![release](https://img.shields.io/github/v/release/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/releases)
[![CI](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/stargazers)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe?style=flat-square)](https://github.com/topics/dsh-plugin)
[![tested](https://img.shields.io/badge/tested%20on-DSH%200.2.0--rc.2-4d6bfe?style=flat-square)](#兼容性)

</div>

---

## 这是什么

两条命令：

- **`check`** —— 只读预检。解析 profile、patch 叠层、锁文件与 peer 图，统计会话格式代际。不安装任何东西，不写任何会话。
- **`run`** —— 预演。把候选版本装进私有 npm 前缀，在影子 `DSH_HOME` 里冷启动两次，对会话副本触发 `v0→…→v4` 迁移，校验读侧完整性，再可选执行一次无需 API 键的写回合。

两者要区分开的核心原因：

> **迁移成功，不等于迁移后的会话还能正常写回。**

格式迁移是惰性的、只在会话被打开时发生；只读校验对"能打开但写不进去"的数据会判通过。上游 [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) 就是一份打开正常、每个写回合都失败的会话。写回合用官方 `@deepseek-ai/dsh-llm-replay` 重建该会话自己录制流中的模型响应，因此不需要 API 键，也不会发起真实的模型请求。

## 安装

```sh
npm install -g github:wuwaka/dsh-rehearsal#v0.2.0
```

按 tag 安装，不需要 npm 账号。需要把安装内容固定到字节时，用 Release 附带的 tarball 与 `.sha256`（见 [PUBLISHING.md](PUBLISHING.md)）。

独立 CLI，刻意不作为 `dsh plugin add` 的 bundle 分发：被测试的 profile 起不来时，它还得能用。

## 快速开始

```sh
dsh-rehearsal check --candidate 0.2.0-rc.2     # 只读，秒级
dsh-rehearsal run --to 0.2.0-rc.2 --sample 20  # 会安装候选版本、会复制会话副本
dsh-rehearsal clean --yes                       # 清理产物
```

常用选项：

| 选项 | 作用 |
|---|---|
| `--profile` / `--home` | 指定 profile 与 `DSH_HOME` |
| `--sample N` / `--full` | 限制或放开参与预演的会话数 |
| `--skip-write` | 跳过写回合 |
| `--keep` | 保留影子数据用于调试（内含会话明文副本） |
| `--allow-tools` | 显式允许执行历史工具调用 |

其余选项以 `dsh-rehearsal --help` 为准。

## 输出长什么样

`check` 的实际输出（已隐去本机 profile 名）：

```text
dsh-rehearsal check — verdict: upgrade-with-conditions
  [PASS        ] a-inventory — profiles=[…]; live=desktop (bundles=11, patchRows=16,
                 plugins=10, 3 non-reproducible); sessions=52 (v0=…, v3=…, v4=…)
  [WARN        ] b1-peer-graph — 10 plugins analyzed against candidate=0.2.0-rc.2
                 current=0.2.0-rc.2; 19 findings (0 newly-broken high, 9 pre-existing)
rollback note: sessions migrated to v4 are REFUSED (not rewritten) by older hosts —
downgrade after migration is not possible; rollback relies on a pre-upgrade snapshot
```

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

一次 Windows 运行的实测：

| | 会话数 | 占比 |
|---|---:|---:|
| 总数 | 52 | — |
| 可预演（未迁移至 v4 且 cwd 可用） | 24 | 46% |
| 通过只读工具闸门 | 5 | 全库 9.6% |

写回合占比不是迁移覆盖率。逐会话的覆盖情况由报告本身给出（`coverage` 节）。

## 安全摘要

- 候选版本装入私有 npm 前缀，`DSH_HOME` 指向影子目录。
- 会话副本的 `cwd` 重写入影子工作区。
- 形如凭据的环境变量全部剔除，遥测强制关闭。
- 历史工具调用默认不执行（fail-closed 只读允许清单）。
- 报告写盘前脱敏；影子数据除 `--keep` 外一律清理。

准确的保证、显式危险的选项、以及范围之外，见 [SECURITY.md](SECURITY.md)。

## 兼容性

| 项目 | 状态 |
|---|---|
| Node.js | `>=22.19`（需 `node:zlib` 的 zstd） |
| `run` | Tested：Windows 真机会话 |
| `check` | Tested：Windows；CI：macOS / Linux / Windows |
| Desktop 托管 profile | `check` 支持；`run` 不支持（设计决定） |
| 候选来源 | npm / 自托管的 `web`、`headless` profile |
| 运行时依赖 | `semver` |

Tested 版本：候选 `dsh` `0.2.0-rc.2`、Node `22.22.2`、Windows、会话代际 `v0`/`v3`/`v4`（Tested on 2026-10-02）。Tested ≠ supported：未列出的组合按未测试处理。

## 限制

- `run` 无法预演 Electron 托管的 `desktop` profile：npm 候选与 Desktop 内置体是两套依赖闭包，且 `dsh` 直接拒绝。
- 写回合覆盖窄于迁移覆盖，见[覆盖范围](#覆盖范围)。
- 带 `agentPreset` 的会话只做格式级验证，预设组合不重建。
- 附件旁路数据（`~/.dsh/attachments` 等）不复制、不校验。
- 预演证明写路径可通行，不证明自由行为：replay 脚本只包含该会话录制里出现过的调用。

## 深入

- [docs/architecture.md](docs/architecture.md) —— 为什么是外部 CLI、模块划分、与同类工具的分工
- [docs/FAILURE_MODES.md](docs/FAILURE_MODES.md) —— 每条日志形态能证明什么、不能证明什么
- [SECURITY.md](SECURITY.md) · [AUDIT.md](AUDIT.md) · [CHANGELOG.zh.md](CHANGELOG.zh.md) · [PUBLISHING.md](PUBLISHING.md)

## 开发

```sh
npm install && npm test     # 68 个测试
node src/cli.js check --candidate 0.2.0-rc.2
```

CI 跑 `npm ci` + `npm test`，矩阵 windows / macOS / linux × Node 22.19 / 24.x。CI 不跑 `run`：它会安装约 500 个包并重放会话副本，在共享 runner 上既不确定也不合适。发布流程见 [PUBLISHING.md](PUBLISHING.md)。

MIT License。与 DeepSeek 无关联、未获其背书。上游 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)；桌面宿主与活跃缺陷跟踪 [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop)。
