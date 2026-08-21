# ROADMAP

> 最后更新：V0.3.3

---

## 当前阶段：V0.3.x — 基础设施整改

V0.3.x 系列聚焦于让安全、执行、取消、项目分组和测试结果真正可信。核心原则：**不要再写"看起来实现了"的功能，每一个能力必须做到 UI → API → Job/Engine → File System → Result → UI feedback 完整闭环。**

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