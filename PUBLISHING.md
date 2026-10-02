[简体中文](PUBLISHING.md) | [English](PUBLISHING.en.md)

# 发布检查清单

首次 `git push` 之前读一遍，每次发版前再读一遍。

## 历史中含脱敏前的快照

工作树与 `HEAD` 是干净的：全树 `git grep` 对用户路径返回 0 命中，脱敏测试负责维持这一点。

提交不可变，本地历史里仍有一个脱敏**之前**的快照：该提交在 5 个文件（`README.md`、
`AUDIT.md`、`src/lib/sessions.js`、`test/report.test.js`、`test/sessions.test.js`）中留有
13 处真实路径；更早的两个提交各含 2 处（`test/report.test.js` 里的合成夹具用户名）。

`git push` 推的是历史而不只是末端。因此用一个独立的干净分支发布，不要改写审计轨迹：

```sh
git checkout --orphan publish-clean
git add -A
git commit -m "dsh-rehearsal: static upgrade pre-flight + keyless session rehearsal"

# 校验后，把这个干净的树推成公开默认分支
git diff --stat main publish-clean          # 必须无输出（两棵树一致）
git ls-tree -r --name-only publish-clean    # 不含 .dsh-rehearsal/、node_modules/、夹具
git grep -nE "<TOKENS>" publish-clean --    # 用阅读者自己的用户名/盘符关键词；预期无输出
npm test                                    # 必须全绿
git remote add origin https://github.com/<you>/dsh-rehearsal.git
git push origin publish-clean:main
```

`main` 有意保留完整历史：它是审计轨迹，记录在 `AUDIT.md` 与 `FIXES.md`，且没有 upstream，
因此不会被误推。

### 同步 publish-clean

`git checkout main -- .` **不会删除** `main` 上已删除的文件；曾经有一个被废弃的脚本因此
进入公开树。拷贝之后需显式删除 `main` 已不再包含的文件，并把"两棵树一致"作为推送前的闸门：

```sh
git checkout -q publish-clean && git checkout main -- . && git add -A
git diff --stat main publish-clean          # 必须无输出
[ -z "$(git diff main publish-clean)" ] && echo "GATE OK" || echo "GATE FAIL: 不要推送"
```

## 产物永不入库

`.gitignore` 排除了 `.dsh-rehearsal/`，报告和预演输出都落在那里。报告已脱敏，但其中含有
本机的会话 id 与直方图形状，不应入库。`*.tgz` 与 `SHA256SUMS.txt` 同样被忽略：入库的校验
和会与 tag 实际指向的 tarball 失去对应关系。

## 切一个 release

`release.yml` 由 `v*` tag 推送触发，有两种情况会直接终止，因此顺序很重要：

```sh
npm test                                     # 必须全绿
# 1. 两份 CHANGELOG 都要改：CHANGELOG.md（英文）与 CHANGELOG.zh.md（中文）。
#    把 Unreleased 内容移入新的 "## [X.Y.Z] - YYYY-MM-DD" 小节（版本号与顺序保持一致，
#    test/changelog.test.js 断言成对），在文件底部加 [X.Y.Z] 链接，并更新 [Unreleased] 的 compare 区间。
# 2. package.json 的 "version" 必须精确等于 X.Y.Z，且在同一个提交里。
node scripts/release-notes.mjs vX.Y.Z        # 输出的就是 Release 正文
git add -A && git commit -m "…"
git tag -a "vX.Y.Z" -m "vX.Y.Z"
git push origin publish-clean:main           # 先让 CI 变绿
git push origin "vX.Y.Z"                     # 触发 Release job —— 这是对外可见动作
```

Release 正文由 tag 所在提交生成，中英双语并按固定顺序排列：中文（新增/修复/变更）→ 安装 →
`---` → 英文对应小节。任一份 changelog 缺少对应小节都会让任务失败，因此正文不可能事后凭记忆补写。

要重建一个已发布 tag 的正文或附件，使用 **Run workflow → `release.yml` → tag**，不要移动公开
tag：该 job 会检出 tag 本身，因此即便 `main` 上这份文件更新，`package.json` 与 changelog 仍取自
被 tag 的提交。

随后验证 release 确实带有它声称的东西：

```sh
gh release view "vX.Y.Z" --repo <you>/dsh-rehearsal \
  --json tagName,isDraft,isPrerelease,assets --jq '{tagName,isDraft,isPrerelease,assets:[.assets[].name]}'
# 预期：draft=false、isPrerelease=false（tag 含 `-` 时为 true），
#       assets = dsh-rehearsal-X.Y.Z.tgz + dsh-rehearsal-X.Y.Z.tgz.sha256
```

含 `-` 的 tag（例如 `v0.3.0-rc.1`）会自动标记 `--prerelease`，`publish.yml` 仍会尝试 npm
发布；若预发布不应占据 `latest` dist-tag，需传 `--tag next`。

## 仓库公开之后

