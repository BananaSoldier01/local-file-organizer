# ROADMAP

> 最后更新：V0.4.2

---

## 当前阶段：V0.4.2 — File Relationship Intelligence 🔄

V0.3.5.1 收尾 V0.3.x 基础设施阶段，修复最后几个 Runtime / Revision / CI / E2E 真实性问题。

### V0.3.5.1 完成项

- Target Root `path.resolve` Runtime Bug 修复 + UI 收紧
- Exclude All → Restore Revision Deadlock 修复
- Revision 状态机统一收口（markPlanChanged / completePlanRevision / failPlanRevision）
- Plan Failure Recovery（Toast + Retry，不增加 desiredRevision）
- 统一 Test Runner（test/run-with-server.js）
- Browser E2E 新增：Last Write Wins Race + Target Root E2E
- GitHub Actions CI 配置（无需人工启动 Server）

### V0.3.x Final Exit Criteria：全部 PASS ✅

---

## 当前阶段：V0.4.0 — Content-Aware Organization 🔄

### V0.4.0 完成项

- Content Extractor 统一接口（`engine/content-extractor.js`）
- 第一批支持格式：txt / md / json / csv / 源码文件
- Content-aware Classification（低可信才读内容）
- Content Evidence 展示（Workspace tooltip）
- Security Regression Tests（../ 越界 / 绝对路径 / 符号链接逃逸 / 外部注入）
- API Contract Regression（字段连续性验证）
- Evaluation System（metadata-only vs content-aware 对比）

### V0.4.0 验收标准

1. Content Extractor 有统一接口 ✅
2. 分类流程支持内容辅助判断 ✅
3. 内容读取有资源限制 ✅
4. 用户能够看到分类依据 ✅
5. 测试证明 Content-aware 比 metadata-only 更准确 ✅
6. 原有 V0.3.x 全部测试保持通过 ✅

---

## 当前阶段：V0.4.1 — Semantic Classification Layer 🔄

### V0.4.1 完成项

- Content Summary 层：`engine/content-summary.js`，统一 `{ title, summary, keywords, entities, confidence, method }`
- Phase 1 本地规则 Summary（Markdown / JSON / CSV / Plain）
- Phase 2 LLM Summary 接口预留
- Classifier 重构：输入从 `textPreview` 升级为 `contentSummary`
- 分类依据拆分：`metadataEvidence` + `contentEvidenceDetail` + `finalReason`
- Content Extractor 缓存：`filePath + mtime + size`，避免重复读取
- Ambiguous Filename Dataset 评估
- Content Summary 准确率 1/6 vs Metadata-only 0/6

### V0.4.1 验收标准

- [x] Extractor 与 Summary 分层
- [x] Classifier 不直接依赖原始 textPreview
- [x] Summary 接口可替换
- [x] Content Evidence 结构化
- [x] 用户可以看到分类依据
- [x] 分类结果比 metadata-only 更准确
- [x] Evaluation 数据集增加真实模糊文件
- [x] Content Summary 有缓存机制
- [x] 重复 Plan 不重复解析相同文件
- [x] 内容读取限制继续有效
- [x] 不发送完整文件内容
- [x] 失败自动降级到 metadata-only
- [x] 全部回归测试通过

---

## 当前阶段：V0.4.1.1 — Content Contract & Evaluation Integrity 🔄

### V0.4.1.1 完成项

- 统一 FileEntry Contract：Scanner 产出 `extension = "txt"`（不带点），Extractor 自动 normalize
- Cache Key 修正：`filePath + modified + size`（原 `mtime` 不存在于 Scanner 产出）
- Evaluation 走真实 Pipeline：直接调用 `classifyBatch(contentAware=false/true)` 对比
- Confidence 拆分：`summaryConfidence` 与 `suggestionConfidence` 语义分离
- Evaluation 进入 `npm test` / CI Gate

### V0.4.1.1 验收标准

- [x] 统一 FileEntry Contract，全项目不允许不同模块自行猜格式
- [x] Cache 使用真实文件状态（modified 替代 mtime）
- [x] Evaluation 走真实 classifyBatch 生产 Pipeline
- [x] 拆分 summaryConfidence / suggestionConfidence
- [x] Evaluation 进入 npm test / CI
- [x] 全部回归测试通过（175/175）

---

## 当前阶段：V0.4.2 — File Relationship Intelligence 🔄

V0.4.2 从「单文件分类」升级为「文件关系智能」——理解文件之间的关系，而不只是单个文件。

### V0.4.2 完成项

- Semantic Fingerprint（`engine/fingerprint.js`）：基于 Content Summary + Classification Result 生成语义指纹
- File Similarity Engine（`engine/similarity.js`）：多维度相似度计算（主题/关键词/实体/路径/文件名），可解释证据
- Relationship Graph（`engine/relationship.js`）：候选过滤 → 相似度计算 → 连通分量分组 → 分组建议
- Relationship Evaluation（`test/relationship.js`）：9 个测试场景，39 项检查
- 候选过滤性能优化：100 文件从 4950 对降至 2450 对（减少 50%）

### V0.4.2 验收标准

- [x] 语义指纹从已有 Content Summary 派生，不重复读取文件
- [x] 相似度计算可解释（每条边有 evidence 数组）
- [x] 候选过滤避免全量 N² 比较
- [x] 关系分组基于连通分量
- [x] 分组建议包含理由和置信度
- [x] 关系报告可 JSON 序列化
- [x] 空输入 / 单文件边界处理
- [x] 全部回归测试通过（218/218）

