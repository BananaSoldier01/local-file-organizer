/**
 * decision-evaluation.js — Decision Evaluation 测试 (V0.5.3)
 *
 * 真实决策场景测试：
 * 1. Memory 与 Relationship 冲突
 * 2. 低置信 Memory 不覆盖 Relationship
 * 3. User Override 永远最高
 * 4. 多个 Provider 提供相同目标时 Evidence 合并
 * 5. 决策解释结构化
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

// ── 场景 1: Memory 与 Relationship 冲突 ──
console.log('\n场景 1: Memory 与 Relationship 冲突\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 记录 trusted Memory：预算 → 财务
  for (let i = 0; i < 3; i++) {
    const entry = memory.recordDecision({
      type: 'target_override',
      file: {
        name: `预算${i}.xlsx`,
        path: `/test/预算${i}.xlsx`,
        contentTheme: '项目',
        contentSummary: { keywords: ['预算', '项目A'], entities: ['项目A'] },
      },
      target: '财务',
    });
    for (let t = 0; t < 3; t++) memory.touchMemory(entry.id);
  }

  // 同时设置 Relationship State：同一文件属于项目A
  relationshipState.createGroup({
    files: ['/test/项目A_预算.xlsx'],
    name: '项目A',
    entities: ['项目A'],
    confidence: 0.9,
  });

  const file = {
    name: '项目A_预算.xlsx',
    path: '/test/项目A_预算.xlsx',
    dir: '/test',
    contentTheme: '项目',
    suggestedTarget: '文档',
    confidence: 0.85,
    contentSummary: { keywords: ['预算', '项目A'], entities: ['项目A'] },
  };

  const decision = decisionEngine.decide(file, {});
  // Memory (priority 80) > Relationship State (priority 40)
  check(decision.source === 'trusted_memory' || decision.source === 'learned_memory',
    `Memory 优先于 Relationship (实际: ${decision.source})`);
  check(decision.target === '财务', `Memory 目标胜出 (实际: ${decision.target})`);
}

// ── 场景 2: 低置信 Memory 不覆盖 Relationship ──
console.log('\n场景 2: 低置信 Memory 不覆盖 Relationship\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 只记录 1 次（candidate 级别，不参与决策）
  memory.recordDecision({
    type: 'target_override',
    file: {
      name: '预算.xlsx',
      path: '/test/预算.xlsx',
      contentTheme: '项目',
      contentSummary: { keywords: ['预算', '项目A'], entities: ['项目A'] },
    },
    target: '财务',
  });

  // Relationship State：项目A
  relationshipState.createGroup({
    files: ['/test/项目A_预算.xlsx'],
    name: '项目A',
    entities: ['项目A'],
    confidence: 0.9,
  });

  const file = {
    name: '项目A_预算.xlsx',
    path: '/test/项目A_预算.xlsx',
    dir: '/test',
    contentTheme: '项目',
    suggestedTarget: '文档',
    confidence: 0.85,
    contentSummary: { keywords: ['预算', '项目A'], entities: ['项目A'] },
  };

  const decision = decisionEngine.decide(file, {});
  // candidate Memory 不参与 → Relationship State 胜出
  check(decision.source === 'relationship_state',
    `低置信 Memory 不覆盖 Relationship (实际: ${decision.source})`);
  check(decision.target === '项目A', `Relationship 目标胜出 (实际: ${decision.target})`);
}

// ── 场景 3: User Override 永远最高 ──
console.log('\n场景 3: User Override 永远最高\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 记录 trusted Memory
  for (let i = 0; i < 3; i++) {
    const entry = memory.recordDecision({
      type: 'target_override',
      file: {
        name: `test${i}.xlsx`,
        path: `/test/test${i}.xlsx`,
        contentTheme: '财务',
        contentSummary: { keywords: ['预算'] },
      },
      target: '财务',
    });
    for (let t = 0; t < 3; t++) memory.touchMemory(entry.id);
  }

  const file = {
    name: 'test.xlsx',
    path: '/test/test.xlsx',
    dir: '/test',
    contentTheme: '财务',
    suggestedTarget: '归档',
    confidence: 0.9,
    contentSummary: { keywords: ['预算'] },
    _userOverride: true,
  };

  const decision = decisionEngine.decide(file, {});
  check(decision.source === 'user_override',
    `User Override 永远最高 (实际: ${decision.source})`);
  check(decision.target === '归档', `User Override 目标胜出 (实际: ${decision.target})`);
  check(decision.priority === 100, `优先级为 100 (实际: ${decision.priority})`);
}

// ── 场景 4: 多个 Provider 提供相同目标时 Evidence 合并 ──
console.log('\n场景 4: Evidence 合并\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 设置 Organization State 和 Relationship State 指向同一目标
  fileState.upsertFileState(
    { name: 'report.pdf', path: '/test/report.pdf', size: 100, modified: 1000, contentTheme: '项目', contentSummary: { keywords: ['报告'] } },
    { contentTheme: '项目', confidence: 0.8 },
    { currentPath: '/test', targetPath: '/test/项目A' }
  );

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
  // 两个 Provider 都指向"项目A"，evidence 应合并
  check(decision.evidenceChain && decision.evidenceChain.length >= 1,
    `Evidence 链存在 (实际: ${decision.evidenceChain?.length} 条)`);
  check(decision.target === '项目A', `目标一致 (实际: ${decision.target})`);
}

// ── 场景 5: 决策解释结构化 ──
console.log('\n场景 5: 决策解释结构化\n');
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
  check(decision.explanation, `有 explanation 对象`);
  check(decision.explanation.summary, `有 summary (实际: ${decision.explanation?.summary})`);
  check(Array.isArray(decision.explanation.reasons), `reasons 是数组 (实际: ${decision.explanation?.reasons?.length} 条)`);
  check(decision.explanation.confidenceLabel, `有置信度标签 (实际: ${decision.explanation?.confidenceLabel})`);
  check(Array.isArray(decision.explanation.sources), `sources 是数组 (实际: ${decision.explanation?.sources})`);
}

// ── 场景 6: 批量决策 ──
console.log('\n场景 6: 批量决策\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  const files = [
    { name: 'a.txt', path: '/test/a.txt', dir: '/test', contentTheme: '文档', suggestedTarget: '文档', confidence: 0.7, contentSummary: { keywords: ['a'] } },
    { name: 'b.txt', path: '/test/b.txt', dir: '/test', contentTheme: '文档', suggestedTarget: '文档', confidence: 0.7, contentSummary: { keywords: ['b'] } },
    { name: 'c.txt', path: '/test/c.txt', dir: '/test', contentTheme: '文档', suggestedTarget: '文档', confidence: 0.7, contentSummary: { keywords: ['c'] } },
  ];

  const decisions = decisionEngine.decideBatch(files, {});
  check(decisions.size === 3, `批量决策 3 个 (实际: ${decisions.size})`);

  const summary = decisionEngine.summarizeDecisions(decisions);
  check(summary.total === 3, `摘要总数为 3 (实际: ${summary.total})`);
  check(summary.bySource.classification === 3, `全部使用 classification (实际: ${summary.bySource.classification})`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`Decision Evaluation 测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}