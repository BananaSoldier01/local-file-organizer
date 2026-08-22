/**
 * feedback-loop.js — Feedback Loop 测试 (V0.4.5)
 *
 * 测试 Feedback 收集和学习闭环：
 * 1. collectFeedback 记录用户决策
 * 2. extractDecisionsFromExecution 提取执行差异
 * 3. 完整闭环：决策 → Memory → 下次建议
 */

const memory = require('../engine/memory');
const feedback = require('../engine/feedback');
const organizer = require('../engine/organizer');

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

// ── 测试 1: collectFeedback 记录 Target Override ──
console.log('\n测试 1: collectFeedback 记录 Target Override\n');
{
  memory.clearMemory();

  const planData = { moves: [{ from: '/test/a.xlsx', to: '/test/项目资料/a.xlsx' }] };
  const userDecisions = {
    targetOverrides: [{
      file: { name: 'a.xlsx', path: '/test/a.xlsx', contentTheme: '财务', contentSummary: { keywords: ['预算'] } },
      target: '财务',
      originalTarget: '项目资料',
      reason: '用户修改',
    }],
  };

  const result = feedback.collectFeedback(planData, userDecisions);
  check(result.recorded === 1, `记录了 1 条 (实际: ${result.recorded})`);
  check(result.errors.length === 0, `无错误 (实际: ${result.errors.length})`);

  const stats = memory.getMemoryStats();
  check(stats.total === 1, `Memory 有 1 条记录 (实际: ${stats.total})`);
  check(stats.byType.target_override === 1, `类型为 target_override (实际: ${stats.byType.target_override})`);
}

// ── 测试 2: collectFeedback 记录多种决策 ──
console.log('\n测试 2: collectFeedback 记录多种决策\n');
{
  memory.clearMemory();

  const userDecisions = {
    targetOverrides: [{
      file: { name: 'a.xlsx', path: '/test/a.xlsx', contentTheme: '财务', contentSummary: { keywords: ['预算'] } },
      target: '财务',
      originalTarget: 'A',
    }],
    excludedFiles: [{
      file: { name: 'temp.txt', path: '/test/temp.txt', contentTheme: '默认', contentSummary: { keywords: ['临时'] } },
    }],
    relationshipAccepts: [{
      groupName: '项目A',
      relationshipGroup: '项目A',
    }],
    relationshipRejects: [{
      groupName: '项目B',
      relationshipGroup: '项目B',
    }],
  };

  const result = feedback.collectFeedback({}, userDecisions);
  check(result.recorded === 4, `记录了 4 条 (实际: ${result.recorded})`);

  const stats = memory.getMemoryStats();
  check(stats.byType.target_override === 1, `target_override (实际: ${stats.byType.target_override})`);
  check(stats.byType.exclude === 1, `exclude (实际: ${stats.byType.exclude})`);
  check(stats.byType.relationship_accept === 1, `relationship_accept (实际: ${stats.byType.relationship_accept})`);
  check(stats.byType.relationship_reject === 1, `relationship_reject (实际: ${stats.byType.relationship_reject})`);
}

// ── 测试 3: extractDecisionsFromExecution ──
console.log('\n测试 3: extractDecisionsFromExecution 提取执行差异\n');
{
  const originalPlan = {
    moves: [
      { from: '/test/a.xlsx', to: '/test/项目资料/a.xlsx' },
      { from: '/test/b.txt', to: '/test/文档/b.txt' },
    ],
  };

  const executedPlan = {
    moves: [
      { from: '/test/a.xlsx', to: '/test/财务/a.xlsx' },
      { from: '/test/b.txt', to: '/test/文档/b.txt' },
    ],
  };

  const decisions = feedback.extractDecisionsFromExecution(originalPlan, executedPlan);
  check(decisions.targetOverrides.length === 1, `提取了 1 条 override (实际: ${decisions.targetOverrides.length})`);
  check(decisions.targetOverrides[0].target === '财务', `目标为"财务" (实际: ${decisions.targetOverrides[0].target})`);
  check(decisions.targetOverrides[0].originalTarget === '项目资料', `原始目标为"项目资料" (实际: ${decisions.targetOverrides[0].originalTarget})`);
}

// ── 测试 4: 完整闭环 ──
console.log('\n测试 4: 完整闭环（决策 → Memory → 下次建议）\n');
{
  memory.clearMemory();

  // 记录并 touch 到 learned 级别
  const entry = memory.recordDecision({
    type: 'target_override',
    file: {
      name: '预算.xlsx',
      path: '/test/预算.xlsx',
      contentTheme: '财务',
      contentSummary: { keywords: ['预算', '财务'] },
    },
    target: '财务',
    originalTarget: '项目资料',
  });
  for (let i = 0; i < 3; i++) memory.touchMemory(entry.id);

  const files = [
    {
      name: '2027项目预算.xlsx',
      path: '/test/2027项目预算.xlsx',
      dir: '/test',
      fileType: 'document',
      contentTheme: '财务',
      suggestedTarget: '文档',
      confidence: 0.8,
      contentSummary: { keywords: ['预算', '2027'] },
    },
  ];

  const plan = organizer.generatePlan(files, {});
  const move = plan.moves[0];

  check(move && move.to.includes('财务'),
    `闭环：新预算文件归入"财务" (实际: ${move?.to})`);
  check(move && move.memoryReason && move.memoryReason.includes('过去90天'),
    `闭环：带有 Memory reason (实际: ${move?.memoryReason})`);
}

// ── 测试 5: 用户未操作不产生 Memory ──
console.log('\n测试 5: 用户未操作不产生 Memory\n');
{
  memory.clearMemory();

  const result = feedback.collectFeedback({}, {});
  check(result.recorded === 0, `空决策不记录 (实际: ${result.recorded})`);
  check(memory.getMemoryStats().total === 0, `Memory 为空 (实际: ${memory.getMemoryStats().total})`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`Feedback Loop 测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}