# DECISIONS

> 记录重要架构决策、技术选型理由和已接受的 Trade-off。
> 目的：防止 AI 在后续迭代中反复推翻已经确认的设计。

---

## D-001：零依赖纯 Node.js

**决策**：项目不引入任何第三方 npm 包，只使用 Node.js 原生模块（`http`、`fs`、`path`、`os`、`url`）。

**理由**：

- 本地工具，零依赖意味着安装即用，无供应链风险
- 避免依赖膨胀和版本冲突
- 核心功能（HTTP 服务器、文件操作、路径处理）Node.js 原生 API 已足够
- 减少 AI 在迭代中引入依赖相关 Bug 的风险

**Trade-off**：

- 部分功能需自己实现（如 CORS 处理、路由解析）
- 无成熟的工具链（如 ESLint / Prettier 需额外配置）
- 无内置 HTTP/2 支持（当前使用 HTTP/1.1）

**状态**：长期保持，V1.0 前不改变。

---

## D-002：异步 Job 模式

**决策**：所有耗时操作（Scan / Classify / Execute）使用统一异步 Job 模式：POST 创建 → 后台执行 → 轮询进度 → GET 结果。

**理由**：

- HTTP 是无状态的，长轮询是唯一可行的进度反馈机制
- 统一三种 Job 的轮询入口（`GET /api/job?type=scan|classify|execute&id=xxx`），前端只需一套轮询逻辑
- Job 状态机统一：queued → preparing → running → completed | partial | failed | cancelled | cancelled_partial

**Trade-off**：

- 客户端需要实现轮询逻辑（增加前端复杂度）
- 服务端需要维护 Job 状态 Map（内存存储，重启丢失）
- Job 数据不持久化（当前重启即丢失，60s 后自动清理）

**状态**：核心架构，V1.0 前不改变。Job 持久化可延后到 V1.0。

---

## D-003：服务端路径安全验证

**决策**：所有文件操作的路径安全在服务端强制验证，客户端无法绕过。

**验证链路**：

1. `scanId → sourceRoot`：扫描时存储在 `scanRootStore`
2. `planId → { scanId, sourceRoot, moves }`：生成计划时存储在 `planStore`
3. `execute` 只接受 `planId`（不接受 `body.plan` 后门）
4. 执行前对每个 move 调用 `checkMoveSafety(move, canonicalRoot)`：
   - source 必须在 root 内（`realpath` + `path.relative` 防前缀碰撞）
   - target 必须在 root 内（`canonicalizePathAllowMissing` 处理 `/var/folders` 符号链接）
   - 阻止 source/target 相同或子目录
   - 检查祖先目录的符号链接逃逸

**理由**：

- 信任边界在服务端：客户端永远不可信
- 即使前端被篡改或存在 XSS，也无法提交恶意路径
- 集成测试包含 traversal / source-outside-root / prefix-collision / symlink-escape 四类攻击向量

**Trade-off**：

- 增加了服务端代码复杂度（`checkMoveSafety` 约 55 行）
- `/var/folders` 等 macOS 符号链接路径需要特殊处理

**状态**：核心安全架构，不变。

---

## D-004：三级置信度模型

**决策**：分类置信度分为三级，而非连续百分比。

| 级别 | 阈值 | 含义 | 用户处理 |
|------|------|------|----------|
| 高可信 | ≥ 0.7 | 类型和主题都明确 | 可放心批量执行 |
| 建议确认 | 0.4–0.7 | 类型明确但主题不明确 | 建议快速浏览确认 |
| 需要判断 | < 0.4 | 类型或主题不明确 | 需要用户手动决定 |

**理由**：

- 连续百分比对用户没有 actionable 的区分度
- 三级制直接映射到 UI 行为（批量执行 / Review Queue / 手动处理）
- Review Queue 可以一键筛选"只看需要确认"的文件

**Trade-off**：

- 丢失了细粒度的置信度信息
- 阈值（0.4 / 0.7）是经验值，可能需要随用户反馈调整

**状态**：V0.3 已确定，不变。

---

## D-005：groupConfidence 与 confidence 解耦

**决策**：`groupConfidence`（项目分组置信度）与 `confidence`（建议置信度）是两个独立字段，互不覆盖。

**理由**：

- 项目分组是"这批文件是否属于同一项目"的判断
- 建议目标是"这个文件应该放到哪个目录"的判断
- 两者来源不同、含义不同，不应互相影响
- V0.3.3 之前 `groupConfidence` 会覆盖 `confidence`，导致高分组置信度的文件建议置信度被不合理地抬高

**Trade-off**：

- 增加了一个字段，UI 需要决定是否展示
- 前端需要处理两个置信度字段

**状态**：V0.3.3 已修复，长期保持。

---

## D-006：API Key 遮盖策略

