/**
 * decision-engine.js — Decision Engine 测试 (V0.5.2)
 *
 * 测试统一决策引擎：
 * 1. 优先级链正确
 * 2. 每个决策携带证据
 * 3. 观察状态 > 推断状态
 * 4. 批量决策
 * 5. 决策摘要
 */

const decisionEngine = require('../engine/decision-engine');
const memory = require('../engine/memory');
const fileState = require('../engine/file-state');
const relationshipState = require('../engine/relationship-state');

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

// ── 测试 1: 优先级链 — User Override 最高 ──
console.log('\n测试 1: User Override 最高优先级\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  const file = {
    name: 'test.txt',
    path: '/test/test.txt',
    dir: '/test',
    contentTheme: '文档',
    suggestedTarget: '文档',
    confidence: 0.8,
    contentSummary: { keywords: ['test'] },
    _userOverride: true,
    suggestedTarget: '归档',
  };

  const decision = decisionEngine.decide(file, {});
  check(decision.source === 'user_override', `User Override 优先 (实际: ${decision.source})`);
  check(decision.target === '归档', `目标为"归档" (实际: ${decision.target})`);
  check(decision.priority === 100, `优先级为 100 (实际: ${decision.priority})`);
  check(decision.evidence && decision.evidence.type === 'user_action', `证据类型正确 (实际: ${decision.evidence?.type})`);
}

// ── 测试 2: 优先级链 — Memory 优先于 State ──
console.log('\n测试 2: Memory 优先于 Organization State\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 记录 trusted Memory
  for (let i = 0; i < 3; i++) {
    const entry = memory.recordDecision({
      type: 'target_override',
      file: {
        name: `发票${i}.xlsx`,
        path: `/test/发票${i}.xlsx`,
        contentTheme: '财务',
        contentSummary: { keywords: ['发票', '税务'], entities: [] },
      },
      target: '个人/税务',
    });
    for (let t = 0; t < 3; t++) memory.touchMemory(entry.id);
  }

  // 同时设置 Organization State（目标为"财务"）
  fileState.upsertFileState(
    { name: '新发票.xlsx', path: '/test/新发票.xlsx', size: 100, modified: 1000, contentTheme: '财务', contentSummary: { keywords: ['发票'] } },
    { contentTheme: '财务', confidence: 0.8 },
    { currentPath: '/test', targetPath: '/test/财务' }
  );

  const file = {
    name: '新发票.xlsx',
    path: '/test/新发票.xlsx',
    dir: '/test',
    contentTheme: '财务',
    suggestedTarget: '文档',
    confidence: 0.8,
    contentSummary: { keywords: ['发票', '税务'] },
  };

  const decision = decisionEngine.decide(file, {});
  check(decision.source === 'trusted_memory' || decision.source === 'learned_memory',
    `Memory 优先于 State (实际: ${decision.source})`);
  check(decision.target === '个人/税务', `目标为"个人/税务" (实际: ${decision.target})`);
}

// ── 测试 3: 优先级链 — State 优先于 Relationship ──
console.log('\n测试 3: Organization State 优先于 Relationship\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 设置 Organization State
  fileState.upsertFileState(
    { name: 'report.pdf', path: '/test/report.pdf', size: 100, modified: 1000, contentTheme: '项目', contentSummary: { keywords: ['报告'] } },
    { contentTheme: '项目', confidence: 0.8 },
    { currentPath: '/test', targetPath: '/test/归档' }
  );

  // 设置 Relationship State
  relationshipState.createGroup({
    files: ['/test/report.pdf'],
    name: '项目A',
    entities: ['项目A'],
    confidence: 0.9,
  });

  const file = {
    name: 'report.pdf',
    path: '/test/report.pdf',
    dir: '/test',
    contentTheme: '项目',
    suggestedTarget: '文档',
    confidence: 0.8,
    contentSummary: { keywords: ['报告', '项目A'], entities: ['项目A'] },
  };

  const decision = decisionEngine.decide(file, {});
  check(decision.source === 'existing_org_state',
    `State 优先于 Relationship (实际: ${decision.source})`);
  check(decision.target === '归档', `目标为"归档" (实际: ${decision.target})`);
}

