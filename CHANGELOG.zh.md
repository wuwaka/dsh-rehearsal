# Changelog · 中文

[简体中文](CHANGELOG.zh.md) | [English](CHANGELOG.md)

> 下面的版本号属于 `dsh-rehearsal`。`run --to <版本>` 中的版本是候选 `dsh`，不作为发布版本记录。

格式：[Keep a Changelog](https://keepachangelog.com/zh-Hans/1.1.0/)，[语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。
两份文件的小节同名同序（`test/changelog.test.js`），任一份缺少对应小节时 `release.yml` 终止发布。

## [Unreleased]

## [0.3.0] - 2026-10-05

### 新增

- 桌面宿主兼容：`check` 与 `run` 无需 `--home` 即可发现官方 DeepSeek Harness Desktop 与社区桌面（anywhere-labs `DSH Desktop`、dataelement `DSHDesktop`）的 home——`--home` 与 `DSH_HOME` 缺省、默认 home 不存在或不是真实数据时，按登记顺序逐宿主探测并验证（必须存在 profile manifest 或真实会话日志）；报告以 `target.homeOrigin` 标签记录来源，不写路径。
- 版本探测走探测表：官方运行时整树在 `resources/app.asar` 档内，由零依赖只读读取器读取 `dsh/desktop-runtime.json`（`sharedPackages` 为数组，取 `@deepseek-ai/dsh` 条目并与 `release.version` 交叉校验）；桌面来源的 home 只信自己宿主的内置运行时，共享 home 上多宿主版本冲突返回 null 并以 `currentAmbiguous` 列出各宿主的版本，npm 全局前缀只在其他来源全部落空时参与。
- 桌面来源的 `run` 预演附带范围警告与 `coverage.host`（`desktopRuntimeTested: false`）：判定覆盖 npm 依赖闭包与会话数据格式，不覆盖桌面应用自身的更新通道；纯桌面歧义（无有效默认 home 且 ≥2 个桌面 home 验证通过）时 `run` 要求显式 `--home`，`check` 全自动。
- 发现、探测与范围判定附带 25 条回归锁：从探测表顺序漂移锁定、真实工具生成的 asar 夹具，到双宿主版本冲突用例（测试数 81 → 106）。

## [0.2.2] - 2026-10-04

文档、徽章与安装元数据，外加一处内部常量收敛。`check` 与 `run` 的行为**没有任何改动**。

### 变更

- 假设的模型上下文窗口 `256000` 从两处魔数（`extractRoutes` 造默认模型条目、影子 settings 序列化的兜底）收敛为 `util.js` 的命名常量 `ASSUMED_CONTEXT_WINDOW_TOKENS`，并加回归锁：该字面量只允许出现在常量定义处（测试数 80 → 81）。
- `SECURITY.md` 补充工具抑制名单（`TOOL_ROW_NAME_PREFIXES`）的失效方向：名单缺了新工具家族只会让抑制不完整，不构成放行路径——写回合只回放会话录制中出现且全部通过只读白名单的调用，`--allow-tools` 默认关闭仍是最外层闸门。引用断言同步加入文档测试。
- README 首屏正面陈述核心差异：迁移成功不等于写回（含"读侧静态检查无法判定该类损坏"的依据，
  及七个同类工具逐项对照的链接）；新增「为什么是独立 CLI，而不是插件」；使用场景由反问改为直陈；
  删除硬编码的测试数；`report` 与 `clean` 两个命令显名。
- `SECURITY.md` 同一边界只说一次：删除重复段落与拟人表述。`PUBLISHING.md` 收敛为发布操作手册，
  维护者知识（目录投稿调查、仓库图片、文档治理、新增签名的步骤）移入新增的 `docs/MAINTAINING.md`；
  `docs/FAILURE_MODES.md` 的「新增一条签名」一并移入，正文收敛为纯 reference。
- README 安装节增加 npm registry 路径（`dsh-rehearsal@0.2.1` 已于 2026-10-03 发布）；徽章区新增
  npm 版本徽章与 `listed in awesome-deepseek-harness` 收录徽章（`Dominic789654/awesome-deepseek-harness#579` 已合并）。
- npm `keywords` 移除 `dsh-plugin`，与 GitHub topics 的口径对齐（生态反爬虫清单会剔除蹭该标签的非插件）。

## [0.2.1] - 2026-10-03

文档与发布可核验性。`check` 与 `run` 的行为**没有任何改动**。

### 变更

- README 从 247 行压到约 130 行：只保留定位、安装、快速开始、真实输出示例、报告、覆盖范围、
  安全摘要、兼容性、限制。移出的内容进入新增的 `docs/architecture.md`。
- 首页不再承担"为什么值得存在"的论证：外部 CLI 的理由、与同类工具的分工表、写回合三层抑制的
  实现细节、多帧 zstd 的测量数字，全部下沉到 architecture 与 SECURITY。
- 新增一句核心边界：**迁移成功不等于迁移后的会话还能写回**。
- "全程无需 API 键"改为准确表述：写回合走 `@deepseek-ai/dsh-llm-replay` 的录制回放路径，
  不发起真实模型请求。
- 术语统一：预检 / 预演 / 迁移 / 写回合（pre-flight / rehearsal / migration / write round）；
  状态词统一为 Tested / Inferred / Not tested / Unsupported / Not covered。
- 删除"由报告自证""逐条核对对方源码"这类审计腔措辞。
- `SECURITY.md` 重排为：代码保证 / 显式危险选项 / 报告是敏感数据 / 范围之外 / 自查方法 / 上报方式。
- `AUDIT.md` 标注为历史基线文档（基线 `7c374bc`），新增逐条状态总览表；`FIXES.md` 并入其
  "修复与验证"一节后删除，避免与 AUDIT / CHANGELOG / git 历史三处重复。
- `PUBLISHING.md` 改为清单优先，事故叙述移出。
- 全部文档双语对；`test/docs.test.js` 断言对开存在、小节数一致、`file:line` 引用与 issue 号与
  提交哈希集合一致、语言切换行指向真实文件、无第一人称（测试数 61 → 68）。
- 新增仓库海报 `assets/poster.jpg` 与 `assets/social-preview.jpg`。

### 修复

- `a-inventory` 的 `details` 原先把 `DSH_HOME` 原值拼进字符串，靠 `finalize()` 的正则遮罩。该正则识别
  `C:\Users\<n>`、`/home/<n>`、`/Users/<n>` 与任意盘符路径，但**相对路径、UNC 共享、以及
  `/srv/users/<n>` 这类非标准 Unix 家目录会原样进入报告**（A/B 实测：修复前 `home=dsh-home` 泄漏，
  修复后为 `home=custom`）。该字段改为只写形状，路径不再进入字符串。
- `report.tool.version` 硬编码为 `0.1.0`，已与 `package.json` 脱节；现改为从 `package.json` 读取。
- 回归锁：`homeShape` 的返回值不得含路径分隔符；端到端用**相对** `--home` 跑 `check`，断言该路径
  不出现在报告任何位置（测试数 68 → 70）。
- 上一条只是让 `home` 这一个调用点不再经过滤器，`scrubText` 本身的缺口仍在：`/root/.dsh`（容器与
  root 运行时的默认家目录）、`/var/lib/<服务名>`、`/srv/<团队>`、`/tmp/<影子目录>`、UNC 共享与 `../`
  相对路径全部原样穿过。本轮按**类**修：过滤器补齐这些形状（URL 与仓库相对路径各有测试保证不被误遮）；
  `scrubValue` 原先只清值不清键，以路径作键会整体绕过，现已一并清；`finalize()` 增加不变量，用同一
  检测器复扫完整报告，任何漏网的 path-shaped 文本写入 `warnings[]`（`redaction gap: …`），将来新
  阶段拼出新式路径时会带上该警告落盘，而不是无声通过。测试数 70 → 73。
- `privacy.scrubbed: true` 原先写在 `newReport()` 里，等于**构造时就宣称已脱敏**；而 redaction-gap
  不变量在 `finalize()` 内部，所以"某阶段绕过 `finalize()`"这一场景并未被覆盖（评审指出，判断正确）。
  现在该字段由 `finalize()` 依据不变量结果写入：没扫干净就是 `false`。同时新增 `writeReport()`
  作为唯一落盘入口，未 finalize 的报告会在落盘前被就地补做。
- `check` 不带 `--candidate` 时，`0 newly-broken high` 是空转出来的数字却按结果呈现。现在该阶段判
  `warn`、`details` 写明"comparison NOT exercised"、并写入一条 `warnings[]`，退出码为 `1` 而非 `0`。
- `defaultHome()` 在 `USERPROFILE` 与 `HOME` 同时缺失时（裸容器）会走到
  `path.join(undefined, '.dsh')` 抛 `TypeError`；现回退到 `os.homedir()` 再到 `cwd`，不再抛。
  顺带修掉一处同源漂移：`homeShape()` 自己重算默认位置，与加固后的 `defaultHome()` 得出不同结果，
  会把真实默认值判成 `custom`；现由调用方传入单一事实源。测试数 73 → 78。

- 文档里的行号引用会随代码移动而失效，且此前**不可检测**。本轮修掉四处真实失效：`SECURITY` 引用的
  `src/lib/report.js` 的第 136 行在 `finalize()` 上移后指向无关代码（实为第 199 行）；作为"不该被误遮"示例写出的 `src/lib/x.js`（第 12 行）指向不存在的文件；`docs/FAILURE_MODES` 里 `src/lib/drill.js` 的第 311-313 行差一行
  （应为 312-314）；指向 gating-hub 第 875 行的那条外部引用与本仓库自己的同名文件撞名，读者无从分辨归属，现已带上 owner 前缀。
- 新增两条断言（测试数 78 → 80）：活文档引用的每个仓内路径必须存在、外部引用必须在同一行标明归属；
  每个仓内 `file:line` 引用都必须配一条"该行确实写着被引用的东西"的断言，没有断言的新引用会让测试失败。
  `AUDIT.md` 有意排除——它描述的是自己声明的基线提交，拿 HEAD 去断言它的行号会在两个方向上出错。

## [0.2.0] - 2026-10-02

文档与发布可核验性。`check` 与 `run` 的行为**没有任何改动**。

### 变更

- **撤回四条定位主张**。核对 7 个同类项目源码后，站不住的是本项目的表述而非对方的功能：
  - "从宿主外运行"不构成差异点：`dsh-plugin-reducer`、`dsh-canary`、`dsh-plugin-doctor`、
    `dsh-backup` 的 `dsh-rescue` bin、`zzy6-a/dsh-upgrade-guard` 的宿主外 supervisor 均在宿主之外运行；
  - README 中原作为立论开场的一句（"装在待测 profile 里的工具会在最需要它时一起失效"）
    出自 `dsh-plugin-gating-hub` 的 `README.zh.md:282`，现改为引用并署名；
  - "会尝试写回合"不唯一：`dsh-test-drive` 的 `capability` 阶段确实追加一轮并回读持久会话日志。
    仍然成立的是范围更窄的表述——无键、且作用于用户自身会话的迁移副本；
  - `dsh-canary` 被描述为提供 GitHub Action 与 `v1` 报告 schema，二者均不存在。
- `dsh-plugin-gating-hub` 的"启动失败隔离"表述改为准确形式：从启动日志点名肇事插件后禁用，
  不涉及启动耗时测量。
- 兼容性表按行分列实测与声明并标注日期，同时列出未验证项：Node 24.x 仅在 CI 验证、
  非 Windows 的 `run` 无真机预演、两条 `warn` 签名在本机从未命中。

### 新增

- `docs/FAILURE_MODES.md`：工具识别的每一条日志形态，有上游 issue 编号的就锚到编号
  （`#1229`、`#1294`），并写清"没命中"能排除什么、哪些在本机**根本复现不了**。
- 签名回归锁：每条形态必须命中抄自 issue 正文/真机产物的原文，且必须**不**命中健康行；
  另有一条断言要求"代码里检测的每个 id 都必须出现在那张表里"，否则文档与代码会各自漂移、
  无人察觉（`test/signatures.test.js`，测试数 52 → 57）。
- 本 `CHANGELOG.md` 与中文版 `CHANGELOG.zh.md`。
- `.github/workflows/release.yml`：由 tag 触发切 Release。**tag 不等于 `package.json`
  里的版本就停；本文件没有对应小节也停** —— 于是"说明"不可能事后补。它把打包 tarball
  和它的 `.sha256` 一起附上，固定到字节的安装行因此可核验，正文取下述对应小节。
- `SECURITY.md` 与 issue 模板：必填项是 `dsh` 版本、OS、Node、工具版本，外加隐私闸门 ——
  **报告与 issue 里都不许出现会话正文**。

### 修复

- `--help` / `-h` / `-V` / `--version` 会掉进"未知命令"分支并以 **`3`** 退出 ——
  而 `3` 正是本 README 定义的"彩排自身失败"。这个缺陷只在"`npm pack` → 装进临时前缀 →
  跑那个 bin"时暴露，跑源码 `node src/cli.js` 完全看不见。
- `v0.1.0` 作为 GitHub Release 发出去时**没有正文、没有附件**。它保持原样（历史不可变），
  本次建立起流水线，此后的 release 都会带正文与附件。

## [0.1.0] - 2026-10-02

首个公开版本。两条命令，一个结论：`check` 做静态体检，`run` 在一次性 `DSH_HOME` 里真彩排。

### 新增

- **`check --candidate <版本>`** —— 只读、零下载、秒级。活 profile 识别（绝不默认 `web`）、
  完整 patch 叠层解析（profile 层 + home 级 `cordis.patch.yml`）、`pnpm-lock.yaml` 取精确版本、
  会改变安装语义的 `pnpm-workspace.yaml` 策略，以及 peer 图：插件↔dsh、插件↔插件、
  `@deepseek-ai/cordis` 多 pin 冲突、枚举式 prerelease 范围（`^0.1.7-rc.2` 不匹配
  `0.2.0-rc.2`）、`link:` / `file:` / `github:` 不可复现依赖。
- **peer 发现按方向分级**：只有"今天满足、候选不满足"才是阻断性 `high`；两边都不满足记
  `pre-existing` —— 今天就已存在的错配不是本次升级引入的。
- **`run --to <版本>`** —— 把候选装进自己的私有 npm 前缀，冷启动两次，把你真实会话的副本
  拷进影子 home，在副本上触发惰性 `v0→…→v4` 迁移，做读侧完整性校验，然后用官方
  `@deepseek-ai/dsh-llm-replay` 尝试**一个无键写回合**。
- **三层互相独立的安全构造**：沙箱 `cwd` 重写（header 的 `cwd` 与编码后的工作区目录必须
  **成对**改）、按行 id 与包名前缀抑制工具提供方、以及对四种行形态做**只读允许清单**
  fail-closed 预筛（`tool/call`、`tool-call-chunks`、`tool/ptc-dispatch`、
  `tool/code-dispatch[·start]` —— 只扫第一种会静默漏掉整批工具）。
- **`dsh-rehearsal/v1` 报告**（`report.json` + `report.md`）：每阶段记录、固定的 `coverage` 节、
  顶层 `warnings[]`、说明剥掉了什么的 `privacy` 块，以及可机器判定的退出码
  `0` 可升 / `1` 带条件可升 / `2` 不可升 / `3` 彩排自身失败。
- **`--preset-mode patch`** 把带 agentPreset 的会话纳入演练（仅格式级结论，报告显式标注），
  采样策略为非预设层优先 + 预设层保底 1 个。
- CI：windows / macOS / linux × Node 22.19 与 24.x，外加"zstd API 必须存在"和
  "测试不得在 `$HOME` 留夹具影子 home"两条护栏断言。**CI 从不跑 `run`**。
- `publish.yml`：重新测试、把打包件装进临时前缀跑一遍 bin，然后 `npm publish --provenance`；
  缺少 `NPM_TOKEN` 时跳过该步骤而不报错。

### 修复

以下缺陷在 0.1.0 发布前的四轮评审中发现并修复。发布前缺陷保留记录，因为本工具的结论依赖其自身的安全声明可复核：

- 写回合**可能真的执行**会话历史里的工具调用 → 默认抑制 + fail-closed 只读允许清单（P0-1）；
- replay 的模型正文经 `stderr` 尾巴进报告 → 诊断白名单，并统计被丢弃的行数（P1-1）；
- evidence 对象没有递归脱敏 → 逐字符串处理（P1-2）；
- 含空格的 Windows 路径泄露尾巴：遮断规则在空格处停下，`D:\Work\a b\c.log` 变成
  `<abs-path> b\c.log`（P1-3）；
- 判定曾依赖退出码：**成功**的无键迁移会以 `MISSING_CREDENTIAL` 退出 1 → 改为只认产物；
- `node:zlib` 对多帧 zstd 静默只解第一帧（3.7 MB 读出 233 字节 / 1 行）→ 自带帧扫描；
- 按比例分层采样把非预设层从 9 挤到 3，剩下三个全被允许清单拦掉，而预设会话的写回合
  结构上不可判定 → 非预设优先 + 预设保底 1，并新增只在非预设轮上取结论的
  `writeRoundVerdict()`；
- `PATH` 上的桌面 shim 无视 `DSH_HOME`、会写坏真实 home（开发期真发生过）→
  只允许使用本工具自己装的候选二进制；
- 候选安装默认跑全部生命周期脚本 → 默认 `--ignore-scripts`，`--run-scripts` 显式解除。

### 关于测量口径

- README 的兼容性表写明验证过的候选版本与日期；它会自己变旧，每次发版都要重测。
- 覆盖率是**一台机器**在 2026-10-02 的实测：52 个会话 → 24 个可演练（46%）→
  5 个通过只读允许清单（占全库 9.6%）。迁移彩排覆盖广、写路径彩排覆盖窄，
  两者不能混着引用。

[Unreleased]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/wuwaka/dsh-rehearsal/releases/tag/v0.2.0
[0.1.0]: https://github.com/wuwaka/dsh-rehearsal/releases/tag/v0.1.0