**决策**：GET `/api/settings` 永远不返回完整 API Key，只返回 `apiKeyConfigured`（是否已配置）和 `apiKeyPreview`（前 4 后 4 字符，中间遮盖）。

**理由**：

- API Key 是敏感凭证，即使存储在本地也不应在 API 响应中完整暴露
- 前端需要知道 Key 是否配置（决定 UI 显示"已配置"还是"未配置"）
- `apiKeyPreview` 提供有限的可识别性（用户确认用的是哪个 Key）

**Trade-off**：

- 前端无法在设置页面显示完整 Key（需要用户自己记住）
- 保存时如果前端传空 Key，服务端保留原值（防覆盖）

**状态**：核心安全策略，不变。

---

## D-007：服务绑定仅 127.0.0.1

**决策**：HTTP 服务器只监听 `127.0.0.1`，不绑定 `0.0.0.0` 或局域网 IP。

**理由**：

- 本地文件整理工具，不需要网络访问
- 防止局域网或外部网络意外暴露
- CORS 仅允许 localhost 来源，双重防护

**Trade-off**：

- 无法从其他设备访问（但这不是目标场景）
- 远程调试需要 SSH 隧道

**状态**：核心安全策略，V1.0 前不改变。

---

## D-008：历史记录存储策略

**决策**：操作历史存储在用户主目录的私有文件（`~/.file-organizer/history.json`），上限 1000 条移动操作。

**理由**：

- 用户私有目录（`~/.file-organizer/`）具有合理的权限控制
- 操作历史需要持久化（跨会话撤销）
- 1000 条上限防止文件无限增长

**Trade-off**：

- 1000 条是移动操作数而非会话数，一个 500 文件的整理会话可能占用一半配额
- 历史文件可能被测试运行污染（V0.3.3 已修复 shift→pop 清理 bug）
- 会话清理策略是 FIFO（pop 末尾），不是 LRU

**状态**：V0.3.3 已修复清理方向 bug。上限值和清理策略可在后续版本评估调整。

---

## D-009：macOS 文件夹选择依赖 osascript

**决策**：文件夹选择对话框使用 macOS 原生 `osascript`，Windows / Linux 回退为手动路径输入。

**理由**：

- macOS 原生选择器体验最好（权限对话框、最近访问等）
- 跨平台原生选择器需要 Electron 或第三方库（引入依赖）
- 当前阶段目标是 Mac 可用，非跨平台

**Trade-off**：

- Windows / Linux 用户体验不完整
- 需要处理 osascript 超时和权限拒绝

**状态**：V1.0 前不改变。跨平台选择器列入 V0.5 路线图。

---

## D-010：GitHub Actions 自动化验收

**决策**：尚未配置 GitHub Actions。当前测试依赖手动执行 `npm run test:smoke` 和 `npm run test:integration`。

**理由**：

- 每轮开发后手动跑测试已可满足当前迭代节奏
- GitHub Actions 需要服务器进程管理（测试需要启动/停止服务器）
- 集成测试依赖本地文件系统（tmpdir），在 CI 环境需要额外配置

**Trade-off**：

- 无自动 PR 验收
- 无自动发布流程

**状态**：列入 V0.3.4 待办。需要先解决测试服务器生命周期管理问题。

---

## D-011：Trusted Plan 必须绑定 scanId

**决策**：`POST /api/plan` 必须携带有效 `scanId`，否则返回 400（无 scanId）或 404（scanId 不存在/已过期）。不允许创建 `sourceRoot = null` 但仍可 Execute 的 Plan。

**理由**：

- Trusted Plan 的安全意义在于：客户端无法绕过服务端验证
- 如果允许无 scanId 创建 Plan，客户端可以提交任意 `files` + `targetRoot`，绕过 Scan Session 的文件归属验证
- `scanId` 是连接「用户看到的文件」与「服务端信任的文件集合」的唯一纽带

**Trade-off**：

- 增加了 API 调用复杂度（前端必须在请求 Plan 时携带 scanId）
- 前端需要管理 scanId 生命周期（state.scanId）

**状态**：V0.3.4 已实施，长期保持。

---

## D-012：Target Root 限制在 Scan Root 内

**决策**：V0.3.4 暂时规定所有整理目标必须位于当前 Scan Root 内。允许用户指定 Scan Root 内的子目录（如 `Downloads/整理结果`），但不允许跨 Root 整理（如 `Downloads → /Users/me/Documents`）。

**理由**：

- 路径安全验证（`checkMoveSafety`）天然要求 target 在 canonical root 内
- 跨 Root 整理需要独立的 `trustedAllowedTargetRoot` 机制，当前未实现
- 产品层面，用户通常希望在同一文件夹内整理，而非移动到外部目录

**Trade-off**：

