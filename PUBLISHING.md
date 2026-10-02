[简体中文](PUBLISHING.md) | [English](PUBLISHING.en.md)

# 发布清单

## 发布前

- [ ] `npm test` 全绿
- [ ] 工作树干净，`git status` 无意外文件
- [ ] `.dsh-rehearsal/`、`*.tgz`、`SHA256SUMS.txt` 未被跟踪（`.gitignore` 已覆盖）
- [ ] 跟踪文件中无凭据、无本机路径：`git grep -nE "<TOKENS>"`（token 由使用方自己填，写进文档的那条命令会在文档自身命中）
- [ ] README 与两份 CHANGELOG 已更新

## 版本

- [ ] `package.json` 的 `version` = `X.Y.Z`
- [ ] `CHANGELOG.md` 与 `CHANGELOG.zh.md` 各新增 `## [X.Y.Z] - YYYY-MM-DD` 小节，内容对应、顺序一致
- [ ] 两份 changelog 底部的 `[X.Y.Z]` 链接与 `[Unreleased]` compare 区间已更新

`test/changelog.test.js` 断言：两份版本小节同名同序、每个发布小节带日期、最新小节号等于 `package.json` 版本。

## 打 tag 与推送

```sh
npm test
node scripts/release-notes.mjs vX.Y.Z     # 输出的就是 Release 正文
git add -A && git commit -m "…"
git tag -a "vX.Y.Z" -m "vX.Y.Z"
git push origin publish-clean:main        # 先等 CI 绿
git push origin "vX.Y.Z"                  # 触发 Release job，这是对外可见动作
```

`release.yml` 有两种情况直接终止：tag 与 `package.json` 版本不一致；任一份 changelog 缺对应小节。含 `-` 的 tag 自动标记 `--prerelease`，此时 `publish.yml` 仍会尝试 npm 发布，若不希望占据 `latest` dist-tag 需传 `--tag next`。

要重建已发布 tag 的正文或附件，用 **Run workflow → `release.yml` → tag**，不要移动公开 tag：该 job 检出 tag 本身，`package.json` 与 changelog 仍取自被 tag 的提交。

## 验证 release

```sh
gh release view "vX.Y.Z" --repo <you>/dsh-rehearsal \
  --json tagName,isDraft,isPrerelease,assets --jq '{tagName,isDraft,isPrerelease,assets:[.assets[].name]}'
```

- [ ] `draft=false`，`isPrerelease` 与 tag 形态一致
- [ ] 附件为 `dsh-rehearsal-X.Y.Z.tgz` 与 `.tgz.sha256`
- [ ] 下载后 `sha256sum -c` 通过
- [ ] `npm install -g github:<you>/dsh-rehearsal#vX.Y.Z` 与 tarball 两条安装路径都能装出可执行的 bin

## 仓库公开之后

- [ ] **npm 发布**：设置 `NPM_TOKEN` 后 `gh workflow run publish.yml --repo <you>/dsh-rehearsal --ref vX.Y.Z`。缺少该 secret 时任务跳过而不是报错。
      本机 `~/.npmrc` 默认 registry 是只读镜像，对 `npm whoami` 返回 404 且不接受发布，因此发布走 CI，或显式加 `--registry https://registry.npmjs.org`。
- [ ] **topics**：`gh api repos/<you>/dsh-rehearsal -X PUT -f "topics[]=deepseek-harness" -f "topics[]=dsh" -f "topics[]=cli" -f "topics[]=upgrade" -f "topics[]=rehearsal"`。`dsh-plugin` 只作为检索入口，本仓库刻意不是 `dsh plugin add` 的 bundle。
- [ ] **不要向 `awesome-dsh-plugin` 目录投稿**：其 `scripts/check-submission.mjs:258-264` 要求某个 `package.json` 声明 `dsh.bundle`，只声明 `dsh.client` 亦被拒。同为外部 CLI 的 `dsh-plugin-reducer`、`dsh-canary` 在该目录 4,412 条中 0 命中。适合的位置是工具类目录：`walkinglabs/awesome-deepseek-harness-plugins` 的 `docs/INCLUSION_POLICY.md` 第 4 条，以及 `awesome-deepseekharness/awesome-deepseek-harness` 的 `CONTRIBUTING.md`（🧩 Tools）。两处截至 2026-10-03 均未提交。
- [ ] 有收录之后再加注册表徽章；`dsh-doctor` 的门禁徽章不适用（其 R/K/D 门评分 `dsh.bundle` 包）。
- [ ] `gh run list --repo <you>/dsh-rehearsal` 确认 CI 徽章可解析。

## 图片与社交预览

- `assets/poster.jpg`（1774×887，233 KB）是两份 README 顶部的海报，写法沿用 `wuwaka/dsh-clipboard-menu`：`<div align="center">` 内第一行 `<img src="assets/poster.jpg" width="620" alt="…">`，alt 写成一句可核对的描述。邻居 `dsh-plugin-gating-hub` 用 `width="1170"`；620 之下海报上的中文副标题偏小，要放大改这一个数字。
- `assets/social-preview.jpg`（1280×640，153 KB）用于仓库社交预览图，在 Settings → General → Social preview 手动上传。这一步没有接口：2026-10-03 核过 REST 的 repo 对象没有 social preview 字段。它决定仓库链接被分享或展开时显示的图，不影响 GitHub 搜索结果列表。
- 两个文件从同一张源图再生（源图 1.88 MB，不入库）：

  ```sh
  python - <<'PY'
  from PIL import Image
  src = Image.open('poster-source.png').convert('RGB')          # 1774x887, 2:1
  src.save('assets/poster.jpg', quality=88, optimize=True, progressive=True)
  src.resize((1280, 640), Image.LANCZOS).save(
      'assets/social-preview.jpg', quality=90, optimize=True, progressive=True)
  PY
  ```

- 相对路径图片在 npm 包页面通常解析不了，海报预期只在 GitHub 生效。此点未实测（包尚未发布），发布后需复核。

## 干净分支与历史

公开 `main` 由 `publish-clean` 推送，本地 `main` 是审计轨迹（记录在 `AUDIT.md`），没有 upstream，因此不会被误推。原因是本地历史含一个脱敏之前的快照，`git push` 推的是历史而不只是末端。

同步公开树时注意：`git checkout main -- .` **不会删除** `main` 上已删除的文件，曾因此把一个废弃脚本推上公开面。推送前必须过这道闸门：

```sh
git checkout -q publish-clean && git checkout main -- . && git add -A
git commit -m "Sync clean tree: …"
[ -z "$(git diff main publish-clean)" ] && echo "GATE OK" || echo "GATE FAIL: 不要推送"
```

## 文档约束

- 每份文档都是双语对：`README`、`CHANGELOG`、`SECURITY`、`PUBLISHING`、`AUDIT`、`docs/architecture`、`docs/FAILURE_MODES`。`test/docs.test.js` 在对开缺失、`## ` 小节数不一致、`file:line` 引用集合不同、issue 号或提交哈希不同、语言切换行指向不存在的文件、或文档退回第一人称时失败。
- 行文为陈述式且无第一人称，主张与出处相邻。用 `grep -c` 统计第一人称标记与 `——` 数量来验证，不靠目测。
- 三处结论依赖测量，会自行过期：兼容性表（分列 Tested 与声明，注明日期，每次发版重测）、覆盖率表（单机数字，重新发布要重测，不跨用户取平均）、`docs/architecture.md` 里的同类工具分工表（描述的是别人的仓库，重复任何一格前先重读对方源码）。
