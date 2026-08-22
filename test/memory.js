/**
 * memory.js — User Decision Memory 测试 (V0.4.5)
 *
 * 测试 Memory 模块的核心能力（兼容 Schema v2）。
 */

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

// ── 测试 1: 记录和查询 ──
console.log('\n测试 1: 记录和查询 Memory\n');
{
  memory.clearMemory();

  const entry = memory.recordDecision({
    type: 'target_override',
    file: {
      name: '预算.xlsx',
      path: '/test/预算.xlsx',
      contentTheme: '财务',
      contentSummary: { keywords: ['预算', '财务'], entities: [] },
    },
    target: '财务',
    reason: '用户将预算文件放入财务目录',
  });

  check(entry.type === 'target_override', `记录类型正确 (实际: ${entry.type})`);
  check(entry.action.target === '财务', `记录目标正确 (实际: ${entry.action.target})`);
  check(entry.source === 'user', `来源标记为 user (实际: ${entry.source})`);
  check(entry.id && entry.id.startsWith('mem_'), `ID 格式正确 (实际: ${entry.id})`);
  check(entry.timestamp, `有时间戳`);

  const results = memory.queryMemory({ keywords: ['预算'] });
  check(results.length === 1, `查询匹配 1 条 (实际: ${results.length})`);
  check(results[0].action.target === '财务', `查询结果目标正确 (实际: ${results[0].action.target})`);
}

// ── 测试 2: 关键词匹配 ──
console.log('\n测试 2: 关键词匹配\n');
{
  memory.clearMemory();

  memory.recordDecision({
    type: 'target_override',
    file: {
      name: '发票.xlsx',
      path: '/test/发票.xlsx',
      contentTheme: '财务',
      contentSummary: { keywords: ['发票', '税务', '报税'], entities: [] },
    },
    target: '个人/税务',
  });

  const r1 = memory.queryMemory({ keywords: ['发票'] });
  check(r1.length === 1, `关键词"发票"匹配 (实际: ${r1.length})`);

  const r2 = memory.queryMemory({ keywords: ['税务'] });
  check(r2.length === 1, `关键词"税务"匹配 (实际: ${r2.length})`);

  const r3 = memory.queryMemory({ keywords: ['无关词'] });
  check(r3.length === 0, `无匹配关键词返回空 (实际: ${r3.length})`);
}

// ── 测试 3: 从文件提取上下文 ──
console.log('\n测试 3: 从文件提取上下文\n');
{
  const file = {
    name: '2026项目预算.xlsx',
    path: '/test/2026项目预算.xlsx',
    contentTheme: '财务',
    contentSummary: {
      keywords: ['预算', '财务', '2026'],
      entities: ['项目A'],
    },
  };

  const ctx = memory.extractContext(file);
  check(ctx.contentKeywords.includes('预算'), `包含关键词"预算" (实际: ${ctx.contentKeywords})`);
  check(ctx.contentKeywords.includes('财务'), `包含主题"财务" (实际: ${ctx.contentKeywords})`);
  check(ctx.entities.includes('项目a'), `包含实体"项目A" (实际: ${ctx.entities})`);
  check(ctx.extension === 'xlsx', `扩展名正确 (实际: ${ctx.extension})`);
}

// ── 测试 4: Memory 建议查找 ──
console.log('\n测试 4: Memory 建议查找\n');
{
  memory.clearMemory();

  for (let i = 0; i < 3; i++) {
    memory.recordDecision({
      type: 'target_override',
      file: {
        name: `预算${i}.xlsx`,
        path: `/test/预算${i}.xlsx`,
        contentTheme: '财务',
        contentSummary: { keywords: ['预算', '财务'], entities: [] },
      },
      target: '财务',
    });
  }

  const newFile = {
    name: '2027项目预算.xlsx',
    path: '/test/2027项目预算.xlsx',
    contentTheme: '财务',
    contentSummary: { keywords: ['预算', '2027'] },
  };

  const suggestion = memory.lookupMemorySuggestion(newFile);
  check(suggestion !== null, `Memory 建议存在`);
  check(suggestion && suggestion.target === '财务', `建议目标为"财务" (实际: ${suggestion?.target})`);
  check(suggestion && suggestion.confidence >= 0.3, `置信度 >= 0.3 (实际: ${suggestion?.confidence})`);
}

// ── 测试 5: 无 Memory 时返回 null ──
console.log('\n测试 5: 无 Memory 时返回 null\n');
{
  memory.clearMemory();

  const file = {
    name: 'unknown.txt',
    path: '/test/unknown.txt',
    contentTheme: '默认',
    contentSummary: { keywords: ['未知'] },
  };

  const suggestion = memory.lookupMemorySuggestion(file);
  check(suggestion === null, `无 Memory 时返回 null (实际: ${JSON.stringify(suggestion)})`);
}

// ── 测试 6: 删除和清空 ──
console.log('\n测试 6: 删除和清空\n');
{
  memory.clearMemory();

  const e1 = memory.recordDecision({
    type: 'target_override',
    file: { name: 'a.xlsx', path: '/test/a.xlsx', contentTheme: '财务', contentSummary: { keywords: ['a'] } },
    target: 'A',
  });
  const e2 = memory.recordDecision({
    type: 'target_override',
    file: { name: 'b.xlsx', path: '/test/b.xlsx', contentTheme: '财务', contentSummary: { keywords: ['b'] } },
    target: 'B',
  });

  check(memory.getMemoryStats().total === 2, `有 2 条记录 (实际: ${memory.getMemoryStats().total})`);

  memory.deleteEntry(e1.id);
  check(memory.getMemoryStats().total === 1, `删除后剩 1 条 (实际: ${memory.getMemoryStats().total})`);

  memory.clearMemory();
  check(memory.getMemoryStats().total === 0, `清空后为 0 条 (实际: ${memory.getMemoryStats().total})`);
}

// ── 测试 7: 统计信息 ──
console.log('\n测试 7: 统计信息\n');
{
  memory.clearMemory();

  memory.recordDecision({
    type: 'target_override',
    file: { name: 'a.xlsx', path: '/test/a.xlsx', contentTheme: '财务', contentSummary: { keywords: ['a'] } },
    target: 'A',
  });
  memory.recordDecision({
    type: 'exclude',
    file: { name: 'b.txt', path: '/test/b.txt', contentTheme: '默认', contentSummary: { keywords: ['b'] } },
  });
  memory.recordDecision({
    type: 'relationship_accept',
    groupName: 'G1',
    relationshipGroup: 'G1',
  });

  const stats = memory.getMemoryStats();
  check(stats.total === 3, `总数为 3 (实际: ${stats.total})`);
  check(stats.byType.target_override === 1, `target_override 计数为 1 (实际: ${stats.byType.target_override})`);
  check(stats.byType.exclude === 1, `exclude 计数为 1 (实际: ${stats.byType.exclude})`);
  check(stats.byType.relationship_accept === 1, `relationship_accept 计数为 1 (实际: ${stats.byType.relationship_accept})`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`Memory 测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}