- 限制了部分高级使用场景（如"整理到另一个文件夹"）
- 未来如需支持，应通过 Folder Picker 建立可信目标根目录，而非信任用户输入的任意路径

**状态**：V0.3.4 已实施。跨 Root 整理列入 V0.4 评估。

---

## D-013：Session 生命周期采用 Idle TTL + Touch

**决策**：Scan Session 和 Plan Session 的过期策略从「固定 120s 创建即过期」改为「30 分钟 idle TTL + 每次有效操作 touch() 刷新」。

**理由**：

- 固定 120s 不适合真实用户：扫描大量文件 + 等待 AI + Review 数分钟 + 中途停顿，都可能超过 120s
- Idle TTL 更符合用户行为：用户停止操作后才清理，而非创建后固定时间
- `touch()` 机制简单可靠：每次 `/api/plan`（生成/重新生成）和 `/api/execute`（执行）都刷新

**Trade-off**：

- 内存中未清理的 Session 会占用更多内存（30min × 多个 Session）
- 测试时需要等待 30min 或注入短 TTL（当前测试直接调用 API，不等待过期）

**状态**：V0.3.4 已实施。`SESSION_IDLE_TTL = 30 * 60 * 1000`。

---

## D-014：Undo 状态四态贯通 History / UI

**决策**：`undoMoves` 返回的 `status`（`fully_reverted` / `partially_reverted` / `partial` / `failed`）必须保存到 History 的 `undoStatus` / `undoConflictCount` / `undoneAt` 字段，UI 必须区分展示。只有 `fully_reverted` 才等价于"完全撤销"。

**理由**：

- V0.3.3 之前 History 只用 `result.failed === 0` 判断是否撤销成功，丢失了 conflict 语义
- 用户需要知道撤销是"完全恢复"还是"部分恢复（有冲突）"
- `undone` 布尔字段仅作为 `fully_reverted` 的快捷判断，不替代详细状态

**Trade-off**：

- 增加了 History 的存储字段
- UI 需要处理更多状态标签

**状态**：V0.3.4 已实施。

---

## D-015：Plan Revision 模型（Last Write Wins）

**决策**：引入 `desiredRevision` / `appliedRevision` / `pendingRevision` 三段式状态模型，替代原有的 `planDirty` / `regenerating` 布尔标记。

**理由**：

- `planDirty` + `regenerating` 无法区分"用户修改了但请求还没发出"和"请求已发出但还没返回"
- 连续快速修改时，旧请求可能覆盖新请求（stale write）
- Revision 模型精确追踪：用户最新意图（desired）→ 正在请求（pending）→ 已应用（applied）

**规则**：

```
每次影响最终 Plan 的用户修改 → desiredRevision++
                            → 如果无 pending 请求，启动 regenerate
                            → 如果有 pending 请求，不发新请求（记录 superseded）

请求返回后：
  requestRevision === desiredRevision → 接受，appliedRevision = requestRevision
  requestRevision <  desiredRevision → 丢弃 stale 响应，立即补发
```

**Trade-off**：

- 增加了状态复杂度（3 个 revision 字段 vs 2 个布尔标记）
- 前端需要正确处理 stale 响应丢弃逻辑

**状态**：V0.3.5 已实施。

---

## D-016：Browser E2E 必须监听 Runtime Error

**决策**：Playwright E2E 测试必须监听 `pageerror`、console error 和 failed network request。任何异常即测试失败。

**理由**：

- V0.3.4 之前：Engine + API + 83 个 Node 测试全绿，但用户点击按钮后 Browser Runtime Error（`moves is not defined`）
- 只有真实浏览器才能捕获 Node 环境无法发现的 Runtime Error
- 这类错误是发布阻断级的，必须自动拦截

**Trade-off**：

- E2E 测试比 Node 测试慢（需要启动浏览器）
- 需要处理 UI overlay 遮挡等浏览器特有问题

**状态**：V0.3.5 已实施，14/14 E2E 测试通过，0 Runtime Error。

---

## D-017：Session Idle TTL 可测试化

**决策**：`SESSION_IDLE_TTL` 从硬编码常量改为环境变量覆盖（`SESSION_IDLE_TTL_MS`），默认 30 分钟，测试使用 500ms。

**理由**：

- 30 分钟 TTL 无法在测试中真实验证（需要等待 30 分钟）
- 环境变量覆盖允许测试使用短 TTL，真实验证 touch 延长和 idle 过期行为
- 不影响生产环境默认值

**Trade-off**：

- 增加了一个环境变量
- 测试需要启动独立服务器实例（使用不同端口）

**状态**：V0.3.5 已实施，5/5 Session TTL 测试通过。

---

## D-018：Target Root 前端校验

**决策**：Target Root 输入框增加前端校验，用户输入的路径必须在 Scan Root 内，否则立即提示。服务器端安全检查仍然保留。

