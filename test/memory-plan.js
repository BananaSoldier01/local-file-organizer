/**
 * memory-plan.js — Memory-aware Plan 集成测试 (V0.4.5)
 *
 * 测试 Memory 与 Organizer 的集成：
 * 1. Memory 优先于 Relationship Group
 * 2. 用户 override 优先于 Memory
 * 3. Memory 命中统计
 * 4. candidate 不参与决策
 */

const memory = require('../engine/memory');
const organizer = require('../engine/organizer');
const relationship = require('../engine/relationship');

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

// ── 测试 1: Memory 优先于 Relationship Group ──
console.log('\n测试 1: Memory 优先于 Relationship Group\n');
{
  memory.clearMemory();

  // 记录 3 次，每次 touch 多次以达到 learned 级别
  for (let i = 0; i < 3; i++) {
    const entry = memory.recordDecision({
      type: 'target_override',
      file: {
        name: `预算${i}.csv`,
        path: `/test/预算${i}.csv`,
        contentTheme: '项目',
        contentSummary: { keywords: ['预算', '项目A'], entities: ['项目A'] },
      },
      target: '财务',
    });
    // touch 多次以达到 learned（usageCount >= 3）
    for (let t = 0; t < 3; t++) memory.touchMemory(entry.id);
  }

  const files = [
    {
      name: '项目A_预算.csv',
      path: '/test/项目A_预算.csv',
      dir: '/test',
      fileType: 'document',
      contentTheme: '项目',
      suggestedTarget: '文档',
      confidence: 0.85,
      contentSummary: { title: '项目A预算', keywords: ['预算', '项目A'], entities: ['项目A'] },
    },
    {
      name: '项目A_方案.md',
      path: '/test/项目A_方案.md',
      dir: '/test',
      fileType: 'document',
      contentTheme: '项目',
      suggestedTarget: '文档',
      confidence: 0.85,
      contentSummary: { title: '项目A方案', keywords: ['方案', '项目A'], entities: ['项目A'] },
    },
  ];

  const relResult = relationship.buildRelationshipGraph(files);
  const plan = organizer.generatePlan(files, {
    relationshipGroups: relResult.groups,
  });

  const budgetMove = plan.moves.find(m => m.from.includes('预算'));
  check(budgetMove && budgetMove.to.includes('财务'),
    `Memory 优先：预算文件归入"财务" (实际: ${budgetMove?.to})`);
  check(budgetMove && budgetMove.memoryReason,
    `Memory 命中带有 reason (实际: ${budgetMove?.memoryReason})`);

  const schemeMove = plan.moves.find(m => m.from.includes('方案'));
  check(schemeMove && schemeMove.to.includes('项目A'),
    `未命中 Memory 的文件归入"项目A" (实际: ${schemeMove?.to})`);
}

// ── 测试 2: 用户 Override 优先于 Memory ──
console.log('\n测试 2: 用户 Override 优先于 Memory\n');
{
  memory.clearMemory();

  for (let i = 0; i < 3; i++) {
    const entry = memory.recordDecision({
      type: 'target_override',
      file: {
        name: `预算${i}.csv`,
        path: `/test/预算${i}.csv`,
        contentTheme: '项目',
        contentSummary: { keywords: ['预算', '项目A'], entities: ['项目A'] },
      },
      target: '财务',
    });
    for (let t = 0; t < 3; t++) memory.touchMemory(entry.id);
  }

  const files = [
    {
      name: '项目A_预算.csv',
      path: '/test/项目A_预算.csv',
      dir: '/test',
      fileType: 'document',
      contentTheme: '项目',
      suggestedTarget: '文档',
      confidence: 0.85,
      contentSummary: { title: '项目A预算', keywords: ['预算', '项目A'], entities: ['项目A'] },
      _userOverride: true,
      suggestedTarget: '归档',
    },
  ];

  const plan = organizer.generatePlan(files, {});

  const move = plan.moves[0];
  check(move && move.to.includes('归档'),
    `用户 Override 优先于 Memory：归入"归档" (实际: ${move?.to})`);
  check(move && !move.to.includes('财务'),
    `不归入 Memory 建议的"财务" (实际: ${move?.to})`);
}

// ── 测试 3: Memory 命中统计 ──
console.log('\n测试 3: Memory 命中统计\n');
{
  memory.clearMemory();

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

  const files = [
    {
      name: '2026发票.xlsx',
      path: '/test/2026发票.xlsx',
      dir: '/test',
      fileType: 'document',
      contentTheme: '财务',
      suggestedTarget: '文档',
      confidence: 0.8,
      contentSummary: { keywords: ['发票', '税务'] },
    },
    {
      name: '普通文档.txt',
      path: '/test/普通文档.txt',
      dir: '/test',
      fileType: 'document',
      contentTheme: '默认',
      suggestedTarget: '文档',
      confidence: 0.6,
      contentSummary: { keywords: ['普通'] },
    },
  ];

  const plan = organizer.generatePlan(files, {});

  check(plan.memoryStats && plan.memoryStats.hits === 1,
    `Memory 命中 1 个文件 (实际: ${plan.memoryStats?.hits})`);
  check(plan.memoryStats && plan.memoryStats.total === 2,
    `总文件数 2 (实际: ${plan.memoryStats?.total})`);
}

// ── 测试 4: 无 Memory 时等同于旧版行为 ──
console.log('\n测试 4: 无 Memory 时等同于旧版行为\n');
{
  memory.clearMemory();

  const files = [
    {
      name: '项目A_文档1.md',
      path: '/test/项目A_文档1.md',
      dir: '/test',
      fileType: 'document',
      contentTheme: '项目',
      suggestedTarget: '文档',
      confidence: 0.85,
      contentSummary: { title: '项目A文档1', keywords: ['项目A'], entities: ['项目A'] },
    },
    {
      name: '项目A_文档2.md',
      path: '/test/项目A_文档2.md',
      dir: '/test',
      fileType: 'document',
      contentTheme: '项目',
      suggestedTarget: '文档',
      confidence: 0.85,
      contentSummary: { title: '项目A文档2', keywords: ['项目A'], entities: ['项目A'] },
    },
  ];

  const relResult = relationship.buildRelationshipGraph(files);
  const plan = organizer.generatePlan(files, {
    relationshipGroups: relResult.groups,
  });

  const move = plan.moves.find(m => m.from.includes('文档1'));
  check(move && move.to.includes('项目A'),
    `无 Memory 时使用 Relationship Group (实际: ${move?.to})`);
  check(move && !move.memoryReason,
    `无 Memory 命中时不带 memoryReason`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`Memory-aware Plan 测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}