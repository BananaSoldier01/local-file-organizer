/**
 * memory.js — User Decision Memory 测试 (V0.4.4)
 *
 * 测试 Memory 模块的核心能力：
 * 1. 记录用户决策
 * 2. 查询匹配的 Memory
 * 3. 从文件提取关键词
 * 4. Memory 建议查找
 * 5. 清空/删除
 */

const memory = require('../engine/memory');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
  // 清空
  memory.clearMemory();

  // 记录一条 target_override
  const entry = memory.recordDecision({
    type: 'target_override',
    filePattern: '*.xlsx',
    keywords: ['预算', '财务'],
    target: '财务',
    reason: '用户将预算文件放入财务目录',
  });

  check(entry.type === 'target_override', `记录类型正确 (实际: ${entry.type})`);
  check(entry.target === '财务', `记录目标正确 (实际: ${entry.target})`);
  check(entry.source === 'user', `来源标记为 user (实际: ${entry.source})`);
  check(entry.id && entry.id.startsWith('mem_'), `ID 格式正确 (实际: ${entry.id})`);
  check(entry.timestamp, `有时间戳`);

  // 查询
  const results = memory.queryMemory({ keywords: ['预算'] });
  check(results.length === 1, `查询匹配 1 条 (实际: ${results.length})`);
  check(results[0].target === '财务', `查询结果目标正确 (实际: ${results[0].target})`);
}

// ── 测试 2: 关键词匹配 ──
console.log('\n测试 2: 关键词匹配\n');
{
  memory.clearMemory();

  memory.recordDecision({
    type: 'target_override',
    keywords: ['发票', '税务', '报税'],
    target: '个人/税务',
  });

  // 精确匹配
  const r1 = memory.queryMemory({ keywords: ['发票'] });
  check(r1.length === 1, `关键词"发票"匹配 (实际: ${r1.length})`);

  // 部分匹配
  const r2 = memory.queryMemory({ keywords: ['税务'] });
  check(r2.length === 1, `关键词"税务"匹配 (实际: ${r2.length})`);

  // 无匹配
  const r3 = memory.queryMemory({ keywords: ['无关词'] });
  check(r3.length === 0, `无匹配关键词返回空 (实际: ${r3.length})`);
}

// ── 测试 3: 从文件提取关键词 ──
console.log('\n测试 3: 从文件提取关键词\n');
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

  const keywords = memory.extractFileKeywords(file);
  check(keywords.includes('2026项目预算'.toLowerCase()) || keywords.includes('2026'), `包含文件名片段 (实际: ${keywords})`);
  check(keywords.includes('预算'), `包含关键词"预算" (实际: ${keywords})`);
  check(keywords.includes('财务'), `包含主题"财务" (实际: ${keywords})`);
}

// ── 测试 4: Memory 建议查找 ──
console.log('\n测试 4: Memory 建议查找\n');
{
  memory.clearMemory();

  // 记录 3 次用户将预算文件放入"财务"
  memory.recordDecision({ type: 'target_override', keywords: ['预算', 'xlsx'], target: '财务' });
  memory.recordDecision({ type: 'target_override', keywords: ['预算', 'csv'], target: '财务' });
  memory.recordDecision({ type: 'target_override', keywords: ['预算', 'pdf'], target: '财务' });

  // 新文件
  const newFile = {
    name: '2027项目预算.xlsx',
    path: '/test/2027项目预算.xlsx',
    contentSummary: { keywords: ['预算', '2027'] },
  };

  const suggestion = memory.lookupMemorySuggestion(newFile);
  check(suggestion !== null, `Memory 建议存在`);
  check(suggestion && suggestion.target === '财务', `建议目标为"财务" (实际: ${suggestion?.target})`);
  check(suggestion && suggestion.confidence >= 0.5, `置信度 >= 0.5 (实际: ${suggestion?.confidence})`);
  check(suggestion && suggestion.count === 3, `匹配次数为 3 (实际: ${suggestion?.count})`);
}

// ── 测试 5: 无 Memory 时返回 null ──
console.log('\n测试 5: 无 Memory 时返回 null\n');
{
  memory.clearMemory();

  const file = {
    name: 'unknown.txt',
    path: '/test/unknown.txt',
    contentSummary: { keywords: ['未知'] },
  };

  const suggestion = memory.lookupMemorySuggestion(file);
  check(suggestion === null, `无 Memory 时返回 null (实际: ${JSON.stringify(suggestion)})`);
}

// ── 测试 6: 删除和清空 ──
console.log('\n测试 6: 删除和清空\n');
{
  memory.clearMemory();

  const e1 = memory.recordDecision({ type: 'target_override', keywords: ['test1'], target: 'A' });
  const e2 = memory.recordDecision({ type: 'target_override', keywords: ['test2'], target: 'B' });

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

  memory.recordDecision({ type: 'target_override', keywords: ['a'], target: 'A' });
  memory.recordDecision({ type: 'exclude', keywords: ['b'] });
  memory.recordDecision({ type: 'relationship_accept', groupName: 'G1' });

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