1. **由 CI 发布到 npm。** `.github/workflows/publish.yml` 在 `release: published` 上运行，
   重新测试、把打包件装进临时前缀跑一遍可执行文件，然后 `npm publish --provenance`。缺少
   `NPM_TOKEN` 时它跳过而不是失败，因此没有该 secret 的仓库不会出现红色流水线：

   ```sh
   gh secret set NPM_TOKEN --repo <you>/dsh-rehearsal --body "<granular access token, Publish scope>"
   gh workflow run publish.yml --repo <you>/dsh-rehearsal --ref vX.Y.Z
   ```

   也可以从本机发布，但这台机器上有个陷阱：`~/.npmrc` 的默认 `registry` 是
   `registry.npmmirror.com`，一个只读镜像，对 `npm whoami` 返回 404 且不接受发布。要么用 CI，
   要么显式同时传入覆盖项：

   ```sh
   npm publish --registry https://registry.npmjs.org   # 需要该 registry 的 auth token
   ```

   2026-10-02 时 `dsh-rehearsal` 这个包名仍无人占用（registry 404）。社区有占名不发布的习惯，
   因此确认可发布时再占。
2. **设置 topics。** `gh api repos/<you>/dsh-rehearsal -X PUT -f "topics[]=deepseek-harness" -f "topics[]=dsh" -f "topics[]=cli" -f "topics[]=upgrade" -f "topics[]=rehearsal"`
   （topics 需要 `repo` scope）。`dsh-plugin` 只能作为检索入口添加：本仓库刻意不是
   `dsh plugin add` 的 bundle，README 头部已写明。不要让 topic 变成安装声明。

3. **不要向 `awesome-dsh-plugin/awesome-dsh-plugin` 投稿。** 2026-10-02 核实：其
   `scripts/check-submission.mjs:258-264` 要求仓库内某个 `package.json` 声明 `dsh.bundle`，
   只声明 `dsh.client` 会被以"that alone is not installable"拒绝。与本仓库同为外部 CLI 的
   `dsh-plugin-reducer` 与 `dsh-canary` 在其生成列表中同样 0 命中（4,412 条）。投稿会消耗一个
   CI 门槛的 PR，并因一条正确的规则被拒：出现在那里意味着本工具刻意不具备的可安装性。

   描述文件的键是白名单（`scripts/lib/entries.mjs:136`：`url, name, category, description,
   tarball, file`，未知键直接 CI 失败），可选的 `tarball` 必须是 https、GitHub Release 托管、
   以 `.tgz` 结尾 —— `release.yml` 附上的正是这个形状。

   适合收录的位置：
   - `walkinglabs/awesome-deepseek-harness-plugins` → `docs/INCLUSION_POLICY.md` 第 4 条：
     "It is a client, launcher, or development resource … placed outside the plugin categories
     and labelled accordingly."
   - `awesome-deepseekharness/awesome-deepseek-harness` → `CONTRIBUTING.md`，类别
     `🧩 Tools, Workflows & Presets`；该列表要求在同一位置同时插入 `README.md`（英文）与
     `README.zh.md`（中文）条目，示例 PR 标题为 `Add owner/repo to Category`。

   截至 2026-10-03，两处均未提交。

4. **有收录之后再加注册表徽章**（npm version/downloads、dshfind、marketplace）。提前添加的
   徽章会 404。`dsh-doctor` 的门禁徽章不适用：它的 R/K/D 门评分对象是 `dsh.bundle` 包，
   本仓库不声明该字段。
5. 首个 workflow 跑绿后，复核 README 头部的 CI 徽章可解析：`gh run list --repo <you>/dsh-rehearsal`。

## 容易被破坏的文档约束

- 所有文档均为双语对：`README.md` / `README.en.md`、`CHANGELOG.zh.md` / `CHANGELOG.md`、
  `SECURITY.md` / `SECURITY.en.md`、`PUBLISHING.md` / `PUBLISHING.en.md`、
  `docs/FAILURE_MODES.md` / `docs/FAILURE_MODES.en.md`。`test/docs.test.js` 会在缺失对开文件、
  两份的 `## ` 标题数不一致、语言切换行指向不存在的文件、或某条 `file:line` 引用只出现在
  一半时失败。
- 行文为陈述式且无第一人称：主张与出处相邻，不以警句替代机制，破折号克制，加粗只用于标识符
  与严重级别。用 `grep -c` 统计第一人称标记与 `——` 数量来验证，而不是靠目测。
- 有三处结论依赖测量，且会自行过期：
  - **兼容性表**分列实测与声明并写明验证日期，每次发版重测；
  - **覆盖率表**（可预演占比、通过允许清单占比）来自单机测量，重新发布要重新测，
    不要跨用户取平均或表述为普遍水平；
  - **同类对比表**描述的是别人的仓库，对方会不通知就变更。重复任何一格前先重读对方源码：
    对同类项目做出错误描述，正是这一节要避免的失败模式。
