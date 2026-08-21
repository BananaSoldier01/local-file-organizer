# 本地文件智能整理器

> V0.4.0 · Content-Aware Organization · 个人测试项目。

一个本地运行的文件整理工具。扫描指定文件夹，多维理解文件内容，生成可编辑的整理方案，经确认后执行移动操作。所有操作可撤销。

## 它帮你回答三个问题

1. **我这个文件夹现在是什么状况？** — 扫描后告诉你文件总数、总大小、目录数、有多少需要关注的文件。
2. **你准备怎么帮我整理？** — 每个文件给出：类型判断、内容主题、建议目标目录、置信度、风险标记。你可以逐个修改。
3. **我敢不敢按下执行？** — 执行前显示完整移动清单，可排除任意文件，可撤销。

## 隐私与安全

- **本地优先**：所有文件操作在本机执行，不上传任何文件
- **AI 数据**：仅发送文件名、扩展名、目录名给 LLM API，不发送文件内容
- **API Key**：存储在 `~/.file-organizer/settings.json`，GET 接口遮盖显示（`sk-••••••••••8F2A`）
- **服务绑定**：仅监听 `127.0.0.1`，不暴露给外部网络
- **CORS**：仅允许 `localhost` 来源
- **操作历史**：存储在 `~/.file-organizer/history.json`（私有目录）
- **撤销**：所有移动操作可逆，撤销后自动清理空目录

## 分类模型

不同于传统的单层分类，本项目使用多维模型：

| 维度 | 说明 | 示例 |
|------|------|------|
| 文件类型 | 客观，由扩展名决定 | 文档 / 图片 / 视频 / 代码 / 安装包 / … |
| 内容主题 | 由文件名和目录名推断 | 项目A / 财务 / 个人照片 / 技术文档 / … |
| 风险标记 | 标记需要关注的文件 | 敏感 / 大文件 / 临时 / 无扩展名 / 疑似重复 |
| 建议目标 | 综合判断后建议放入的目录 | 项目A / 财务 / 图片 / … |
| 置信度 | 三级制：高可信 / 建议确认 / 需要判断 | 见下方说明 |

这些维度互相独立。一个 PDF 可以是「文档 + 项目A + 敏感」。

### 置信度三级制

| 级别 | 含义 | 用户应如何处理 |
|------|------|--------------|
| 高可信 | 类型和主题都明确 | 可放心批量执行 |
| 建议确认 | 类型明确但主题不明确 | 建议快速浏览确认 |
| 需要判断 | 类型或主题不明确 | 需要用户手动决定 |

## 功能

- **扫描**：异步 Job，真实进度报告（preparing → scanning → analyzing → completed）
- **理解**：基于扩展名 + 文件名 + 目录名进行多维分类，可选 AI 语义分析
- **AI 分批分析**：每批 20 个文件，单批失败不影响其他批次，支持 500+ 文件
- **项目分组**：识别可能属于同一项目的文件组
- **方案**：生成整理方案，每个文件可单独修改目标目录和主题
- **Review Queue**：按置信度分级，可一键筛选"只看需要确认"的文件
- **执行**：安全移动，冲突处理（跳过/重命名），跨驱动器自动使用复制+删除
- **撤销**：完整操作历史，支持一键撤销，自动清理空目录

## 使用

```bash
./start.sh
```

或手动启动：

```bash
node server.js
```

然后在浏览器中访问 `http://localhost:38211`。

> ⚠️ 文件夹选择依赖 macOS `osascript`，当前仅支持 Mac。Windows/Linux 可手动输入路径。

## 技术栈

- Node.js HTTP 服务器（零依赖）
- 原生 fs 模块
- 纯 HTML/CSS/JS（无框架）

## V0.3.5 变化（UI Runtime & Race Hardening）

核心原则：**What you review is exactly what gets executed.**

- **Plan Revision 模型**：`desiredRevision` / `appliedRevision` / `pendingRevision` 三段式状态，Last Write Wins
- **Regenerate Race 修复**：stale 响应自动丢弃，立即补发最新 revision；连续快速修改最终状态正确
- **Execute Revision Guard**：仅在 `appliedRevision === desiredRevision && pendingRevision === 0` 时可点击
- **Execute 稳定快照**：执行期间使用 `executePlanId` / `executeRevision` 不可变引用，不依赖 mutable state
- **Browser E2E（Playwright）**：真实浏览器覆盖 Scan → Review → Edit → Exclude → Execute → Undo 完整主路径
- **Runtime Error 监听**：E2E 监听 `pageerror` / console error / failed network request，任何异常即测试失败
- **Session Idle TTL 可测试化**：`SESSION_IDLE_TTL_MS` 环境变量覆盖，默认 30min，测试用 500ms
- **Session TTL 自动测试**：touch 延长生命周期 + idle 后过期，5/5 通过
- **Target Root UI 收紧**：标签改为"整理到当前文件夹下"，前端校验目标必须在 Scan Root 内
- **duplicate classifyCancel 清理**：删除旧版 `{ classifyId }` 实现，统一使用 `{ id: classifyId }`
- **path.dirname 补全**：Browser 环境 `path` 对象新增 `dirname` 方法，修复 `path.dirname is not a function`
- **showState('done') 修复**：执行完成后正确切换到 Done 状态
- **GitHub Actions CI**：`.github/workflows/test.yml` 自动运行全部测试
- **测试总数**：114/114 通过（smoke 11 + integration 43 + scenario 41 + e2e 14 + session-ttl 5）

