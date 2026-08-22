/**
 * agent-runtime.js — Agent Runtime Foundation 测试 (V0.5.1)
 *
 * 测试 Agent 运行基础能力：
 * 1. File Identity（多级指纹）
 * 2. Relationship State（持久化关系组）
 * 3. Agent History（生命周期记录）
 * 4. Scheduler（调度基础）
 * 5. Agent Status API 集成
 */

const fileIdentity = require('../engine/file-identity');
const relationshipState = require('../engine/relationship-state');
const agentHistory = require('../engine/agent-history');
const scheduler = require('../engine/scheduler');
const fileState = require('../engine/file-state');
const memory = require('../engine/memory');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

// ── 测试 1: File Identity — Level 1 快速指纹 ──
console.log('\n测试 1: File Identity Level 1\n');
{
  const fp1 = fileIdentity.fastFingerprint({ path: '/test/a.txt', size: 100, modified: 1000 });
  const fp2 = fileIdentity.fastFingerprint({ path: '/test/a.txt', size: 100, modified: 1000 });
  const fp3 = fileIdentity.fastFingerprint({ path: '/test/a.txt', size: 200, modified: 1000 });

  check(fp1 === fp2, `相同文件指纹一致 (实际: ${fp1} vs ${fp2})`);
  check(fp1 !== fp3, `不同大小指纹不同 (实际: ${fp1} vs ${fp3})`);
  check(fp1.startsWith('l1_'), `Level 1 标识正确 (实际: ${fp1})`);
  check(fileIdentity.fingerprintLevel(fp1) === 'l1', `指纹级别为 l1 (实际: ${fileIdentity.fingerprintLevel(fp1)})`);
}

// ── 测试 2: File Identity — Level 2 中级指纹 ──
console.log('\n测试 2: File Identity Level 2\n');
{
  // 创建临时文件
  const tmpFile = '/tmp/test-l2-identity.txt';
  const fs = require('fs');
  fs.writeFileSync(tmpFile, 'Hello World! This is a test file for Level 2 fingerprint.');

  const fp = fileIdentity.mediumFingerprint(tmpFile);
  check(fp && fp.startsWith('l2_'), `Level 2 指纹格式正确 (实际: ${fp})`);

  // 相同内容应产生相同指纹
  const fp2 = fileIdentity.mediumFingerprint(tmpFile);
  check(fp === fp2, `相同文件 Level 2 指纹一致 (实际: ${fp} vs ${fp2})`);

  fs.unlinkSync(tmpFile);
}

// ── 测试 3: Relationship State — Group 生命周期 ──
console.log('\n测试 3: Relationship State Group 生命周期\n');
{
  relationshipState.clearState();

  const group = relationshipState.createGroup({
    files: ['/test/a.txt', '/test/b.txt'],
    name: '项目A',
    entities: ['项目A'],
    confidence: 0.9,
  });
  check(group.groupId.startsWith('rg_'), `Group ID 格式正确 (实际: ${group.groupId})`);
  check(group.name === '项目A', `Group 名称正确 (实际: ${group.name})`);
  check(group.files.length === 2, `Group 文件数正确 (实际: ${group.files.length})`);

  // 更新 Group
  const updated = relationshipState.updateGroup(group.groupId, {
    add: ['/test/c.txt'],
  });
  check(updated && updated.files.length === 3, `更新后文件数正确 (实际: ${updated?.files.length})`);

  // 查询
  const found = relationshipState.getGroup(group.groupId);
  check(found !== null, `查询 Group 存在`);

  const containing = relationshipState.getGroupContaining('/test/b.txt');
  check(containing !== null, `通过文件查到 Group`);

  // 删除
  relationshipState.deleteGroup(group.groupId);
  const afterDelete = relationshipState.getGroup(group.groupId);
  check(afterDelete === null, `删除后 Group 不存在`);

  const stats = relationshipState.getStateStats();
  check(stats.groups === 0, `统计 groups=0 (实际: ${stats.groups})`);
}

// ── 测试 4: Relationship State — 增量更新 ──
console.log('\n测试 4: Relationship State 增量更新\n');
{
  relationshipState.clearState();

  // 创建已有 Group
  relationshipState.createGroup({
    files: ['/test/项目A/方案.docx', '/test/项目A/预算.xlsx'],
    name: '项目A',
    entities: ['项目A'],
    confidence: 0.9,
  });

  // 新增文件尝试加入
  const newFiles = [
    {
      path: '/test/项目A/验收报告.pdf',
      contentSummary: { entities: ['项目A'] },
    },
  ];

  const result = relationshipState.incrementalUpdate(newFiles);
  check(result.updated.length === 1, `新文件加入已有 Group (实际: ${result.updated.length})`);

  const stats = relationshipState.getStateStats();
  check(stats.totalFiles === 3, `Group 文件数正确 (实际: ${stats.totalFiles})`);
}

