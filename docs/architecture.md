[简体中文](architecture.md) | [English](architecture.en.md)

# 架构与分工

README 只回答"是什么、怎么跑、结果意味着什么"。这份文档回答"为什么这样设计、每个模块做什么、与生态里其他工具的边界在哪"。

## 为什么是外部 CLI

"装在待测 profile 里的工具会在最需要它时一起失效"这一判断出自 [`dsh-plugin-gating-hub`](https://github.com/Noob-stupid/dsh-plugin-gating-hub)（npm 包名 `@noob-stupid/dsh-plugin-console`，下文简称 gating-hub；`README.zh.md:282`「起不来的控制台什么都门控不了」）。同一动机另有两条独立实现：`@xiaoyuyu6420/dsh-backup` 的零依赖 `dsh-rescue`（`package.json` 的 `bin`），以及 `zzy6-a/dsh-upgrade-guard` 的宿主外 supervisor。在宿主之外运行不是差异点。

本工具的立场是下面四项同时成立（2026-10-02 逐条核对对方源码）：

| 条件 | 同类工具现状 |
|---|---|
| 安装候选核心版本，且装进私有前缀 | `@mars.liu/dsh-canary` 的 L1 可钉 `dsh` 版本，但复用现有 profile 的 `node_modules`；`@linxin666/dsh-doctor` 救援舱在隔离 `DSH_HOME` 中对候选执行门禁并原子提升，但钉的是当前版本，用途是恢复 |
| 读取用户历史会话 | 只有 `dsh-backup` 读取会话日志，其 `lib/index.js:512` 标注"只读扫描，不写任何文件" |
| 在已启动的影子宿主内完成迁移 | 读取会话的工具不启动宿主，启动宿主的工具不读取会话 |
| 写回合不需要 API 键 | `dsh-test-drive` 的 `capability` 阶段确实执行一个 headless 任务并回读持久会话日志，但该阶段需要 `DEEPSEEK_API_KEY`，无键时判 `skipped` |

第四项可自查：`gh search code "@deepseek-ai/dsh-llm-replay"`（2026-10-02）只命中官方仓 `deepseek-ai/deepseek-harness`、其 fork 与 vendored 文档，没有第三方工具消费该包。

执行形态：候选 `dsh` 是本工具自行 npm 安装、以私有目录为 `DSH_HOME` 启动的子进程。因此它无法触及活动 profile；已安装的 harness 起不来时预演仍可进行；每条结论对应磁盘上的产物。

## 模块划分

| 文件 | 职责 |
|---|---|
| `src/cli.js` | 参数解析、命令分派、退出码 |
| `src/commands/check.js` | 只读预检（盘点 + peer 图） |
| `src/commands/run.js` | 预演流水线与各阶段判定 |
| `src/lib/dshhome.js` | profile 枚举、当前运行时探测 |
| `src/lib/desktops.js` | 桌面宿主探测表：应用束与隔离 home 候选、来源分级 |
| `src/lib/asar.js` | 只读 asar 读取器：部分读取、档内路径、unpacked/link 一律 miss |
| `src/lib/sessions.js` | 会话发现、分类采样、副本与 cwd 重写 |
| `src/lib/shadow.js` | 候选安装、replay patch 生成、采用闸门补丁 |
| `src/lib/drill.js` | 迁移触发、读侧完整性、写回合与判定聚合 |
| `src/lib/report.js` | 报告结构、脱敏、Markdown 渲染 |
| `src/lib/zfstd.js` | 多帧 zstd 帧扫描与解码 |
| `src/lib/peers.js` | peer 范围求解与失配分级 |

## `check` 的解析链

patch 叠层按 `dsh.profile.bundles` 顺序 → profile 的 `cordis.patch.yml` → home 级 `cordis.patch.yml` → `--patch` 逐层解析；精确版本取自 `pnpm-lock.yaml`；`pnpm-workspace.yaml` 中会改变安装语义的策略（`autoInstallPeers`、`allowBuilds`、`minimumReleaseAgeExclude`）一并读取。

profile 不默认取 `web`：自动识别当前使用者。一台机器上 `desktop` profile 有 11 个 bundle、198 行 patch，`web` 只有 4 个 bundle / 4 行 patch，选错对象会让整份结论失效。

peer 失配按方向分级：只有"当前满足、候选不满足"记为阻断性 `high`；两侧都不满足的记 `pre-existing`。今天就已经错配的配置不是本次升级引入的。枚举式 peer 范围（`^0.1.7-rc.2` 不匹配 `0.2.0-rc.2`）与 `link:` / `file:` / `github:` 依赖单独标注，因为前者使 prerelease 升级必须逐版手写范围，后者不可复现。

## `run` 的阶段流水线

```text
私有前缀安装候选（默认 --ignore-scripts）
  → 两次冷启动
  → 会话副本迁移（v0 → … → v4）
  → 读侧完整性
  → 无键写回合
```

两次冷启动的依据是上游 [`#1294`](https://github.com/anywhere-labs/dsh-desktop/issues/1294)：插件批量升级后首次冷启动出现 renderer 30 秒健康上报超时，相同配置第二次启动即正常。一次失败一次成功记为抖动，不记为不兼容。

所有阶段判定只看产物。无键迁移**成功**时同样以 `MISSING_CREDENTIAL` 退出 1；`--dump-config-schema` 按设计在成功时置 `exitCode=1` 并把合法 JSON 写到 stdout。

## 桌面宿主探测表与 home 发现

`check` 与 `run` 的目标 home 按 `--home` → `DSH_HOME` → 已验证的默认 home → 探测表的顺序解析。前三档未命中时，`src/lib/desktops.js` 登记的桌面宿主（官方 DeepSeek Harness Desktop、anywhere-labs 的 DSH Desktop、dataelement 的 DSHDesktop）按登记顺序给出候选，逐一通过结构验证（profile manifest 带 `dsh.profile.bundles` 数组，或 sessions 下存在真实代际日志）才被采用；myYangyunfan 与 vibeinging 的 home 与默认重合且无可读运行时标记，不设条目。路径证据分三档随条目登记：实测-本机、实测-源码（基线提交：官方 `5badb15`、anywhere-labs `a1ff68b`、dataelement `beb6821`）、推断；来源分级不参与选择优先级。

官方桌面的 dsh 运行时整树在 `resources/app.asar` 的 `dsh/` 子树内，版本取自档内 `dsh/desktop-runtime.json` 的 `sharedPackages`（数组，上游强制 `@deepseek-ai/dsh` 版本与 `release.version` 相等），读取由零依赖的 `src/lib/asar.js` 完成：只读、部分读取、`unpacked`/`link` 条目一律 miss。anywhere-labs 的内置运行时经未打包的 `resources/app` 直接可读。

`current` 的解析分层：profile 内安装命中即权威；否则桌面内置运行时按 home 来源过滤——桌面来源的 home 只信自己宿主的 bundle，共享 home 探全部宿主（包括装了但从未启动的宿主），版本冲突返回 null 并以 `currentAmbiguous` 列出各宿主的版本；npm 前缀只在 `npm_config_prefix` 存在（npm 脚本环境）且前面全部落空时兜底。探测项按 `kind` 分两类：描述符（`desktop-runtime.json`）缺失时回退到档内 `package.json`；描述符存在但不可信（schema 漂移、版本不等）时保持未知并把标记记入 `untrusted`，不回退——回退会绕过描述符的完整性交叉校验。平台过滤与 asar 档位置（`archive`，Windows 为 `resources/app.asar`、macOS 为 `Contents/Resources/app.asar`）逐条声明在探测表里。current 未知时，peer 范围排除候选的插件按 high 分级，报告写明该后果，并指向 `--current`。

`run` 对纯桌面歧义（无有效默认 home 且 ≥2 个验证通过的桌面 home）要求显式 `--home`；唯一候选自动进行，`check` 全自动。桌面来源的预演在报告中带范围警告与 `coverage.host`（`desktopRuntimeTested: false`）。

## 写回合的三层抑制

三层互相独立，任何单层都不足以支撑"不会执行历史工具"的结论：

1. **沙箱 cwd。** `copySet` 重写副本 header 的 `cwd` 为 `<shadow>/workspace/<n>`，同时把副本迁入对应的编码工作区目录。宿主依据 `header.cwd` 反推会话物理路径，两者必须成对改写。
2. **抑制工具提供方。** replay patch 同时按行 id 与包名前缀抑制（`dsh-tool-`、`dsh-mcp-`、`dsh-skill`、`dsh-browser`、`dsh-terminal`、`dsh-jobs`、`terminal-`）。`tools` 注册表行保留，agent loop 依赖它。被重放的调用只返回 `isError`。
3. **只读允许清单（fail-closed）。** replay 只会发出该会话历史中出现过的工具，因此预筛是完整信息。仅当历史工具全部属于已知只读内置集合时才演练；`mcp__*` 前缀、执行与写入类、未知第三方工具、无名行一律跳过并记录原因。

工具名提取覆盖四种行形态：`tool/call`、`tool-call-chunks`、`tool/ptc-dispatch`、`tool/code-dispatch[·start]`。只扫第一种会静默漏掉整批工具。

## 多帧 zstd

DSH 会话日志是 Zstandard 多帧流。`node:zlib` 的 zstd 对多帧输入**静默只解第一帧**：一个 3,776,880 字节的文件读出 233 字节 / 1 行，看起来像"文件损坏"或"会话为空"。因此本工具自带帧扫描（`src/lib/zfstd.js`），读侧完整性校验建立在完整解码之上。

## 带预设的会话

one-shot runner 拒绝携带 `agentPreset` 的会话。`--preset-mode patch` 在私有候选副本中中和该单项采用检查，但不重建预设组合，因此这类会话的结论仅止于格式层面。采样策略为非预设层优先填满、预设层取剩余名额且保底 1 个。

预设会话的写回合结构上不可判定：replay 不拦截其 provider 路由，落到 `MISSING_CREDENTIAL`，新增行形态是 `assistant/attempt` 而非 `assistant/message`。因此它们执行并上报，但 `writeRoundVerdict()` 只在非预设轮上取 pass/fail；样本中只有预设时整阶段判 `inconclusive`。

## 与同类工具的分工

| 工具 | 已实现的范围 | 与本项目边界 |
|---|---|---|
| [`dsh-plugin-gating-hub`](https://github.com/Noob-stupid/dsh-plugin-gating-hub)（npm 包 `@noob-stupid/dsh-plugin-console`） | 契约预检 → 配置备份与全树回滚点 → 执行框架升级、失败自动回滚；启动失败隔离按启动日志点名定位肇事插件后禁用（预设改名 `.broken-*`）；环境指纹可发现其他通道引入的框架变更 | 运行于 profile 内，预检形式是契约集合差分（`lib/server/domain/format-contract.js:4-7`）。其 `dsh-plugin-gating-hub/CHANGELOG.md:875` 列出的未验证项包含：未跑过带预设的会话，因为"那需要新建会话 + 真实模型调用" |
| [`@linxin666/dsh-doctor` 救援舱](https://github.com/zhu1090093659/dsh-web) | 固定 DSH 运行时与隔离 `DSH_HOME`，对候选执行隔离 `dump-config` 与 Web 健康门禁，通过后提升，失败按字节回滚 | 门禁对象是装载器与配置面；其发布 tarball 的 node 侧代码不含 `session` / `sessions/` 引用 |
| [`dsh-test-drive`](https://github.com/PerryLink/dsh-test-drive) | 安装 → patch 生效 → 冷启动 → 卸载 → 清理，`mkdtemp` 影子 `DSH_HOME` 与独立 pnpm store；`schema: "dsh-test-drive/v1"`；`action.yml` 输出 Markdown 与 JUnit XML | 其 `capability` 阶段需要 API 键，且对象是新建会话 |
| [`@mars.liu/dsh-canary`](https://github.com/MarchLiu/dsh-canary) | 启动"现有 profile bundle 集 + 候选插件"的一次性组合（`profiles/canary-<rand>`，绝对符号链接复用 `node_modules`），L1 可钉 `dsh` 版本 | 变更对象是插件，不读写会话数据 |
| [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup) | `/backup migrate-check` 只读静态扫描全部代次会话日志，按代际冻结清单预测哪些会话打不开；另有零依赖 `dsh-rescue` | 见下方引文：限制来自读侧本身 |
| [`dsh-plugin-doctor`](https://github.com/PerryLink/dsh-plugin-doctor) | 包结构 R/K 门禁、cordis 契约扫描、无键无头冒烟（`MISSING_CREDENTIAL` 判为通过）；`coverage.<K>{filesInspected,mode}` + `degraded[]` + exit `6`，规则为"a `skip` is never rendered as `PASS`" | 同一族纪律，本项目把结论聚合到升级决策 |
| [`dsh-plugin-reducer`](https://github.com/ArmyWas/dsh-plugin-reducer) | 每次探测新建影子 `DSH_HOME` 并链接现有 `node_modules`（不安装任何内容），把故障 profile 归约为最小可复现插件集；weekly `upstream-canary.yml` 探 `dsh-app-boot@next` 布局漂移 | 面向已发生故障的事后归约 |

读侧无法判定这类损坏，`dsh-backup` 的实现注释是直接证据：

> `kind 只作提示，不作判据（#113）：宿主把它设计成可合并扩展的联合类型……旧实现把"不在白名单"直接判成"打不开"，在一台真实机器上把 81/82 份完全健康的日志报成不可打开`
> —— `xiaoyuyu6420/dsh-backup` `lib/index.js:2617-2622`

面对同类损坏，`gating-hub` 的处置是改写生产方源码（契约规则 `session-message-source-kind`）。静态扫描会产生大规模误判，契约差分修改的是代码而非数据；而 [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) 的会话表现为打开正常、每个写回合失败。只有实际写入一次才能判定。

## 与官方门禁的分工

`dsh-plugin-manager` 在安装与启动时按声明的 peer 范围拦截，并提供精确版本豁免（`dsh plugin allow-version … --accept-risk`），属运行期护栏。本工具回答更早的问题：升级到某个版本会产生什么结果，包括只在被写入时才暴露的会话数据。两者互补。

## 术语

| 概念 | 中文 | English |
|---|---|---|
| 静态预检 | 预检 | pre-flight |
| 完整预演 | 预演 | rehearsal |
| 候选版本 | 候选版本 | candidate |
| 当前使用环境 | 活动 profile / 真实 home | live profile / real home |
| 隔离环境 | 影子 home | shadow home |
| 会话副本 | 会话副本 | session copy |
| 格式迁移 | 迁移 | migration |
| 写入一轮 | 写回合 | write round |
| 无法判定 | 不可判定 | `inconclusive` |
| 既有问题 | 既存失配 | `pre-existing` |
| 脱敏 | 脱敏 | redaction |
| 桌面宿主 | 桌面宿主 | desktop host |
| 桌面宿主探测表 | 探测表 | host catalog |
| home 来源 | home 来源 | home origin |

状态词统一为：**Tested**（实际跑过）、**Inferred**（代码分析得出、未真实运行）、**Not tested**、**Unsupported**（明确不支持）、**Not covered**（有意不覆盖）。
