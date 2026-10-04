[简体中文](PUBLISHING.md) | [English](PUBLISHING.en.md)

# 发布清单

## 发布前

- [ ] `npm test` 全绿
- [ ] 工作树干净，`git status` 无意外文件
- [ ] `.dsh-rehearsal/`、`*.tgz`、`SHA256SUMS.txt` 未被跟踪（`.gitignore` 已覆盖）
- [ ] 跟踪文件中无凭据、无本机路径：`git grep -nE "<TOKENS>"`（`<TOKENS>` 由使用方自己填，理由见 [SECURITY.md](SECURITY.md) 的自查一节）
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
- [ ] 三条安装路径都能装出可执行的 bin：`npm install -g dsh-rehearsal`、`npm install -g github:<you>/dsh-rehearsal#vX.Y.Z`、tarball

## 仓库公开之后

- [ ] **npm 发布**：设置 `NPM_TOKEN` 后 `gh workflow run publish.yml --repo <you>/dsh-rehearsal --ref vX.Y.Z`。缺少该 secret 时任务跳过而不是报错。本机默认 registry 是只读镜像：发布走 CI，或显式加 `--registry`（说明见 [docs/MAINTAINING.md](docs/MAINTAINING.md)）。
- [ ] **topics**：`gh api repos/<you>/dsh-rehearsal -X PUT -f "topics[]=deepseek-harness" -f "topics[]=dsh" -f "topics[]=cli" -f "topics[]=upgrade" -f "topics[]=rehearsal"`。`dsh-plugin` 只作为检索入口，本仓库刻意不是 `dsh plugin add` 的 bundle。
- [ ] **目录投稿**：`awesome-dsh-plugin` 拒收外部 CLI。社区目录的调查、投稿状态与徽章时机见 [docs/MAINTAINING.md](docs/MAINTAINING.md)。
- [ ] `gh run list --repo <you>/dsh-rehearsal` 确认 CI 徽章可解析。

## 干净分支与历史

公开 `main` 由 `publish-clean` 推送，本地 `main` 是审计轨迹（记录在 `AUDIT.md`），没有 upstream，因此不会被误推。原因是本地历史含一个脱敏之前的快照，`git push` 推的是历史而不只是末端。

同步公开树时注意：`git checkout main -- .` **不会删除** `main` 上已删除的文件，曾因此把一个废弃脚本推上公开面。推送前必须过这道闸门：

```sh
git checkout -q publish-clean && git checkout main -- . && git add -A
git commit -m "Sync clean tree: …"
[ -z "$(git diff main publish-clean)" ] && echo "GATE OK" || echo "GATE FAIL: 不要推送"
```

维护者知识（目录投稿调查、仓库图片、文档治理、本机环境、新增签名的步骤）见 [docs/MAINTAINING.md](docs/MAINTAINING.md)。