// ── 测试 5: Agent History ──
console.log('\n测试 5: Agent History 生命周期\n');
{
  agentHistory.clearHistory();

  // 记录各类事件
  agentHistory.recordIncrementalScan({ addedCount: 5, modifiedCount: 2 });
  agentHistory.recordPlanGenerated({ moves: 5, incremental: true });
  agentHistory.recordUserFeedback({ overrides: 1 });
  agentHistory.recordExecute({ moved: 5, status: 'completed' });
  agentHistory.recordUndo({ reverted: 5, status: 'fully_reverted' });

  const stats = agentHistory.getHistoryStats();
  check(stats.total === 5, `记录了 5 个事件 (实际: ${stats.total})`);
  check(stats.byEvent.incremental_scan === 1, `incremental_scan 计数 (实际: ${stats.byEvent.incremental_scan})`);
  check(stats.byEvent.plan_generated === 1, `plan_generated 计数 (实际: ${stats.byEvent.plan_generated})`);
  check(stats.byEvent.user_feedback === 1, `user_feedback 计数 (实际: ${stats.byEvent.user_feedback})`);
  check(stats.byEvent.execute === 1, `execute 计数 (实际: ${stats.byEvent.execute})`);
  check(stats.byEvent.undo === 1, `undo 计数 (实际: ${stats.byEvent.undo})`);

  // 查询
  const events = agentHistory.queryHistory({ event: 'execute' });
  check(events.length === 1, `查询 execute 事件 (实际: ${events.length})`);
}

// ── 测试 6: Scheduler ──
console.log('\n测试 6: Scheduler 基础能力\n');
{
  scheduler.reset();

  // 配置
  const config = scheduler.configure({ enabled: true, intervalMs: 3600000 });
  check(config.enabled === true, `Scheduler 已启用 (实际: ${config.enabled})`);
  check(config.nextRunAt !== null, `有下次运行时间 (实际: ${config.nextRunAt})`);

  // 触发
  const result = scheduler.triggerRun({ triggered: true });
  check(result.triggered === true, `触发成功 (实际: ${result.triggered})`);
  check(result.lastRunAt !== null, `有最后运行时间 (实际: ${result.lastRunAt})`);

  // Pending Plan
  scheduler.addPendingPlan({ moves: 3, category: '文档' });
  const plans = scheduler.getPendingPlans();
  check(plans.length === 1, `有 1 个 pending plan (实际: ${plans.length})`);
  check(plans[0].status === 'pending', `Plan 状态为 pending (实际: ${plans[0].status})`);

  // 清除
  scheduler.clearPendingPlan(plans[0].id);
  check(scheduler.getPendingPlans().length === 0, `Pending plan 已清除`);

  // 禁用
  scheduler.configure({ enabled: false });
  check(scheduler.getConfig().enabled === false, `Scheduler 已禁用`);

  scheduler.reset();
}

// ── 测试 7: Agent Status 集成 ──
console.log('\n测试 7: Agent Status 集成\n');
{
  fileState.clearState();
  memory.clearMemory();
  relationshipState.clearState();
  agentHistory.clearHistory();
  scheduler.reset();

  // 模拟一些状态
  fileState.upsertFileState(
    { name: 'test.txt', path: '/test/test.txt', size: 100, modified: 1000, contentTheme: '文档', contentSummary: { keywords: ['test'] } },
    { contentTheme: '文档', confidence: 0.8 }
  );
  memory.recordDecision({
    type: 'target_override',
    file: { name: 'a.xlsx', path: '/test/a.xlsx', contentTheme: '财务', contentSummary: { keywords: ['预算'] } },
    target: '财务',
  });
  agentHistory.recordIncrementalScan({ addedCount: 1 });

  const status = {
    running: false,
    trackedFiles: fileState.getStateStats().total,
    memoryRules: memory.getMemoryStats().total,
    relationshipGroups: relationshipState.getStateStats().groups,
    agentEvents: agentHistory.getHistoryStats().total,
  };

  check(status.trackedFiles === 1, `trackedFiles=1 (实际: ${status.trackedFiles})`);
  check(status.memoryRules === 1, `memoryRules=1 (实际: ${status.memoryRules})`);
  check(status.agentEvents === 1, `agentEvents=1 (实际: ${status.agentEvents})`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`Agent Runtime 测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}