## V0.3.5.1 变化（Exit Hotfix）

- **Target Root Runtime 修复**：Browser `path` helper 新增 `resolve()` 方法，修复 `path.resolve is not a function`；UI 收紧为"整理到当前文件夹下"，只接受相对子目录名，拒绝绝对路径 / `..` / 空转义
- **Server 端 targetRoot 解析**：`handlePlan` 将相对 targetRoot 相对于 sourceRoot 解析为绝对路径，确保路径安全检查通过
- **Revision 状态机统一**：拆分 `markPlanChanged()`（用户修改，增加 desiredRevision）与 `regenerateLatestPlan()`（内部同步，不增加 desiredRevision）；所有 Plan 响应收口到 `handlePlanResponse()`，Empty Plan / HTTP / Error / Cancel 路径统一走 `completePlanRevision()` / `failPlanRevision()`
- **Exclude All → Restore 修复**：Empty Plan 路径不再绕过 `handlePlanResponse()`，`pendingRevision` 始终被正确清除，Restore 后 Plan 正常更新
- **Plan Failure Recovery**：新增 `failPlanRetry()` + `retryPlanGeneration()`，Plan 更新失败后保留旧 Plan、显示错误 Toast + 重试按钮，Retry 不增加 desiredRevision
- **统一 Test Runner**：`test/run-with-server.js` 自动 spawn/kill server，`npm test` 可在干净环境运行全部测试
- **Browser E2E 新增**：Last Write Wins Race（Playwright route 延迟注入）+ Target Root E2E，共 24/24 通过
- **测试总数**：117/117 通过（smoke 11 + integration 43 + scenario 41 + e2e 24 + session-ttl 5）

## V0.4.0 变化（Content-Aware Organization）

核心目标：让文件整理从"基于文件名/扩展名判断"升级为"基于有限内容理解判断"。

- **Content Extractor 统一接口**：`engine/content-extractor.js`，提供 `extract(file)` → `{ success, extractor, metadata, textPreview, truncated, error }`
- **资源限制**：单文件最大读取 1MB，最大提取字符 8000，超大文件自动跳过，不支持格式自动降级
- **第一批支持格式**：txt / md / json / csv / 常见源码文件（.js/.ts/.py/.java/.html/.css 等）
- **Content-aware Classification**：低置信度文件（confidence < 0.6）才读取内容辅助判断；高可信文件不读取内容
- **Content Evidence 展示**：Workspace 行 tooltip 显示分类依据（内容提取方式、推断主题、标题/JSON键/CSV表头等）
- **Security Regression Tests**：../ 越界 / 绝对路径 / 符号链接逃逸 / 外部文件注入，全部被拒绝
- **API Contract Regression**：scanId → classifyId → planId → execId → sessionId 字段连续性验证
- **Evaluation System**：`test/evaluation.js` 对比 metadata-only vs content-aware 分类准确率
- **测试总数**：126/126 通过（smoke 11 + integration 67 + scenario 41 + e2e 24 + session-ttl 5 + evaluation 9）

## V0.3.4 变化（Plan Integrity & Interaction Consistency）

核心原则：**What you review is exactly what gets executed.**

- **Trusted Plan 生命周期**：`state.scanId` / `state.planId` 进入正式 state，newScan / leave workspace 时完整清理
- **regeneratePlan 原子更新**：始终携带可信 `scanId`，`plan` + `planId` 同时替换；失败时保留上一份有效 Plan
- **Exclusion 进入 Trusted Plan**：排除/恢复操作后自动触发 `regeneratePlan`，被排除文件从服务器 Plan 中移除
- **Execute Consistency Guard**：`planDirty` / `regenerating` 状态锁，Plan 更新期间 Execute 按钮禁用
- **`/api/plan` 强制 scanId**：无 `scanId` 返回 400，`scanId` 不存在/已过期返回 404
- **文件归属验证**：服务器保留 Scan Session 的 `fileSet`，拒绝注入未扫描到的外部文件
- **Session 生命周期**：从固定 120s 改为 30 分钟 idle TTL + `touch()` 刷新，支持用户 Review 期间长时间停顿
- **Classify Cancel 协议修复**：`handleClassifyCancel` 改用 `readBody` 读取 `{ id }`，清理重复路由
- **Target Root 语义统一**：所有目标必须在 Scan Root 内；Organizer 实际使用 `targetRoot` 生成目标路径
- **validatePlan 误报修复**：circular 检查仅对源是目录时生效，不再误报普通文件整理
- **Undo 状态贯通**：History/UI 保存 `undoStatus` / `undoConflictCount` / `undoneAt`，区分完全撤销/部分恢复/冲突/失败
- **场景测试**：`npm run test:scenario` 29/29 通过，覆盖 Edit→Execute / Exclude→Execute / Restore→Execute / Plan Without ScanId / Foreign File Injection / Session Lifecycle / Classify Cancel / Undo Conflict