// ── 测试 4: 优先级链 — Relationship 优先于 Classification ──
console.log('\n测试 4: Relationship 优先于 Classification\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 设置 Relationship State
  relationshipState.createGroup({
    files: ['/test/doc.md'],
    name: '项目A',
    entities: ['项目A'],
    confidence: 0.9,
  });

  const file = {
    name: 'doc.md',
    path: '/test/doc.md',
    dir: '/test',
    contentTheme: '文档',
    suggestedTarget: '文档',
    confidence: 0.6,
    contentSummary: { keywords: ['doc', '项目A'], entities: ['项目A'] },
  };

  const decision = decisionEngine.decide(file, {});
  check(decision.source === 'relationship_state',
    `Relationship 优先于 Classification (实际: ${decision.source})`);
  check(decision.target === '项目A', `目标为"项目A" (实际: ${decision.target})`);
}

// ── 测试 5: 决策证据链 ──
console.log('\n测试 5: 决策证据链\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  const file = {
    name: 'test.txt',
    path: '/test/test.txt',
    dir: '/test',
    contentTheme: '文档',
    suggestedTarget: '文档',
    confidence: 0.7,
    contentSummary: { keywords: ['test'] },
  };

  const decision = decisionEngine.decide(file, {});
  check(decision.evidenceChain && decision.evidenceChain.length > 0,
    `有证据链 (实际: ${decision.evidenceChain?.length} 条)`);
  check(decision.evidence && decision.evidence.type,
    `有主证据类型 (实际: ${decision.evidence?.type})`);
  check(decision.reason, `有决策理由 (实际: ${decision.reason})`);
  check(decision.candidates && decision.candidates.length > 0,
    `有候选列表 (实际: ${decision.candidates?.length} 个)`);
}

// ── 测试 6: 批量决策 ──
console.log('\n测试 6: 批量决策\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  const files = [
    {
      name: 'a.txt', path: '/test/a.txt', dir: '/test',
      contentTheme: '文档', suggestedTarget: '文档', confidence: 0.7,
      contentSummary: { keywords: ['a'] },
    },
    {
      name: 'b.txt', path: '/test/b.txt', dir: '/test',
      contentTheme: '文档', suggestedTarget: '文档', confidence: 0.7,
      contentSummary: { keywords: ['b'] },
    },
  ];

  const decisions = decisionEngine.decideBatch(files, {});
  check(decisions.size === 2, `批量决策 2 个 (实际: ${decisions.size})`);
  check(decisions.get('/test/a.txt') !== undefined, `a.txt 有决策`);
  check(decisions.get('/test/b.txt') !== undefined, `b.txt 有决策`);
}

// ── 测试 7: 决策摘要 ──
console.log('\n测试 7: 决策摘要\n');
{
  const decisions = new Map();
  decisions.set('/test/a', { source: 'classification', priority: 10, confidence: 0.7, evidence: {} });
  decisions.set('/test/b', { source: 'memory', priority: 80, confidence: 0.9, evidence: {} });
  decisions.set('/test/c', { source: 'memory', priority: 80, confidence: 0.85, evidence: {} });

  const summary = decisionEngine.summarizeDecisions(decisions);
  check(summary.total === 3, `总数为 3 (实际: ${summary.total})`);
  check(summary.bySource.classification === 1, `classification 计数 (实际: ${summary.bySource.classification})`);
  check(summary.bySource.memory === 2, `memory 计数 (实际: ${summary.bySource.memory})`);
  check(summary.avgConfidence > 0.8, `平均置信度 > 0.8 (实际: ${summary.avgConfidence})`);
}

// ── 测试 8: 观察状态 > 推断状态 ──
console.log('\n测试 8: 观察状态 > 推断状态\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 用户手动移动文件到"归档"
  // File State 应反映这个观察状态
  fileState.upsertFileState(
    { name: 'moved.txt', path: '/test/moved.txt', size: 100, modified: 1000, contentTheme: '文档', contentSummary: { keywords: ['moved'] } },
    { contentTheme: '文档', confidence: 0.8 },
    { currentPath: '/test', targetPath: '/test/归档' }
  );

  const file = {
    name: 'moved.txt',
    path: '/test/moved.txt',
    dir: '/test',
    contentTheme: '文档',
    suggestedTarget: '文档',
    confidence: 0.8,
    contentSummary: { keywords: ['moved'] },
  };

  const decision = decisionEngine.decide(file, {});
  // 观察状态（existing_org_state）应优先于分类（classification）
  check(decision.source === 'existing_org_state',
    `观察状态优先 (实际: ${decision.source})`);
  check(decision.target === '归档', `保持观察状态目标 (实际: ${decision.target})`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`Decision Engine 测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}