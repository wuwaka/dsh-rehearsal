<div align="center">

# 🎬 dsh-rehearsal

**要不要升 DeepSeek Harness？先彩排一遍** —— 用候选 `dsh` 版本 + 你自己的插件集 + **你真实会话的副本**，无 API 键，在全新的 `DSH_HOME` 里跑一次，产出升级决策报告。

[简体中文](README.md) | [English](README.en.md)

[![license](https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square)](LICENSE)
[![release](https://img.shields.io/github/v/release/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/releases)
[![CI](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/stargazers)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe?style=flat-square)](https://github.com/topics/dsh-plugin)
[![tested](https://img.shields.io/badge/tested%20on-DSH%200.2.0--rc.2-4d6bfe?style=flat-square)](#兼容性)

*独立命令行工具，不是 `dsh plugin add` 的 bundle —— 也不是又一个"单插件冒烟器"。*

</div>

---

## 这是什么

两条命令，一个结论：

| 命令 | 作用 |
| --- | --- |
| `check --candidate <版本>` | **静态升级体检**：只读、零下载、秒级。活 profile 识别、四层 patch 叠层、精确版本、peer 图（区分"本次升级引入"与"今天就已坏"）、会话代际分布 |
| `run --to <版本>` | **真彩排**：私有前缀装候选 → 两次冷启动 → 对你真实会话的副本触发惰性迁移 `v0→…→v4` → 读侧完整性 → **无键写回合**（官方 `dsh-llm-replay`） |

产出 `dsh-rehearsal/v1` 报告（`report.json` + `report.md`），退出码可直接接进脚本：`0` 可升 · `1` 带条件可升 · `2` 不可升 · `3` 彩排自身失败。

装法（按 tag 装，**无需 npm 账号**；该形式在 0.1.0 上实测通过，把 tag 换成你要装的版本即可）：

```sh
npm install -g github:wuwaka/dsh-rehearsal#v0.2.0
dsh-rehearsal check --candidate 0.2.0-rc.2
```

想要可复核到字节的安装，用 Release 里附带的 tarball 与它的 `.sha256`：

```sh
curl -sSLO https://github.com/wuwaka/dsh-rehearsal/releases/download/v0.2.0/dsh-rehearsal-0.2.0.tgz
curl -sSL -O https://github.com/wuwaka/dsh-rehearsal/releases/download/v0.2.0/dsh-rehearsal-0.2.0.tgz.sha256
sha256sum -c dsh-rehearsal-0.2.0.tgz.sha256
npm install -g ./dsh-rehearsal-0.2.0.tgz
```

## 为什么是外部 CLI，而不是插件

"一个装在待测 profile 里的彩排工具，会恰好在最需要它的时候一起死掉" —— 这句话**不是我们说的**，是 [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) 自己写在 README 里的：`README.zh.md:282`「**起不来的控制台什么都门控不了** —— 所以这条救火链路永远生效」。同一个动机还有两条独立实现：`@xiaoyuyu6420/dsh-backup` 附带零依赖的 `dsh-rescue`（package.json `bin`，"宿主起不来也能用的救援通道"），`zzy6-a/dsh-upgrade-guard` 用宿主外 supervisor 回滚宿主版本。

**所以"外部"是入场券，不是卖点。** 这个生态里已经有好几个从宿主外面跑的 CLI（`dsh-plugin-reducer` 每次探测新建影子 `DSH_HOME`、`@mars.liu/dsh-canary` 直接驱动你的 dsh）。`dsh-rehearsal` 占的位置是这四件事**同时**成立 —— 2026-10-02 逐个读源码核对：

| 条件 | 别人的现状 |
|---|---|
| 装**候选核心版本**，且装进自己的私有前缀 | `dsh-canary` 的 L1 能钉 dsh 版本，但复用你 profile 现有的 `node_modules`；`@linxin666/dsh-doctor` 救援舱用隔离 `DSH_HOME` 跑候选门再原子 promote，但它钉的是**当前**版本（为了恢复，不是为了预演） |
| 开的是**你的历史会话** | 只有 `dsh-backup` 读你的会话日志，而它 `lib/index.js:512` 自己声明"只读扫描，不写任何文件" |
| 迁移发生在**已经启动的**影子宿主里 | 读会话的没有启动宿主，启动宿主的没有读会话 |
| 写回合**不需要 API 键** | `dsh-test-drive` 的 `capability` 阶段确实真的跑一个 headless 任务，并核对持久会话日志记下了这次调用 —— 但那一步需要 `DEEPSEEK_API_KEY`，无键时判 `skipped`（它的 README 明说 "skipped, never failed"） |

最后一行是可以自查的：`gh search code "@deepseek-ai/dsh-llm-replay"` 在 2026-10-02 只命中官方仓 `deepseek-ai/deepseek-harness` 本身、其 fork 与 vendored 文档，**没有任何第三方工具消费这个包**。本工具的写回合就建在它上面。

具体执行形态：候选 `dsh` 是它**自己 npm 装进私有前缀的子进程**，`DSH_HOME` 指向私有目录 ——

- 碰不到你的活 profile；
- 已装的 harness 起不来时它照样能跑；
- 每条结论都对应磁盘上一个产物（`report.json`），而不是靠人眼读日志。

> **与官方门禁的分工。** `dsh-plugin-manager` 在**安装与启动时**按声明的 peer 范围拦截，并提供精确版本豁免（`dsh plugin allow-version … --accept-risk`）。那是运行期护栏。本工具回答更早的问题 —— **升到 X 会发生什么**，包括只有被写入时才暴露的会话数据 —— 而且是在你提交升级**之前**。互补，不重复。

## 兼容性

**声明范围 ≠ 实测版本** —— 下表把两者分列，因为对一个"要不要升"的决策工具来说，测试环境的时效本身就是风险。

| 组件 | 实测 | 声明 / 未验证 |
|---|---|---|
| 候选 `dsh` | **`0.2.0-rc.2`**，`--sample 9 --preset-mode patch`：9/9 个真实会话完成 `v0→v4` 迁移，1 次无键写回合 `pass`（**2026-10-02**，单机） | 更早的 rc / 稳定版未彩排过；`check` 是纯文件解析，不装任何东西 |
| 当前运行时探测 | 依次探 profile 的 `node_modules` → 共享 `profiles/node_modules` → **DSH Desktop** 内置体（`…/resources/app/node_modules/@deepseek-ai/dsh`）→ npm 前缀 | Desktop 内置体的 `run` 彩排不支持（见下方设计决定） |
| 会话格式代际 | `v0`（`session.jsonl.zstd`）、`v3`、`v4`；迁移链 `v0→…→v4` 已对**真实日志**跑通 | `v1`/`v2` 只有代际识别，没有真机样本 |
| Node.js | 本机 **22.22.2**（RStudio 内嵌）；CI **22.19 与 24.x** 六组合全绿（`24.x` 那条腿**只有 CI 验过**） | `engines.node: >=22.19` —— 需要 `node:zlib` 的 zstd（v22.15.0 引入，仍标 *Stability: 1 – Experimental*） |
| 平台 | Windows 真机端到端；macOS / Linux 只有 CI（只跑 `npm test`，不跑 `run`） | `run` 在非 Windows 未做过真机会话彩排 |
| 包管理器 | `npm` —— 不靠 `PATH` 语义定位，只用来把候选装进私有前缀 | 不装你的 profile，也不碰 pnpm |
| 运行时依赖 | **只有 1 个**：`semver` | — |
| 凭据 | **任何阶段都不需要** —— 见[构造即安全](#构造即安全) | — |

**不支持（且是设计决定）：** 通过 npm CLI 彩排 Electron 拥有的 `desktop` profile。`dsh` 直接硬拒（`profile "desktop" is managed exclusively by the Electron application`），而且 npm 装的候选与 Desktop 内置体是**两套不同的依赖闭包**。`check` 仍可覆盖 `desktop` profile —— 它只解析文件。`run` 面向 npm / 自托管的 `web`、`headless` profile。

## 你得到什么

### `check` —— 静态升级体检（只读、零下载、秒级）

- 自动挑出**活 profile**，绝不默认 `web`（实测一台机器上 `desktop` = 11 bundles / 198 行 patch，`web` 只有 4 / 4）；
- 解析 patch 叠层（`dsh.profile.bundles` 顺序 → profile 的 `cordis.patch.yml` → home 级 `cordis.patch.yml` → `--patch`）、从 `pnpm-lock.yaml` 取精确版本、以及会改变安装语义的 `pnpm-workspace.yaml` 策略（`autoInstallPeers`、`allowBuilds`、`minimumReleaseAgeExclude`）；
- **peer 图分析**：插件↔dsh、插件↔插件、`@deepseek-ai/cordis` 多 pin 冲突、**枚举式** peer 范围（prerelease caret 的坑：`^0.1.7-rc.2` 不匹配 `0.2.0-rc.2`，于是作者只能手写每一个 rc）、以及 `link:` / `file:` / `github:` 不可复现依赖；
- 每条发现区分**本次升级引入**与**今天就已存在** —— 今天就已经错配的不是这次升级的锅，不阻断。

### `run --to <版本>` —— 彩排本体

```
私有前缀安装候选（默认禁构建脚本）
  → 两次冷启动（首启抖动是真实存在的上游问题：#1294）
  → 对你真实会话的副本触发惰性迁移（v0 → … → v4）
  → 读侧完整性（完整多帧解码、seq 连续、turn 双向闭合）
  → 用官方 @deepseek-ai/dsh-llm-replay 做无键写回合
```

最后一步是这个工具的立身之本。迁移是**惰性的、只在打开时发生**，而读侧检查会在"打得开但写不进去"的数据上判通过 —— 上游 [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) 就是一份"打开正常、每个回合必炸"的会话。所以彩排会在迁移后的副本上**真的写一轮**，且不需要 API 键：`dsh-llm-replay` 用该会话自己的录制流重建模型响应。

### `dsh-rehearsal/v1` 报告

每阶段 `report.json` + `report.md`（`verdict` / `durationMs` / `details` / `evidence`），阶段记录形状对齐 `dsh-test-drive/v1`，另有固定的 `coverage` 节、顶层 `warnings[]`，以及说明剥离了什么的 `privacy` 块。退出码可机器判定：**`0` 可升 · `1` 带条件可升 · `2` 不可升 · `3` 彩排自身失败**。

## 构造即安全

三层互相独立 —— 因为"我们抑制了工具"这件事，深究后发现不止一层那么浅：

1. **沙箱 cwd。** `copySet` 把每个副本会话 header 的 `cwd` 重写到 `<shadow>/workspace/<n>`，**同时**把副本搬到编码后对应的工作区别名目录 —— 宿主是从 `header.cwd` 反推会话物理路径的，两者必须一起改。任何进程都不会以你的真实工作区为根。
2. **默认禁用工具行。** replay patch 同时按**行 id 与包名**抑制工具提供方（`dsh-tool-`、`dsh-mcp-`、`dsh-skill`、`dsh-browser`、`dsh-terminal`、`dsh-jobs`、`terminal-`）；`tools` 注册表行保留（agent loop 依赖它）。被重放的调用只会拿到 `isError`，而不是真的执行。
3. **只读允许清单（fail-closed）。** replay 只能发出该会话**自己历史里出现过的工具** —— 这是确定性的，所以预筛是完整知识而非猜测。只有当历史工具**全部**属于已知只读内置集合时才演练：`mcp__*` 前缀、执行/写入类、未知的第三方工具、无名行一律拦下，并逐条记下原因。提取覆盖**四种行形态**（`tool/call`、`tool-call-chunks`、`tool/ptc-dispatch`、`tool/code-dispatch[·start]`）—— 只扫 `tool/call` 会静默漏掉整批工具。

此外是不可协商项：

- **无键。** 子进程环境里凡是形状像凭据的变量（`API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PRIVATE_KEY|AUTH`）全部剔除；报告只记被剔除的**变量名**，永不记值。不花 token，不把内容发给任何 provider。
- **遥测关闭**：`DSH_TELEMETRY_MODE=DISABLED`（候选 `0.2.0` 默认 `FEEDBACK_ONLY`，且其 OTLP 直连绕过代理）。
- **判定只认产物，绝不认退出码。** *成功*的无键迁移会以 `MISSING_CREDENTIAL` 退出 1；`--dump-config-schema` 设计上成功也退出 1（采集不完整时置 `exitCode`），同时把合法 JSON 写到 stdout。
- **只用自己装的候选二进制。** `PATH` 上的 `dsh` 可能是无视 `DSH_HOME` 的桌面 shim，会写坏你的真实 home —— 开发期真发生过，所以现在从结构上不可能。
- **报告零消息正文。** `stderr` 只保留诊断行（replay 会把推理正文写到 stderr；凡不匹配诊断形状的行一律丢弃并计数）；evidence 对象**逐字符串**脱敏（任意盘符绝对路径 —— 含空格的也算 —— → `<abs-path>`，家目录 → `~`，凭据形状 → `[redacted]`）。正文只会出现会话 id、类型直方图、seq 区间、字节数。
- **任何退出路径都清理。** 影子 home 里有整份会话副本和**明文**解压 fixture，所以在 `finally` 里删除，并在报告记 `shadowCleanup: removed|kept|failed`。

## 覆盖率请连数字一起读，别只读 PASS

写回合故意很窄：它要求一个会话**全部**录制过的工具都是只读的。在本机实测（2026-10-02）：

| 阶段 | 数量 | 占比 |
|---|---|---|
| 会话总数 | 52 | — |
| 可演练（未 v4 且 cwd 可用） | 24 | 46% |
| 通过只读允许清单 | **5** | 可演练的 21%，**全库的 9.6%** |

也就是说**迁移彩排覆盖广、写路径彩排覆盖窄**，两者不能混着引用。`coverage.writeRounds` 给出 `plainAttempts/plainPass/presetAttempts/presetPass/skippedWriteTools` 并逐个列出被拦会话及其工具；`coverage.sessions.preset` 暴露 `inLibrary/drillable/selected/migrated` —— 于是"我们演练过预设会话"这句话可以由报告自证，而不是靠文档口述。

带预设的会话值得单说：one-shot runner 会拒绝它们，`--preset-mode patch` 在**我们私有的候选副本**里中和那一个采用检查，且**不重建预设组合** —— 这类结论只有格式级，报告也这么标。采样保证它们一定被代表（非预设层先填满，预设层拿剩余并保底 1 个），但它们的写回合照跑照报，却不单独决定阶段结论：replay 不拦截预设会话的 provider 路由，所以只选到预设时诚实地判 `inconclusive`。

## 与已有同类工具的差别

这个生态并不空，装作空是在浪费你的时间。下表每一格都在 2026-10-02 读过对方源码或原文，并给出可自查的出处 —— 把别人的工具写错，比把自己的工具写小更糟。

| 工具 | 它做到哪一步（已核对） | 本工具补什么 |
|---|---|---|
| [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) | 升级前契约预检 → 配置备份 + 全树回滚点 → **一键执行框架升级**、失败自动回滚；「启动失败隔离」= 从启动日志**点名**定位肇事插件后禁用（预设改名 `.broken-*`），找不到明确肇事者才进安全模式；环境指纹连"别的通道改了框架"也守 | 它跑在 profile 内，且预检是**契约集合差分**（`lib/server/domain/format-contract.js:4-7`）。它的 `CHANGELOG.md:875` 自己列了未验证项：「**没有**跑一次带预设的会话（那需要新建会话 + **真实模型调用**）」—— 本工具做的正是去掉"真实模型调用"这一条 |
| [`@linxin666/dsh-doctor` 救援舱](https://github.com/zhu1090093659/dsh-web) | 固定 DSH 运行时 + 隔离 `DSH_HOME`，对候选跑隔离 `dump-config` 与 Web 健康门，通过才 promote，失败按字节回滚 —— 形态上最接近"影子宿主 + 候选门 + 原子提升" | 门的是装载器/配置面。其发布 tarball 的 node 侧代码 grep 不到任何 `session` / `sessions/` 引用；"pinned" 钉的是**当前**版本（为了恢复），不是候选 |
| [`dsh-test-drive`](https://github.com/PerryLink/dsh-test-drive) | 装 → patch 生效 → 冷启动 → 卸 → 清理，全程 `mkdtemp` 影子 `DSH_HOME` + 独立 pnpm store；`schema: "dsh-test-drive/v1"`；`action.yml` 出 Markdown(PR comment) + JUnit XML。可选 `capability` 阶段真的驱动一个 headless 任务并核对**持久会话日志记下了这次调用** | 那一步需要 `DEEPSEEK_API_KEY`，无键时 `skipped`（README 原文 "skipped, never failed"），且开的是**新建**会话。本工具的写回合无键，对象是**你的 v0→v4 历史副本** |
| [`@mars.liu/dsh-canary`](https://github.com/MarchLiu/dsh-canary) | 独立 npm CLI，真的 boot 一个「你 profile 的 bundle 集 + 候选插件」的一次性组合（`profiles/canary-<rand>`，绝对符号链接复用 `node_modules`），L1 可钉 dsh 版本 | 换的是**插件**；会话数据不在射程内。没有 GitHub Action，也没有 `v1` schema 判别字段 |
| [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup) | `/backup migrate-check` **只读**静态扫全部代会话日志（`lib/index.js:512` "不写任何文件"），按代际冻结清单预测哪些会话打不开、挂在哪条规则；另有零依赖 `dsh-rescue` 进程外救援 | 见下面的引用 —— 难点不是"它没想到"，是**读侧结构上判不出来** |
| [`dsh-plugin-doctor`](https://github.com/PerryLink/dsh-plugin-doctor) | 包结构 R/K 门禁 + cordis 契约扫描 + 无键无头冒烟（`MISSING_CREDENTIAL` 判为通过）；`coverage.<K>{filesInspected,mode}` + `degraded[]` + exit `6`，规范写着「a `skip` is never rendered as `PASS`」 | 近亲而非竞品：本工具的 `coverage` + `warnings[]` 是同一族纪律，差别只在把结论聚合到"能不能升" |
| [`dsh-plugin-reducer`](https://github.com/ArmyWas/dsh-plugin-reducer) | 外部 CLI，每次探测新建影子 `DSH_HOME` 并把 profile 链到现有 `node_modules`（**不安装任何东西**），把故障 profile 归约到最小可复现插件集；另有 weekly `upstream-canary.yml` 探 `dsh-app-boot@next` 的布局漂移 | 它是**事后**归约（已有故障 → 最小复现集），本工具在升级**之前**；它的 canary 探的是上游布局漂移，不是你的会话 |

**"读侧判不出来"这件事，由对手自己的代码注释作证。** `dsh-backup` 一度把 `source.kind` 不在白名单直接判成"打不开"，线上结果是：

> `kind 只作提示，不作判据（#113）：宿主把它设计成可合并扩展的联合类型……旧实现把"不在白名单"直接判成"打不开"，在一台真实机器上把 **81/82 份完全健康的日志**报成不可打开`
> —— `xiaoyuyu6420/dsh-backup` `lib/index.js:2617-2622`

同一类损坏，`gating-hub` 的应对是**改写生产方源码**（契约规则 `session-message-source-kind`：把仍在写 V3 `{kind:'plugin'}` 包装的插件改成 producer-owned kind）。也就是说：静态扫描判不准（会误伤 81/82），契约差分修的是代码不是数据 —— 而上游 [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) 那份会话是"**打开正常、每个回合必炸**"。只有真的写一轮才判得出来，而"写一轮"过去必须有 API 键。这就是本工具存在的全部理由。

本工具识别的每一条日志形态、它命中/不命中各能推出什么、以及**本机复现不了的那几条为什么仍然保留**，逐条列在 [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md)。

## 快速开始

```sh
# 安装（按 tag，无需 npm 注册）
npm install -g github:wuwaka/dsh-rehearsal#v0.2.0

dsh-rehearsal --version                               # 确认可执行文件真的装上了
dsh-rehearsal check --candidate 0.2.0-rc.2            # 只读体检，秒级
dsh-rehearsal run --to 0.2.0-rc.2 --sample 20         # 完整彩排（会装候选、会复制你的会话；首次约 2-5 分钟）
dsh-rehearsal clean --yes                             # 清理 .dsh-rehearsal 产物
```

从源码跑（开发／改代码）：

```sh
git clone https://github.com/wuwaka/dsh-rehearsal.git && cd dsh-rehearsal
npm install && npm test
node src/cli.js check --candidate 0.2.0-rc.2
```

常用旗标：`--profile`、`--home`、`--current`（覆盖自动探测）、`--full`、`--preset-mode patch`、`--writeRounds N`、`--skip-write`、`--allow-tools`、`--run-scripts`、`--keep`、`--shadow-dir` / `--prefix-dir`。

### 让 AI 替你跑

把这段话贴给能操作终端的 AI / agent：

> 在本机做一次只读的 DeepSeek Harness 升级预检。clone 或更新 `https://github.com/wuwaka/dsh-rehearsal`，跑 `npm install`，然后 `node src/cli.js check --candidate <目标版本>`，汇报结论、每一条 `high` 发现对应的插件与 peer 范围、以及会话代际分布。未经我明确同意**不要**跑 `run`（它会安装候选并重放我会话的副本）；不要改任何 profile 或 `~/.dsh` 文件；不要打印任何凭据。

## 已知边界（v1）

- `--allow-tools` **会真的执行**记录里的工具调用。cwd 仍在沙箱里，但 `pwsh`/`bash` 可以用绝对路径走出去。只对你接受其历史副作用的会话开启。
- 附件旁路数据不复制、不校验（`~/.dsh/attachments`、`cache/attachments`），附件引用完整性明确划在范围外而不是假装测过。
- npm 影子 ≠ Desktop 安装体：`run` 复现不了 Electron 的依赖闭包（见[兼容性](#兼容性)）。
- 彩排测的是*写路径可走通*，不是自由行为：replay 脚本派生自该会话自己的录制，录制里没有的工具和路径不会出现。
- #1229 类毒行检测已内置，但在本机数据上无法触发（`v3→v4` 迁移包自 `0.2.0-rc.1` 起就带 `producerKind` 改写映射）。每条签名的原文日志、命中处、以及**本机能不能复现**都列在 [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md) 里，不复现的会明写不复现。
- `run` 目前仍用一个 `--sample` 同时决定迁移样本和写回合候选池；想要更宽的写覆盖就调大它。
- **本工具不在、也不该在 `awesome-dsh-plugin` 插件目录里**：该目录的 `scripts/check-submission.mjs:258-264` 硬性要求某个 `package.json` 声明 `dsh.bundle`，只声明 `dsh.client` 都不收（`dsh-plugin-reducer`、`dsh-canary` 同样不在目录里，实测 4412 条 0 命中）。它收录的是"能 `dsh plugin add`"的东西，而本工具刻意不是。要索引它，位置在工具类目录 —— `walkinglabs/awesome-deepseek-harness-plugins` 的 `docs/INCLUSION_POLICY.md` 第 4 条（"client、launcher 或开发资源，放在插件类别之外并标注"）与 `awesome-deepseekharness/awesome-deepseek-harness` 的 `CONTRIBUTING.md` 🧩 Tools 类别。

## 怎么自证"没有污染真实 home"

三条互相独立的检查，这个项目的审计轨迹就是这么建的：

```sh
# 1) 真实库里所有迁移产物的 mtime 必须早于彩排时刻
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort | tail -3
# 2) 不留影子目录（除非 --keep / --shadow-dir，否则自动清理）
ls -d "${TMPDIR:-/tmp}"/dsh-rehearsal-home-* 2>/dev/null | wc -l
# 3) 报告里没有家目录、没有正文（把 <TOKENS> 换成你自己的用户名与盘符关键词）
node -e "const fs=require('fs');const d=fs.readdirSync('.dsh-rehearsal').sort().pop();\
const t=fs.readFileSync('.dsh-rehearsal/'+d+'/report.json','utf8');\
console.log(['<TOKENS>','reasoning:'].filter(k=>t.includes(k)).length?'LEAK':'CLEAN')"
```

## 开发

```sh
npm test        # 57 个测试：多帧 zstd 回归（裸 zlib 把 1698 行读成 1 行）/ peer 分级 /
                # 沙箱 cwd 重写 + 目录编码 / stderr 消毒器 / 结构化脱敏 / 只读允许清单 /
                # env 剔除 / countRows 结构 / 分层采样 / writeRoundVerdict /
                # warnings 渲染与脱敏 / 签名回归锁 / check 端到端 CLI 冒烟
```

签名回归锁的形状是**成对**的：每条日志形态必须命中从 issue 正文或真机产物抄来的原文，且必须**不**命中健康行；另有一条断言要求"代码里检测的每个 id 都出现在 [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md) 里"，否则文档会静默腐烂成一个没人复核过的兼容性声明。

CI 跑 `npm ci` + `npm test`，矩阵为 **windows / macOS / linux × Node 22.19 与 24.x**，外加两条护栏断言：本工具依赖的 `node:zlib` zstd API 必须存在；测试不得在 `$HOME` 留下夹具影子 home。**CI 从不跑 `rehearsal run`** —— 它会装约 500 个包并重放真实会话副本，在共享 runner 上既不确定也不合适；`run` 的安全模型改由离线单测覆盖。

发版由 tag 触发（`.github/workflows/release.yml`）：**tag 不等于 `package.json` 版本就停，`CHANGELOG.md` 里没有对应小节也停**，然后把 tarball 与它的 `.sha256` 附到 Release、用 CHANGELOG 那一节当说明。npm 发布走 `publish.yml`，没有 `NPM_TOKEN` 时自我跳过而不是报错。

发布前务必读 [PUBLISHING.md](PUBLISHING.md)：直接推现有历史会公开一个脱敏前的快照（13 处真实路径跨 5 个文件）。仓库已备好一个经过验证的单提交 `publish-clean` 分支专为此用。

---

MIT License。与 DeepSeek 无关联、未获其背书。`dsh` / DeepSeek Harness 上游在 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)；桌面壳与活跃缺陷跟踪在 [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop)。
