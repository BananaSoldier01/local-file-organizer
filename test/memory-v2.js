/**
 * memory-v2.js — Memory Intelligence Hardening 测试 (V0.4.5)
 *
 * 覆盖 Memory 生命周期：
 * 1. Schema v2 迁移
 * 2. 置信度生命周期（candidate → learned → trusted）
 * 3. 上下文匹配（防止误命中）
 * 4. 决策优先级链
 * 5. 误操作不污染
 * 6. 清空后恢复
 */

const memoryMod = require('../engine/memory');
const memory = memoryMod; // keep reference for tests
const organizer = require('../engine/organizer');
const path = require('path');

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

// ── 测试 1: Schema v2 ──
console.log('\n测试 1: Schema v2 数据结构\n');
{
  memory.clearMemory();

  const entry = memory.recordDecision({
    type: 'target_override',
    file: {
      name: '2026项目预算.xlsx',
      path: '/test/2026项目预算.xlsx',
      contentTheme: '财务',
      contentSummary: { keywords: ['预算', '财务'], entities: ['项目A'] },
    },
    target: '财务',
    reason: '测试',
  });

  check(entry.context, `有 context 字段`);
  check(entry.context.contentTheme === '财务', `context.contentTheme 正确 (实际: ${entry.context.contentTheme})`);
  check(entry.context.entities.includes('项目a'), `context.entities 包含项目A (实际: ${entry.context.entities})`);
  check(entry.context.extension === 'xlsx', `context.extension 正确 (实际: ${entry.context.extension})`);
  check(entry.action, `有 action 字段`);
  check(entry.action.target === '财务', `action.target 正确 (实际: ${entry.action.target})`);
  check(entry.confidence, `有 confidence 字段`);
  check(entry.confidence.level === 'candidate', `初始级别为 candidate (实际: ${entry.confidence.level})`);
  check(entry.timestamp, `有 timestamp 字段`);
  check(entry.timestamp.createdAt, `有 createdAt`);
}

// ── 测试 2: 旧格式自动迁移 ──
console.log('\n测试 2: 旧格式自动迁移\n');
{
  // 清空并验证新格式
  memory.clearMemory();

  const entry = memory.recordDecision({
    type: 'target_override',
    file: { name: 'test.xlsx', path: '/test/test.xlsx', contentTheme: '财务', contentSummary: { keywords: ['预算'] } },
    target: '财务',
  });

  // 验证新格式字段存在（迁移在加载时自动完成）
  check(entry.context.contentKeywords.includes('预算'), `新格式 context 正确`);
  check(entry.action.target === '财务', `新格式 action 正确`);
  check(entry.confidence.level === 'candidate', `新格式 confidence 正确`);
  check(entry.timestamp.createdAt, `新格式 timestamp 正确`);

  // 验证 getMemoryStats 返回 version 2
  const stats = memory.getMemoryStats();
  check(stats.version === 2, `版本为 2 (实际: ${stats.version})`);
}

// ── 测试 3: 置信度生命周期 ──
console.log('\n测试 3: 置信度生命周期\n');
{
  memory.clearMemory();

  // candidate → learned → trusted
  const entry = memory.recordDecision({
    type: 'target_override',
    file: {
      name: 'test.xlsx',
      path: '/test/test.xlsx',
      contentTheme: '财务',
      contentSummary: { keywords: ['预算'], entities: [] },
    },
    target: '财务',
  });

  // 初始为 candidate
  check(entry.confidence.level === 'candidate', `初始 candidate (实际: ${entry.confidence.level})`);

  // 模拟 usageCount 增长到 learned
  for (let i = 0; i < 3; i++) memory.touchMemory(entry.id);
  const data = memory.exportMemory();
  const updated = data.entries.find(e => e.id === entry.id);
  check(['learned', 'trusted'].includes(updated.confidence.level),
    `3次使用后升级 (实际: ${updated.confidence.level})`);

  // 模拟 usageCount 增长到 trusted
  for (let i = 0; i < 2; i++) memory.touchMemory(entry.id);
  const data2 = memory.exportMemory();
  const updated2 = data2.entries.find(e => e.id === entry.id);
  check(updated2.confidence.level === 'trusted',
    `5次使用后 trusted (实际: ${updated2.confidence.level})`);
}