**理由**：

- V0.3.4 架构决策已明确"所有目标必须在 Scan Root 内"
- 如果只在服务端校验，用户要等到 Execute 时才能看到 403 错误
- 前端校验提供即时反馈，改善用户体验

**Trade-off**：

- 前端校验不能替代服务器校验（恶意用户可绕过）
- 增加了前端代码复杂度

**状态**：V0.3.5 已实施。前端校验 + 服务器 `checkMoveSafety` 双重保障。

---

## D-019：V0.3.5.1 — Revision 状态机统一收口

**决策**：将 Plan Revision 的所有状态变更收口到三个函数，避免多处手工修改 `desiredRevision` / `appliedRevision` / `pendingRevision`。

| 函数 | 职责 | 调用方 |
|------|------|--------|
| `markPlanChanged()` | 用户修改 Plan，增加 desiredRevision，触发同步 | 所有用户操作（Edit/Exclude/Restore/Target change） |
| `completePlanRevision()` | 接受新 Plan，更新 appliedRevision | `handlePlanResponse()` |
| `failPlanRevision()` | Plan 更新失败，清除 pending，保留旧 Plan | `regenerateLatestPlan()` catch |

**理由**：

- 原始 `regeneratePlan()` 同时承担"用户修改"和"内部同步"两个职责，导致 stale response 重试时错误增加 desiredRevision
- Empty Plan 路径直接调用 `applyPlanResponse()` 绕过 `handlePlanResponse()`，导致 `pendingRevision` 残留
- 统一收口后，所有路径（HTTP / Empty / Error / Cancel）都经过 `handlePlanResponse()`，状态机一致

**Trade-off**：

- 增加了函数数量（从 3 个增加到 7 个）
- `markPlanChanged()` 和 `regenerateLatestPlan()` 的调用方需要明确区分

**状态**：V0.3.5.1 已实施。

---

## D-020：V0.3.5.1 — Server 端 Target Root 相对路径解析

**决策**：`handlePlan` 中如果 `options.targetRoot` 是相对路径，相对于 `sourceRoot` 解析为绝对路径。

**理由**：

- 前端只接受相对子目录名（如"整理结果"），不发送绝对路径
- 服务器必须将相对路径解析为绝对路径，否则 `checkMoveSafety` 无法正确校验
- 解析在 `handlePlan` 中进行，`organizer.generatePlan()` 始终收到绝对路径

**Trade-off**：

- 前后端对 targetRoot 的语义理解必须一致（前端=相对子目录，服务器=绝对路径）

**状态**：V0.3.5.1 已实施。

---

## D-021：V0.3.5.1 — 统一 Test Runner

**决策**：创建 `test/run-with-server.js`，统一管理 server 生命周期（spawn → wait ready → run tests → kill）。

**理由**：

- 原有测试脚本假设 server 已由人工启动，CI 环境无法保证
- `npm test` 应该在干净环境中自动完成全部工作
- 统一 runner 确保 server 始终被清理（包括测试失败时）

**Trade-off**：

- 增加了测试基础设施的复杂度
- `session-ttl.js` 仍独立启动 server（因为它需要测试 TTL 行为本身）

**状态**：V0.3.5.1 已实施。

---

## D-022：V0.4.0 — Content Extractor 独立模块

**决策**：内容提取逻辑独立为 `engine/content-extractor.js` 模块，不直接嵌入 classifier。

**理由**：

- 分类器应关注"如何分类"，内容提取关注"如何读取和解析"
- 独立模块便于扩展新格式（docx / pdf 等）
- 便于独立测试内容提取逻辑

**接口**：

```javascript
extract(file) → {
  success,        // boolean
  extractor,      // string: 'plain' | 'markdown' | 'json' | 'csv' | 'tsv' | 'skip'
  metadata,       // object: 格式相关的元数据
  textPreview,    // string: 前 500 字符预览
  truncated,      // boolean: 是否超过最大字符限制
  error           // string | null
}
```

**Trade-off**：

- 增加了模块数量
- classifier 需要调用 content-extractor，增加了一次函数调用开销

**状态**：V0.4.0 已实施。

---

## D-023：V0.4.0 — 内容辅助分类触发条件

**决策**：仅对低置信度文件（confidence < 0.6 或 contentTheme === '默认'）读取内容。

**理由**：

- 高可信文件（如 .jpg → image）不需要内容辅助
- 避免无差别读取全部文件，符合"不无差别读取全部文件"原则
- 资源限制（1MB / 8000 字符）确保内容读取不会影响性能

**Trade-off**：

- 有些低置信度文件的内容可能仍然不足以提升分类（如无主题线索的纯文本）
- 极少数情况下，高置信度文件可能因内容而需要调整分类

**状态**：V0.4.0 已实施。