## V0.3.3 变化（基础设施整改）

- **受信 plan 链路**：`scanId → planId → sourceRoot` 服务端映射，客户端无法绕过
- **路径安全**：`realpath` + `path.relative` 前缀碰撞防护，拒绝 `../` 逃逸、符号链接逃逸、源文件在 root 外
- **统一取消协议**：Classify / Execute 取消统一使用 `{ id }` body 协议
- **撤销语义修复**：`undoMoves` 返回 `fullyReverted` / `partially_reverted` / `partial` / `failed` 四态
- **groupConfidence 解耦**：分组置信度与建议置信度分离，不再互相覆盖
- **历史清理 bug 修复**：`saveHistory` 数组最新在前，清理时用 `pop()` 删最旧记录（原 `shift()` 误删最新记录）
- **集成测试**：`npm run test:integration` 43/43 通过，覆盖 Scan/Classify/Plan/Execute/Cancel/Security/Undo/Settings/History

## V0.3.2 变化（Correctness & Safety）

- **Scan 真实进度**：修复 `countDirs` 未调用导致 `totalDirs=0`，现在显示真实目录遍历进度
- **Classify 异步 Job**：分批处理（20 批次），单批失败不影响其他批次，支持 cancel/partial
- **统一轮询入口**：`GET /api/job?type=scan|classify|execute&id=xxx`，删除双轮询和硬超时
- **Execute 可信 planId**：服务器保存 `planId → sourceRoot` 映射，客户端不再提交任意路径
- **服务端路径验证**：`realpath` 越界检查，拒绝 `../` 和符号链接逃逸
- **Execute Cancel 接入 UI**：执行中可取消，`cancelled_partial` 状态
- **AI 隐私全面脱敏**：fileList / context.dirs / project grouping 均不发送绝对路径
- **Execute Job 类型修复**：`failedCount`/`skippedCount`（数值）与 `failed[]`/`skipped[]`（数组）分离
- **API Key 防覆盖**：`maskSettings` 始终删除 `apiKey` 字段，GET 只返回 `apiKeyConfigured`/`apiKeyPreview`
- **集成测试**：`npm run test:integration` 43/43 通过，覆盖 Scan/Classify/Plan/Execute/Cancel/Security/Undo/Settings/History

## V0.3.1 变化（Release Hardening）

- **Execute 改为异步 Job**：POST 创建 → 后台执行 → 轮询进度 → 完成/部分/失败/取消
- **真实进度**：Scan 和 Execute 均不再模拟进度，显示真实计数
- **Execute 可取消**：cancelled_partial 状态，已完成部分可 Undo
- **API Key 防覆盖**：GET settings 不返回真实 Key，save 未提供新 Key 时保留原值
- **AI 隐私**：LLM prompt 只发送内部 ID + 目录名，不发送绝对路径
- **服务绑定**：仅监听 127.0.0.1，CORS 仅允许 localhost
- **Smoke Test**：`npm run test:smoke` 自动检查 DOM/JS/HTML 一致性
- **状态重置**：newScan 完整重置 selectedFiles/filters/projectGroups

## V0.3 变化

- 扫描从同步改为异步 Job，真实进度轮询
- 选中/排除状态彻底分离
- 置信度从连续百分比改为三级制
- 新增 Review Queue 和筛选芯片
- AI 分类改为分批处理，不再因文件数量关闭 AI
- 安全边界收紧（CORS / localhost / API Key 遮盖）

## 项目文档

除本 README 外，项目维护以下长期文档：

| 文档 | 用途 |
|------|------|
| [`COLLAB_WORKFLOW.md`](COLLAB_WORKFLOW.md) | AI 协同开发流程（Builder / Reviewer / Product Owner 角色与循环） |
| [`ROADMAP.md`](ROADMAP.md) | 版本路线图：当前阶段、后续版本、长期方向 |
| [`DECISIONS.md`](DECISIONS.md) | 重要架构决策与 Trade-off，防止后续迭代推翻已确认设计 |
| [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) | 已知问题清单，含延后原因和计划版本 |

## 路线图

- [x] 多维分类模型
- [x] 单工作区交互
- [x] 可编辑整理方案
- [x] 执行 + 撤销
- [x] AI 分批分析（支持 500+ 文件）
- [x] 项目分组
- [x] Review Queue
- [x] 真实扫描进度
- [x] 选中/排除状态分离
- [x] 安全边界（CORS / localhost / API Key 遮盖）
- [ ] 批量操作（反选/恢复排除）
- [ ] 重复文件检测
- [ ] 规则自定义
- [ ] 跨平台文件夹选择
- [ ] Electron 桌面封装
- [ ] Content Extractor（PDF/DOCX/PPTX/XLSX 内容理解）