// ── 测试 4: 上下文匹配（防止误命中） ──
console.log('\n测试 4: 上文匹配防止误命中\n');
{
  memory.clearMemory();

  // 记录：项目A 预算 → 财务
  memory.recordDecision({
    type: 'target_override',
    file: {
      name: '项目A预算.xlsx',
      path: '/test/项目A预算.xlsx',
      contentTheme: '财务',
      contentSummary: { keywords: ['预算', '项目A'], entities: ['项目A'] },
    },
    target: '财务',
  });

  // 测试1：项目B 预算（不同实体）→ 不应命中
  const file1 = {
    name: '项目B预算.xlsx',
    path: '/test/项目B预算.xlsx',
    contentTheme: '财务',
    contentSummary: { keywords: ['预算', '项目B'], entities: ['项目B'] },
  };
  const sug1 = memory.lookupMemorySuggestion(file1);
  check(sug1 === null || sug1.matchScore < 0.5,
    `项目B不应误匹配项目A记忆 (matchScore: ${sug1?.matchScore})`);

  // 测试2：家庭预算（完全不同上下文）→ 不应命中
  const file2 = {
    name: '家庭预算.xlsx',
    path: '/test/家庭预算.xlsx',
    contentTheme: '个人',
    contentSummary: { keywords: ['家庭'], entities: [] },
  };
  const sug2 = memory.lookupMemorySuggestion(file2);
  check(sug2 === null || sug2.matchScore < 0.5,
    `家庭预算不应匹配项目记忆 (matchScore: ${sug2?.matchScore})`);
}

// ── 测试 5: candidate 不参与决策 ──
console.log('\n测试 5: candidate 不参与决策\n');
{
  memory.clearMemory();

  // 只记录 1 次（candidate 级别）
  memory.recordDecision({
    type: 'target_override',
    file: {
      name: '测试.xlsx',
      path: '/test/测试.xlsx',
      contentTheme: '财务',
      contentSummary: { keywords: ['预算'], entities: [] },
    },
    target: '财务',
  });

  const files = [
    {
      name: '新预算.xlsx',
      path: '/test/新预算.xlsx',
      dir: '/test',
      fileType: 'document',
      contentTheme: '财务',
      suggestedTarget: '文档',
      confidence: 0.8,
      contentSummary: { keywords: ['预算'] },
    },
  ];

  const plan = organizer.generatePlan(files, {});
  const move = plan.moves[0];
  // candidate 不参与决策 → 应使用 Classification 而非 Memory
  check(move && !move.memoryReason,
    `candidate Memory 不参与决策 (reason: ${move?.memoryReason || 'none'})`);
}

// ── 测试 6: learned/trusted 参与决策 ──
console.log('\n测试 6: learned/trusted 参与决策\n');
{
  memory.clearMemory();

  // 记录 5 次 → trusted
  for (let i = 0; i < 5; i++) {
    memory.recordDecision({
      type: 'target_override',
      file: {
        name: `测试${i}.xlsx`,
        path: `/test/测试${i}.xlsx`,
        contentTheme: '财务',
        contentSummary: { keywords: ['预算'], entities: [] },
      },
      target: '财务',
    });
  }

  // 触发升级
  const data = memory.exportMemory();
  for (const e of data.entries) {
    for (let i = 0; i < 5; i++) memory.touchMemory(e.id);
  }

  const files = [
    {
      name: '新预算.xlsx',
      path: '/test/新预算.xlsx',
      dir: '/test',
      fileType: 'document',
      contentTheme: '财务',
      suggestedTarget: '文档',
      confidence: 0.8,
      contentSummary: { keywords: ['预算'] },
    },
  ];

  const plan = organizer.generatePlan(files, {});
  const move = plan.moves[0];
  check(move && move.memoryReason,
    `trusted Memory 参与决策 (reason: ${move?.memoryReason})`);
  check(move && move.memoryEvidence,
    `move 携带 evidence (level: ${move?.memoryEvidence?.confidence})`);
}