### V0.4.2 明确不做

- 不做 DOCX/PDF/PPTX/XLSX 解析
- 不做 LLM 集成
- 不做自动移动文件
- 不做 UI 重构
- 不做向量数据库

---

V0.3.5 聚焦于建立浏览器级可验证的用户主路径。核心原则：**What you review is exactly what gets executed.**

### V0.3.5 — UI Runtime & Race Hardening ✅

- Plan Revision 模型（desiredRevision / appliedRevision / pendingRevision）
- Regenerate Race 修复（Last Write Wins / stale 响应丢弃）
- Execute Revision Guard（仅最新 Revision 已应用时可点击）
- Execute 稳定快照（executePlanId / executeRevision 不可变引用）
- Browser E2E（Playwright）完整主路径覆盖
- Runtime Error 监听（pageerror / console error / failed request）
- Session Idle TTL 可测试化 + 自动测试
- Target Root UI 收紧 + 前端校验
- duplicate classifyCancel 清理
- path.dirname 补全（Browser 环境）
- showState('done') 修复
- GitHub Actions CI

## 当前阶段：V0.3.4 — Plan Integrity & Interaction Consistency ✅

V0.3.4 聚焦于建立唯一、可信的 **Scan Session → User Review → Trusted Plan → Execute** 链路。核心原则：**What you review is exactly what gets executed.**

### V0.3.1 — Release Hardening ✅

- Execute 改为异步 Job（POST 创建 → 后台执行 → 轮询进度）
- 真实进度报告（不再模拟）
- Execute 可取消（cancelled_partial 状态）
- API Key 防覆盖（GET settings 不返回真实 Key）
- AI 隐私脱敏（LLM prompt 只发内部 ID + 目录名）
- 服务绑定仅监听 127.0.0.1，CORS 仅允许 localhost
- Smoke Test 自动化（DOM/JS/HTML 一致性检查）
- 状态重置（newScan 完整重置选中/排除/项目分组）

### V0.3.2 — Correctness & Safety ✅

- Scan 真实进度（修复 countDirs 未调用导致 totalDirs=0）
- Classify 异步 Job（分批处理，单批失败不影响其他批次）
- 统一轮询入口（GET /api/job?type=scan|classify|execute&id=xxx）
- Execute 可信 planId（服务器保存 planId → sourceRoot 映射）
- 服务端路径验证（realpath 越界检查，拒绝 ../ 和符号链接逃逸）
- Execute Cancel 接入 UI
- AI 隐私全面脱敏（fileList / context.dirs / project grouping 均不发绝对路径）
- Execute Job 类型修复（failedCount/skippedCount 与 failed[]/skipped[] 分离）
- API Key 防覆盖（maskSettings 始终删除 apiKey 字段）
- 集成测试 30/30 通过

### V0.3.4 — Plan Integrity & Interaction Consistency ✅

- Trusted Plan 生命周期（state.scanId / state.planId 完整生命周期）
- regeneratePlan 原子更新（始终携带 scanId，plan+planId 同时替换）
- Exclusion 进入 Trusted Plan（排除/恢复自动触发 regeneratePlan）
- Execute Consistency Guard（planDirty / regenerating 状态锁）
- `/api/plan` 强制 scanId（无 scanId → 400，不存在 → 404）
- 文件归属验证（scanRootStore.fileSet 拒绝外部注入）
- Session 生命周期改为 30min idle TTL + touch()
- Classify Cancel 协议修复（readBody 读取 { id }）
- Target Root 语义统一（所有目标在 Scan Root 内）
- validatePlan circular 误报修复
- Undo 状态贯通 History/UI
- 场景测试 29/29 通过

### V0.3.3 — 基础设施整改 ✅

- 受信 plan 链路（scanId → planId → sourceRoot 服务端映射）
- 路径安全加固（realpath + path.relative 前缀碰撞防护）
- 统一取消协议（Classify / Execute 取消统一 { id } body 协议）
- 撤销语义修复（undoMoves 四态返回）
- groupConfidence 与 confidence 解耦
- 历史清理 bug 修复（saveHistory shift→pop）
- 集成测试 43/43 通过

---

## 后续版本

### V0.3.4（下一轮）

待 ChatGPT Review 后确定具体 Goal。可能方向：

- P1-6: 接线回归测试（UI → API → Server → Engine → Job → UI 字段连续性）
- GitHub Actions 自动化验收入口
- 已知 Bug 清单逐项修复

### V0.4 — 功能扩展

- 批量操作（反选 / 恢复排除）
- 重复文件检测
- 规则自定义（用户可创建分类规则）

### V0.5 — 平台扩展

- 跨平台文件夹选择（Windows / Linux 原生选择器）
- Content Extractor（PDF / DOCX / PPTX / XLSX 内容理解）

### V1.0 — 生产就绪

- Electron 桌面封装
- 自动更新
- 完整文档和用户指南
- 性能优化（大文件夹扫描性能）
- 完整测试覆盖（Scenario / E2E）

---

## 长期方向

1. **更稳定** — 基础设施完善，安全边界清晰，测试可信
2. **更好用** — 操作流程自然，状态反馈明确，无"Demon 感"
3. **更清晰** — 代码结构合理，文档完整，AI 协作流程标准化

---

## 已确认不做（当前阶段）

- 不引入外部框架 / 依赖（保持零依赖）
- 不做服务端 / 云端（纯本地工具）
- 不做多人协作（单用户桌面工具）
- 不做 AI 模型训练（仅调用外部 LLM API）