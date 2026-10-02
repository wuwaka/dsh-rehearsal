# Changelog · 中文

格式：[Keep a Changelog](https://keepachangelog.com/zh-Hans/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。英文版是
[CHANGELOG.md](CHANGELOG.md)，两份文件的**版本小节必须一一对应**
（`test/changelog.test.js` 会断言这件事，`.github/workflows/release.yml` 缺任一份就拒绝发布）。

一个容易混的命名：下面的版本号是 **`dsh-rehearsal` 自己的**。`run --to <版本>` 里的那个版本号
是**被测 `dsh` 的**，永远不会出现在这里。

## [Unreleased]

暂无。

## [0.2.0] - 2026-10-02

文档与发布可核验性。`check` 与 `run` 的行为**没有任何改动**。

### 变更

- **撤回四条定位主张** —— 读完 7 个同类项目的源码之后，才发现站不住的是我们自己的说法，
  不是对方的功能。撤回留在历史里，因为这才是有意思的部分：
  - "从宿主外面跑"不是差异点：`dsh-plugin-reducer`、`dsh-canary`、`dsh-plugin-doctor`、
    `dsh-backup` 的 `dsh-rescue` bin、`zzy6-a/dsh-upgrade-guard` 的宿主外 supervisor 都在外面跑；
  - 我原本当作立论开场的"装在待测 profile 里的工具会在最需要它的时候一起死掉"，
    是 `dsh-plugin-gating-hub` README 里的**原话**，现已引用并署名；
  - "会尝试写回合"也不唯一 —— `dsh-test-drive` 的 `capability` 阶段真的追加一轮并回读持久会话日志。
    还站得住的是：**无键**、且打在**你自己的会话迁移副本**上；
  - `dsh-canary` 被我们安上了 GitHub Action 和 `v1` 报告 schema，它两个都没有。
- `dsh-plugin-gating-hub` 的"启动失败隔离"改成准确描述：从启动日志**点名**肇事插件后禁用，
  不是"测出谁拖慢启动"。
- 兼容性表按行拆开**实测**与**声明**，并给出日期，同时诚实承认：Node 24.x 那条腿只有 CI 验过、
  非 Windows 的 `run` 从未真机跑过、还有两条 `warn` 签名在本机从没命中过。

### 新增

- `docs/FAILURE_MODES.md`：工具识别的每一条日志形态，有上游 issue 编号的就锚到编号
  （`#1229`、`#1294`），并写清"没命中"能排除什么、哪些在本机**根本复现不了**。
- 签名回归锁：每条形态必须命中抄自 issue 正文/真机产物的原文，且必须**不**命中健康行；
  另有一条断言要求"代码里检测的每个 id 都必须出现在那张表里"，否则文档会静默腐烂成
  没人复核过的兼容性声明（`test/signatures.test.js`，测试数 52 → 57）。
- 本 `CHANGELOG.md` 与中文版 `CHANGELOG.zh.md`。
- `.github/workflows/release.yml`：由 tag 触发切 Release。**tag 不等于 `package.json`
  里的版本就停；本文件没有对应小节也停** —— 于是"说明"不可能事后补。它把打包 tarball
  和它的 `.sha256` 一起附上（社区目录的可选 `tarball` 键要求的正是这个形状：https、
  GitHub Release 托管、`.tgz` 结尾），正文取下述对应小节。
- `SECURITY.md` 与 issue 模板：必填项是 `dsh` 版本、OS、Node、工具版本，外加隐私闸门 ——
  **报告与 issue 里都不许出现会话正文**。

### 修复

- `--help` / `-h` / `-V` / `--version` 会掉进"未知命令"分支并以 **`3`** 退出 ——
  而 `3` 正是本 README 定义的"彩排自身失败"。这个缺陷只在"`npm pack` → 装进临时前缀 →
  跑那个 bin"时暴露，跑源码 `node src/cli.js` 完全看不见。
- `v0.1.0` 作为 GitHub Release 发出去时**没有正文、没有附件**。它保持原样（历史不可变），
  本次建立起流水线，之后的版本不可能再这么薄。

## [0.1.0] - 2026-10-02

首个公开版本。两条命令，一个结论：`check` 做静态体检，`run` 在一次性 `DSH_HOME` 里真彩排。

### 新增

- **`check --candidate <版本>`** —— 只读、零下载、秒级。活 profile 识别（绝不默认 `web`）、
  完整 patch 叠层解析（profile 层 + home 级 `cordis.patch.yml`）、`pnpm-lock.yaml` 取精确版本、
  会改变安装语义的 `pnpm-workspace.yaml` 策略，以及 peer 图：插件↔dsh、插件↔插件、
  `@deepseek-ai/cordis` 多 pin 冲突、枚举式 prerelease 范围（`^0.1.7-rc.2` 不匹配
  `0.2.0-rc.2`）、`link:` / `file:` / `github:` 不可复现依赖。
- **peer 发现按方向分级**：只有"今天满足、候选不满足"才是阻断性 `high`；两边都不满足记
  `pre-existing` —— 今天就已错配的不是这次升级的锅。
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
  没有 `NPM_TOKEN` 时自我跳过而不是报红。

### 修复

以下都是 0.1.0 发布**之前**四轮评审里找到的，列出来是因为"一个卖点是安全声明的工具
不该藏自己怎么翻车的"：

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

[Unreleased]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/wuwaka/dsh-rehearsal/releases/tag/v0.2.0
[0.1.0]: https://github.com/wuwaka/dsh-rehearsal/releases/tag/v0.1.0