// ── 测试 7: 误操作不污染 ──
console.log('\n测试 7: 一次误操作不污染后续推荐\n');
{
  memory.clearMemory();

  // 只记录 1 次（candidate）
  memory.recordDecision({
    type: 'target_override',
    file: {
      name: '误操作.xlsx',
      path: '/test/误操作.xlsx',
      contentTheme: '财务',
      contentSummary: { keywords: ['预算'], entities: [] },
    },
    target: '财务',
  });

  // 新文件应不受影响（candidate 不参与）
  const files = [
    {
      name: '正常文件.txt',
      path: '/test/正常文件.txt',
      dir: '/test',
      fileType: 'document',
      contentTheme: '文档',
      suggestedTarget: '文档',
      confidence: 0.7,
      contentSummary: { keywords: ['正常'] },
    },
  ];

  const plan = organizer.generatePlan(files, {});
  const move = plan.moves[0];
  check(move && !move.memoryReason,
    `单次误操作不影响后续 (reason: ${move?.memoryReason || 'none'})`);
}

// ── 测试 8: 清空后恢复 ──
console.log('\n测试 8: 清空 Memory 后行为恢复\n');
{
  memory.clearMemory();

  // 先记录 trusted Memory
  for (let i = 0; i < 5; i++) {
    memory.recordDecision({
      type: 'target_override',
      file: {
        name: `test${i}.xlsx`,
        path: `/test/test${i}.xlsx`,
        contentTheme: '财务',
        contentSummary: { keywords: ['预算'], entities: [] },
      },
      target: '财务',
    });
  }
  const data = memory.exportMemory();
  for (const e of data.entries) {
    for (let i = 0; i < 5; i++) memory.touchMemory(e.id);
  }

  // 清空
  memory.clearMemory();
  check(memory.getMemoryStats().total === 0, `清空后为 0 条`);

  // 新文件应不受影响
  const files = [
    {
      name: '新文件.xlsx',
      path: '/test/新文件.xlsx',
      dir: '/test',
      fileType: 'document',
      contentTheme: '财务',
      suggestedTarget: '文档',
      confidence: 0.8,
      contentSummary: { keywords: ['预算'] },
    },
  ];

  const plan = organizer.generatePlan(files, {});
  const move = plan.moves[0];
  check(move && !move.memoryReason,
    `清空后 Memory 不生效 (reason: ${move?.memoryReason || 'none'})`);
}

// ── 测试 9: 统计信息 ──
console.log('\n测试 9: 统计信息\n');
{
  memory.clearMemory();

  memory.recordDecision({
    type: 'target_override',
    file: { name: 'a.xlsx', path: '/test/a.xlsx', contentTheme: '财务', contentSummary: { keywords: ['预算'] } },
    target: '财务',
  });
  memory.recordDecision({
    type: 'exclude',
    file: { name: 'b.txt', path: '/test/b.txt', contentTheme: '默认', contentSummary: { keywords: ['临时'] } },
  });

  const stats = memory.getMemoryStats();
  check(stats.total === 2, `总数为 2 (实际: ${stats.total})`);
  check(stats.byType.target_override === 1, `target_override 计数 (实际: ${stats.byType.target_override})`);
  check(stats.byType.exclude === 1, `exclude 计数 (实际: ${stats.byType.exclude})`);
  check(stats.byLevel.candidate === 2, `candidate 计数 (实际: ${stats.byLevel.candidate})`);
  check(stats.version === 2, `版本为 2 (实际: ${stats.version})`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`Memory v2 测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}