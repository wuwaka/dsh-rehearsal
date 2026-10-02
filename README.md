<div align="center">

<img src="assets/poster.jpg" width="620" alt="dsh-rehearsal 海报：在隔离 DSH_HOME 中用真实历史会话预演 DeepSeek Harness 升级">

# dsh-rehearsal

DeepSeek Harness（`dsh`）升级预演工具：在全新的 `DSH_HOME` 中用候选版本加载插件集与真实会话副本，全程无需 API 键，输出可核验的升级决策报告。

[简体中文](README.md) | [English](README.en.md)

[![license](https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square)](LICENSE)
[![release](https://img.shields.io/github/v/release/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/releases)
[![CI](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/stargazers)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe?style=flat-square)](https://github.com/topics/dsh-plugin)
[![tested](https://img.shields.io/badge/tested%20on-DSH%200.2.0--rc.2-4d6bfe?style=flat-square)](#兼容性)

*独立命令行工具，不作为 `dsh plugin add` 的 bundle 分发。*

</div>

---

<details>
<summary>目录</summary>

- [这是什么](#这是什么)
- [安装](#安装)
- [快速开始](#快速开始)
- [工作方式](#工作方式)
- [为什么是外部 CLI](#为什么是外部-cli)
- [兼容性](#兼容性)
- [安全设计](#安全设计)
- [覆盖范围](#覆盖范围)
- [与同类工具的差异](#与同类工具的差异)
- [已知限制](#已知限制)
- [如何验证真实 home 未被写入](#如何验证真实-home-未被写入)
- [开发与发布](#开发与发布)

</details>

## 这是什么

| 命令 | 作用 |
| --- | --- |
| `check --candidate <版本>` | 静态体检：只读、零下载、秒级。识别当前使用的 profile，解析 patch 叠层与精确版本，分析 peer 图（区分本次升级引入的失配与既有的失配），统计会话格式代际分布 |
| `run --to <版本>` | 实机预演：私有前缀安装候选版本 → 两次冷启动 → 在真实会话副本上触发惰性迁移 `v0→…→v4` → 读侧完整性校验 → 无键写回合（官方 `@deepseek-ai/dsh-llm-replay`） |

输出 `dsh-rehearsal/v1` 报告（`report.json` 与 `report.md`），退出码可被脚本直接判定：`0` 可升级 · `1` 有条件升级 · `2` 不建议升级 · `3` 预演本身失败。

## 安装

按 tag 安装，无需 npm 账号（该方式自 0.1.0 起实测可用）：

```sh
npm install -g github:wuwaka/dsh-rehearsal#v0.2.0
dsh-rehearsal check --candidate 0.2.0-rc.2
```

需要把安装内容固定到字节时，使用 Release 附带的 tarball 与校验文件：

```sh
curl -sSLO https://github.com/wuwaka/dsh-rehearsal/releases/download/v0.2.0/dsh-rehearsal-0.2.0.tgz
curl -sSL -O https://github.com/wuwaka/dsh-rehearsal/releases/download/v0.2.0/dsh-rehearsal-0.2.0.tgz.sha256
sha256sum -c dsh-rehearsal-0.2.0.tgz.sha256
npm install -g ./dsh-rehearsal-0.2.0.tgz
```

## 快速开始

```sh
dsh-rehearsal --version                               # 确认可执行文件已就位
dsh-rehearsal check --candidate 0.2.0-rc.2            # 只读体检，秒级
dsh-rehearsal run --to 0.2.0-rc.2 --sample 20         # 完整预演：安装候选版本并复制会话副本，首次约 2-5 分钟
dsh-rehearsal clean --yes                             # 清理 .dsh-rehearsal 产物
```

从源码运行：

```sh
git clone https://github.com/wuwaka/dsh-rehearsal.git && cd dsh-rehearsal
npm install && npm test
node src/cli.js check --candidate 0.2.0-rc.2
```

常用旗标：`--profile`、`--home`、`--current`（覆盖自动探测）、`--full`、`--preset-mode patch`、`--writeRounds N`、`--skip-write`、`--allow-tools`、`--run-scripts`、`--keep`、`--shadow-dir`、`--prefix-dir`。

交给可操作终端的 agent 执行只读预检时，可直接粘贴下面这段：

> 在本机做一次只读的 DeepSeek Harness 升级预检。clone 或更新 `https://github.com/wuwaka/dsh-rehearsal`，执行 `npm install`，然后运行 `node src/cli.js check --candidate <目标版本>`，汇报结论、每条 `high` 发现对应的插件与 peer 范围，以及会话代际分布。未获明确同意不得运行 `run`（该命令会安装候选版本并重放会话副本）；不得修改任何 profile 或 `~/.dsh` 文件；不得输出任何凭据。

## 工作方式

### `check` 静态体检

- 识别当前使用的 profile，不默认取 `web`。实测一台机器上 `desktop` profile 有 11 个 bundle、198 行 patch，`web` profile 只有 4 / 4。
- 解析 patch 叠层：`dsh.profile.bundles` 顺序 → profile 的 `cordis.patch.yml` → home 级 `cordis.patch.yml` → `--patch`；从 `pnpm-lock.yaml` 取精确版本；读取会改变安装语义的 `pnpm-workspace.yaml` 策略（`autoInstallPeers`、`allowBuilds`、`minimumReleaseAgeExclude`）。
- peer 图分析：插件与 dsh、插件与插件、`@deepseek-ai/cordis` 多版本 pin 冲突、枚举式 peer 范围（`^0.1.7-rc.2` 不匹配 `0.2.0-rc.2`，prerelease caret 不跨版本），以及 `link:`、`file:`、`github:` 这类不可复现依赖。
- 每条发现区分"本次升级引入"与"当前已存在"。两侧都不满足的失配记为 `pre-existing`，不计入阻断项。

### `run` 预演

```
私有前缀安装候选版本（默认 --ignore-scripts）
  → 两次冷启动（上游 #1294 记录过首次冷启动失败、相同配置第二次成功）
  → 在真实会话副本上触发惰性迁移（v0 → … → v4）
  → 读侧完整性（完整多帧解码、seq 连续、turn 双向闭合）
  → 用官方 @deepseek-ai/dsh-llm-replay 执行无键写回合
```

写回合是本工具与其他预检的区分点。格式迁移是惰性的、只在会话被打开时发生，而读侧校验对"能打开但写不进去"的数据会判通过：上游 [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) 记录的正是打开正常、每个回合都失败的会话。`dsh-llm-replay` 用会话自身的录制流重建模型响应，因此写一次不需要 API 键。

### 报告结构

每阶段一条记录（`verdict` / `durationMs` / `details` / `evidence`），阶段记录字段与 `dsh-test-drive/v1` 对齐；另有固定的 `coverage` 节、顶层 `warnings[]`，以及说明剥除了哪些内容的 `privacy` 块。

## 为什么是外部 CLI

"装在待测 profile 里的工具会在最需要它的时候一起失效"这一判断来自 [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub)（`README.zh.md:282`「起不来的控制台什么都门控不了」），同类思路还有 `@xiaoyuyu6420/dsh-backup` 的零依赖 `dsh-rescue` 与 `zzy6-a/dsh-upgrade-guard` 的宿主外 supervisor。在宿主之外运行不是本工具的差异点；差异点是以下四项同时成立（逐条核对对方源码，2026-10-02）：

| 条件 | 同类工具现状 |
|---|---|
| 安装候选核心版本，且装进私有前缀 | `@mars.liu/dsh-canary` 的 L1 可钉 `dsh` 版本，但复用现有 profile 的 `node_modules`；`@linxin666/dsh-doctor` 救援舱在隔离 `DSH_HOME` 中对候选执行门禁并原子提升，钉的是当前版本，用途是恢复而非预演 |
| 读取用户历史会话 | 只有 `dsh-backup` 读取会话日志，其 `lib/index.js:512` 标注"只读扫描，不写任何文件" |
| 在已启动的影子宿主内完成迁移 | 读取会话的工具不启动宿主，启动宿主的工具不读取会话 |
| 写回合不需要 API 键 | `dsh-test-drive` 的 `capability` 阶段确实会执行一个 headless 任务并回读持久会话日志，但该阶段需要 `DEEPSEEK_API_KEY`，无键时判 `skipped` |

第四项可以复核：`gh search code "@deepseek-ai/dsh-llm-replay"`（2026-10-02）只命中官方仓 `deepseek-ai/deepseek-harness`、其 fork 与 vendored 文档，没有第三方工具消费该包。

执行形态：候选 `dsh` 是本项目自行 npm 安装、以私有目录为 `DSH_HOME` 启动的子进程，因此无法触及活动 profile；已安装的 harness 无法启动时预演仍可进行；每条结论对应磁盘上的产物而非人工阅读的日志。

与官方门禁的分工：`dsh-plugin-manager` 在安装与启动时按声明的 peer 范围拦截，并提供精确版本豁免（`dsh plugin allow-version … --accept-risk`），属于运行期护栏。本工具回答更早的问题：升级到某个版本会产生什么结果，包括只在被写入时才暴露的会话数据。两者互补。

## 兼容性

下表分列"实测"与"声明 / 未验证"。对用于升级决策的工具而言，测试环境的时效本身就是需要披露的信息。

| 组件 | 实测 | 声明 / 未验证 |
|---|---|---|
| 候选 `dsh` | `0.2.0-rc.2`，`--sample 9 --preset-mode patch`：9/9 个真实会话完成 `v0→v4` 迁移，1 次无键写回合 `pass`（2026-10-02，单机） | 更早的 rc 与稳定版未预演；`check` 仅解析文件，不安装任何内容 |
| 当前运行时探测 | 依次探测 profile 的 `node_modules`、共享 `profiles/node_modules`、DSH Desktop 内置体（`…/resources/app/node_modules/@deepseek-ai/dsh`）、npm 前缀 | Desktop 内置体的 `run` 预演不支持，见下方设计决定 |
| 会话格式代际 | `v0`（`session.jsonl.zstd`）、`v3`、`v4`；`v0→…→v4` 迁移链已在真实日志上跑通 | `v1`、`v2` 仅做代际识别，无真机样本 |
| Node.js | 本机 22.22.2；CI 覆盖 22.19 与 24.x 六个组合（24.x 仅在 CI 验证） | `engines.node: >=22.19`，需要 `node:zlib` 的 zstd（v22.15.0 引入，仍标 *Stability: 1 – Experimental*） |
| 平台 | Windows 真机端到端；macOS / Linux 仅 CI，且 CI 只运行 `npm test` | `run` 在非 Windows 未做真机会话预演 |
| 包管理器 | `npm`，不依赖 `PATH` 语义定位，仅用于将候选版本装入私有前缀 | 不安装到 profile，不依赖 pnpm |
| 运行时依赖 | 1 个：`semver` | — |
| 凭据 | 任何阶段都不需要，见[安全设计](#安全设计) | — |

不支持且属设计决定：通过 npm CLI 预演 Electron 托管的 `desktop` profile。`dsh` 直接拒绝（`profile "desktop" is managed exclusively by the Electron application`），且 npm 安装的候选版本与 Desktop 内置体是两套不同的依赖闭包。`check` 仍可覆盖 `desktop` profile，`run` 面向 npm 或自托管的 `web`、`headless` profile。

## 安全设计

写回合的抑制由三层独立实现，任何一层单独都不足以支撑结论：

1. 沙箱 cwd。`copySet` 将副本会话 header 的 `cwd` 重写为 `<shadow>/workspace/<n>`，同时把副本迁入对应的编码工作区目录。宿主依据 `header.cwd` 反推会话物理路径，两者必须同时改写。任何进程都不会以真实工作区为根目录。
2. 默认禁用工具提供方。replay patch 同时按行 id 与包名前缀抑制（`dsh-tool-`、`dsh-mcp-`、`dsh-skill`、`dsh-browser`、`dsh-terminal`、`dsh-jobs`、`terminal-`）。`tools` 注册表行保留，agent loop 依赖它。被重放的调用只会返回 `isError`，不会执行。
3. 只读允许清单（fail-closed）。replay 只会发出该会话历史中出现过的工具，这一预筛因此是完整信息而非估计。仅当历史工具全部属于已知只读内置集合时才执行预演：`mcp__*` 前缀、执行与写入类、未知第三方工具、无名行一律跳过，并逐条记录原因。工具名提取覆盖四种行形态（`tool/call`、`tool-call-chunks`、`tool/ptc-dispatch`、`tool/code-dispatch[·start]`），仅扫描 `tool/call` 会漏掉整批工具。

固定约束：

- 无键。子进程环境中形如凭据的变量（`API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PRIVATE_KEY|AUTH`）全部剔除，报告只记录被剔除的变量名，不记录值。不消耗 token，不向任何 provider 发送内容。
- 遥测关闭。`DSH_TELEMETRY_MODE=DISABLED`（候选 `0.2.0` 默认为 `FEEDBACK_ONLY`，其 OTLP 直连会绕过代理）。
- 判定只依据产物，不依据退出码。成功的无键迁移会以 `MISSING_CREDENTIAL` 退出 1；`--dump-config-schema` 按设计成功时也置 `exitCode=1`，同时向 stdout 输出合法 JSON。
- 只使用自行安装的候选二进制。`PATH` 上的 `dsh` 可能是不理会 `DSH_HOME` 的桌面 shim，会写入真实 home。该情况在开发期发生过，现在从结构上排除。
- 报告不含消息正文。`stderr` 只保留诊断行（replay 会把推理正文写到 stderr，不匹配诊断形态的行一律丢弃并计数）；evidence 对象逐字符串脱敏（绝对路径含带空格者→ `<abs-path>`，家目录→ `~`，凭据形状→ `[redacted]`）。报告中只出现会话 id、类型直方图、seq 区间与字节数。
- 所有退出路径均执行清理。影子 home 内含完整会话副本与明文解压 fixture，因此在 `finally` 中删除，并在报告记录 `shadowCleanup: removed|kept|failed`。

## 覆盖范围

写回合的范围刻意收紧：要求会话录制中出现过的工具全部为只读。单机实测（2026-10-02）：

| 阶段 | 数量 | 占比 |
|---|---|---|
| 会话总数 | 52 | — |
| 可预演（未迁移至 v4 且 cwd 可用） | 24 | 46% |
| 通过只读允许清单 | 5 | 可预演数的 21%，全库的 9.6% |

迁移预演覆盖广，写路径预演覆盖窄，两类结论强度不同，不应互换引用。`coverage.writeRounds` 提供 `plainAttempts`、`plainPass`、`presetAttempts`、`presetPass`、`skippedWriteTools`，并逐个列出被拦下的会话及其工具名；`coverage.sessions.preset` 提供 `inLibrary`、`drillable`、`selected`、`migrated`。是否演练过带预设的会话由报告自证，不依赖文档陈述。

带 `agentPreset` 的会话由 one-shot runner 拒绝。`--preset-mode patch` 在私有候选副本中中和该单项采用检查，但不重建预设组合，因此这类会话的结论仅止于格式层面，报告同样如此标注。采样保证预设会话被代表：非预设层优先填满，预设层取剩余名额且保底 1 个。预设会话的写回合照跑照报，但不单独决定阶段结论——replay 不拦截其 provider 路由，仅选到预设时整阶段判 `inconclusive`。

## 与同类工具的差异

下表每格均以对方源码或原文核对，核对日期 2026-10-02。

| 工具 | 已实现的范围 | 本工具补充 |
|---|---|---|
| [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) | 升级前契约预检 → 配置备份与全树回滚点 → 执行框架升级、失败自动回滚；启动失败隔离按启动日志点名定位肇事插件后禁用（预设改名 `.broken-*`），无法定位时才进安全模式；环境指纹可发现其他通道引入的框架变更 | 运行于 profile 内，预检形式是契约集合差分（`lib/server/domain/format-contract.js:4-7`）。其 `CHANGELOG.md:875` 列出的未验证项包含：未跑过一次带预设的会话，原因是"那需要新建会话 + 真实模型调用"。本工具取消的正是"真实模型调用"这一前提 |
| [`@linxin666/dsh-doctor` 救援舱](https://github.com/zhu1090093659/dsh-web) | 固定 DSH 运行时与隔离 `DSH_HOME`，对候选执行隔离 `dump-config` 与 Web 健康门禁，通过后提升，失败按字节回滚 | 门禁对象是装载器与配置面。其发布 tarball 的 node 侧代码不含 `session` / `sessions/` 引用；所钉版本为当前版本，用途是恢复 |
| [`dsh-test-drive`](https://github.com/PerryLink/dsh-test-drive) | 安装 → patch 生效 → 冷启动 → 卸载 → 清理，全程 `mkdtemp` 影子 `DSH_HOME` 与独立 pnpm store；`schema: "dsh-test-drive/v1"`；`action.yml` 输出 Markdown 与 JUnit XML；可选 `capability` 阶段执行 headless 任务并核对持久会话日志已记录该次调用 | 该阶段需要 `DEEPSEEK_API_KEY`，无键时判 `skipped`，且对象是新建会话。本工具的写回合无需密钥，对象是 `v0→v4` 迁移后的用户历史副本 |
| [`@mars.liu/dsh-canary`](https://github.com/MarchLiu/dsh-canary) | 独立 npm CLI，启动"现有 profile bundle 集 + 候选插件"的一次性组合（`profiles/canary-<rand>`，通过绝对符号链接复用 `node_modules`），L1 可钉 `dsh` 版本 | 变更对象是插件；不读写会话数据。不提供 GitHub Action，也无 `v1` schema 判别字段 |
| [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup) | `/backup migrate-check` 只读静态扫描全部代次的会话日志（`lib/index.js:512`"不写任何文件"），按代际冻结清单预测哪些会话无法打开、命中哪条规则；另有零依赖进程外救援 `dsh-rescue` | 限制来自读侧本身，见下方引文 |
| [`dsh-plugin-doctor`](https://github.com/PerryLink/dsh-plugin-doctor) | 包结构 R/K 门禁、cordis 契约扫描、无键无头冒烟（`MISSING_CREDENTIAL` 判为通过）；提供 `coverage.<K>{filesInspected,mode}`、`degraded[]` 与 exit `6`，规则为"a `skip` is never rendered as `PASS`" | 同族纪律而非竞品。本工具的 `coverage` 与 `warnings[]` 遵循同一原则，区别在于聚合到升级决策 |
| [`dsh-plugin-reducer`](https://github.com/ArmyWas/dsh-plugin-reducer) | 外部 CLI，每次探测新建影子 `DSH_HOME` 并将 profile 链接至现有 `node_modules`（不安装任何内容），把故障 profile 归约为最小可复现插件集；另有每周 `upstream-canary.yml` 探测 `dsh-app-boot@next` 的布局漂移 | 面向已发生的故障做事后归约；本工具在升级前运行。其 canary 观察上游布局，不涉及会话数据 |

读侧无法判定这类损坏，`dsh-backup` 的实现注释是最好的说明：

> `kind 只作提示，不作判据（#113）：宿主把它设计成可合并扩展的联合类型……旧实现把"不在白名单"直接判成"打不开"，在一台真实机器上把 81/82 份完全健康的日志报成不可打开`
> —— `xiaoyuyu6420/dsh-backup` `lib/index.js:2617-2622`

面对同类损坏，`gating-hub` 的处置是改写生产方源码（契约规则 `session-message-source-kind`，将仍在输出 V3 `{kind:'plugin'}` 包装的插件改为 producer-owned kind）。静态扫描会产生大规模误判，契约差分修改的是代码而非数据；上游 [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) 的会话则表现为打开正常、每个写回合都失败。只有实际写入一次才能判定，而写入一次原先必须有 API 键。

每条日志形态的原文、检测位置、命中与非命中各能推出什么、以及哪些在本机无法复现，见 [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md)。

## 已知限制

- `--allow-tools` 会实际执行会话记录中的工具调用。cwd 仍在沙箱内，但 `pwsh`、`bash` 可通过绝对路径越出该目录。仅对接受其历史副作用的会话显式开启。
- 附件旁路数据不复制、不校验（`~/.dsh/attachments`、`cache/attachments`）。附件引用完整性列于范围之外。
- npm 影子环境与 Desktop 安装体不等价，`run` 无法复现 Electron 的依赖闭包，见[兼容性](#兼容性)。
- 预演证明的是写路径可通行，不是自由行为：replay 脚本派生自该会话自身的录制流，录制中不存在的工具与路径不会出现。
- `#1229` 类损坏行的检测已内置，但在本机数据上无法触发：`v3→v4` 迁移包自 `0.2.0-rc.1` 起带 `producerKind` 改写映射。
- `run` 使用同一个 `--sample` 决定迁移样本与写回合候选池，扩大写覆盖需调高该值。
- 不收录于 `awesome-dsh-plugin` 插件目录，且不应收录：该目录的 `scripts/check-submission.mjs:258-264` 要求仓库内某个 `package.json` 声明 `dsh.bundle`，仅声明 `dsh.client` 亦被拒绝（`dsh-plugin-reducer`、`dsh-canary` 同样不在目录中，4412 条实测 0 命中）。适合收录的位置是工具类目录：`walkinglabs/awesome-deepseek-harness-plugins` 的 `docs/INCLUSION_POLICY.md` 第 4 条，以及 `awesome-deepseekharness/awesome-deepseek-harness` 的 `CONTRIBUTING.md`（🧩 Tools）。

## 如何验证真实 home 未被写入

三条互相独立的检查：

```sh
# 1) 真实库中所有迁移产物的 mtime 必须早于预演时刻
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort | tail -3
# 2) 不留影子目录（除非使用 --keep 或 --shadow-dir，否则自动清理）
ls -d "${TMPDIR:-/tmp}"/dsh-rehearsal-home-* 2>/dev/null | wc -l
# 3) 报告中不含家目录与正文；<TOKENS> 替换为使用方的用户名与盘符关键词
node -e "const fs=require('fs');const d=fs.readdirSync('.dsh-rehearsal').sort().pop();\
const t=fs.readFileSync('.dsh-rehearsal/'+d+'/report.json','utf8');\
console.log(['<TOKENS>','reasoning:'].filter(k=>t.includes(k)).length?'LEAK':'CLEAN')"
```

## 开发与发布

```sh
npm test        # 61 个测试：多帧 zstd 回归 / peer 分级 / 沙箱 cwd 重写与目录编码 /
                # stderr 消毒 / 结构化脱敏 / 只读允许清单 / env 剔除 / countRows 结构 /
                # 分层采样 / writeRoundVerdict / warnings 渲染与脱敏 /
                # 签名回归锁 / changelog 双语一致性 / check 端到端 CLI 冒烟
```

签名回归锁成对出现：每条日志形态必须命中取自 issue 正文或真机产物的原文，且必须不命中健康行。另一条断言要求代码中检测的每个 id 都出现在 `docs/FAILURE_MODES.md`，避免文档与实现脱节后成为未经复核的兼容性声明。

CI 执行 `npm ci` 与 `npm test`，矩阵为 windows / macOS / linux × Node 22.19 与 24.x，另含两条护栏：`node:zlib` 的 zstd API 必须存在；测试不得在 `$HOME` 留下夹具影子 home。CI 不运行 `run`：该命令会安装约 500 个包并重放真实会话副本，在共享 runner 上既不确定也不合适；`run` 的安全模型由离线单测覆盖。

发布由 tag 触发（`.github/workflows/release.yml`），两种情况会直接终止：tag 与 `package.json` 版本不一致；两份 CHANGELOG 中任一缺少对应小节。通过后 tarball 与其 `.sha256` 附至 Release，正文按固定顺序生成（中文小节 → 安装 → `---` → 英文小节）。npm 发布由 `publish.yml` 承担，缺少 `NPM_TOKEN` 时跳过而非报错。

发布流程与历史处理见 [PUBLISHING.md](PUBLISHING.md)（英文版 [PUBLISHING.en.md](PUBLISHING.en.md)）。版本策略与被修订的主张见 [CHANGELOG.zh.md](CHANGELOG.zh.md)（英文版 [CHANGELOG.md](CHANGELOG.md)）；`run --to <版本>` 中的版本号为被测 `dsh` 的版本，与本工具版本无关。由代码与测试保证的承诺、以及两个由使用方承担风险的旗标，见 [SECURITY.md](SECURITY.md)（英文版 [SECURITY.en.md](SECURITY.en.md)）。仓库内每份文档都以这样的双语对形式存在；两份内容走偏时 `test/docs.test.js` 会失败。

MIT License。与 DeepSeek 无关联、未获其背书。`dsh` / DeepSeek Harness 上游位于 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)；桌面宿主与活跃缺陷跟踪位于 [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop)。
