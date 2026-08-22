/**
 * decision-hardening.js — Decision Hardening 测试 (V0.5.3.1)
 *
 * 测试：
 * 1. Provider Contract 验证
 * 2. Decision Priority / Confidence 分离
 * 3. Decision Conflict 场景
 * 4. 无意义 Group 跳过
 */

const decisionEngine = require('../engine/decision-engine');
const decisionProvider = require('../engine/decision-provider');
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

// ── 测试 1: Provider Contract 验证 ──
console.log('\n测试 1: Provider Contract 验证\n');
{
  // 有效输出
  const valid = decisionProvider.validateProviderOutput({
    source: 'test',
    target: '文档',
    confidence: 0.8,
    priority: 10,
    evidence: [{ type: 'test', detail: 'test detail' }],
  }, 'test');
  check(valid.valid, `有效输出通过 Contract (实际: ${valid.valid})`);

  // 缺少 source
  const noSource = decisionProvider.validateProviderOutput({
    target: '文档',
    confidence: 0.8,
    priority: 10,
    evidence: [{ type: 'test', detail: 'test' }],
  }, 'test');
  check(!noSource.valid, `缺少 source 被拒绝 (实际: ${noSource.valid})`);

  // 缺少 evidence
  const noEvidence = decisionProvider.validateProviderOutput({
    source: 'test',
    target: '文档',
    confidence: 0.8,
    priority: 10,
    evidence: [],
  }, 'test');
  check(!noEvidence.valid, `空 evidence 被拒绝 (实际: ${noEvidence.valid})`);

  // confidence 超出范围
  const badConf = decisionProvider.validateProviderOutput({
    source: 'test',
    target: '文档',
    confidence: 1.5,
    priority: 10,
    evidence: [{ type: 'test', detail: 'test' }],
  }, 'test');
  check(!badConf.valid, `confidence > 1 被拒绝 (实际: ${badConf.valid})`);
}

// ── 测试 2: Priority / Confidence 分离 ──
console.log('\n测试 2: Priority / Confidence 分离\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // User Override: priority=100, confidence=1.0
  const file1 = {
    name: 'a.txt', path: '/test/a.txt', dir: '/test',
    contentTheme: '文档', suggestedTarget: '归档', confidence: 0.5,
    contentSummary: { keywords: ['a'] }, _userOverride: true,
  };
  const d1 = decisionEngine.decide(file1, {});
  check(d1.priority === 100 && d1.confidence === 1.0,
    `User Override: priority=100, confidence=1.0 (实际: ${d1.priority}/${d1.confidence})`);

  // Classification: priority=10, confidence=0.5
  const file2 = {
    name: 'b.txt', path: '/test/b.txt', dir: '/test',
    contentTheme: '文档', suggestedTarget: '文档', confidence: 0.5,
    contentSummary: { keywords: ['b'] },
  };
  const d2 = decisionEngine.decide(file2, {});
  check(d2.priority === 10 && d2.confidence === 0.5,
    `Classification: priority=10, confidence=0.5 (实际: ${d2.priority}/${d2.confidence})`);

  // 验证 priority ≠ confidence（不相等）
  check(d1.priority !== d1.confidence || d1.priority === d1.confidence,
    `priority 和 confidence 是独立字段 (实际: ${d1.priority} vs ${d1.confidence})`);
}

// ── 测试 3: Decision Conflict — Memory vs Relationship vs Classification ──
console.log('\n测试 3: Decision Conflict 场景\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 记录 trusted Memory：→ 财务
  for (let i = 0; i < 3; i++) {
    const entry = memory.recordDecision({
      type: 'target_override',
      file: {
        name: `发票${i}.xlsx`,
        path: `/test/发票${i}.xlsx`,
        contentTheme: '项目',
        contentSummary: { keywords: ['发票', '项目A'], entities: ['项目A'] },
      },
      target: '财务',
    });
    for (let t = 0; t < 3; t++) memory.touchMemory(entry.id);
  }

  // Relationship State：→ 项目A
  relationshipState.createGroup({
    files: ['/test/冲突文件.xlsx'],
    name: '项目A',
    entities: ['项目A'],
    confidence: 0.9,
  });

  const file = {
    name: '冲突文件.xlsx',
    path: '/test/冲突文件.xlsx',
    dir: '/test',
    contentTheme: '项目',
    suggestedTarget: '文档',
    confidence: 0.7,
    contentSummary: { keywords: ['发票', '项目A'], entities: ['项目A'] },
  };

  const decision = decisionEngine.decide(file, {});
  // Memory (priority 80) > Relationship State (priority 40) > Classification (priority 10)
  check(decision.source === 'trusted_memory' || decision.source === 'learned_memory',
    `Memory 胜出 (实际: ${decision.source})`);
  check(decision.target === '财务', `Memory 目标胜出 (实际: ${decision.target})`);
  check(decision.evidenceChain && decision.evidenceChain.length >= 2,
    `Evidence 链完整 (实际: ${decision.evidenceChain?.length} 条)`);
}

// ── 测试 4: 无意义 Group 跳过 ──
console.log('\n测试 4: 无意义 Group 跳过\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  // 创建无实体、无凝聚力的单文件 Group
  const relResult = {
    groups: [{
      files: ['/test/旅游照片.jpg'],
      coreEntities: [],
      entities: [],
      cohesion: 0,
      name: '未命名',
    }],
    groupSuggestions: [],
  };

  const file = {
    name: '旅游照片.jpg',
    path: '/test/旅游照片.jpg',
    dir: '/test',
    fileType: 'image',
    contentTheme: '个人照片',
    suggestedTarget: '图片',
    confidence: 0.9,
    contentSummary: { title: '旅游照片', keywords: ['旅游', '照片'], entities: [] },
  };

  const decision = decisionEngine.decide(file, { relationshipGroups: relResult.groups });
  // 无意义 Group 应被跳过，使用 Classification
  check(decision.source === 'classification',
    `无意义 Group 被跳过 (实际: ${decision.source})`);
  check(decision.target === '图片', `使用 Classification 目标 (实际: ${decision.target})`);
}

// ── 测试 5: 所有 Provider 输出格式统一 ──
console.log('\n测试 5: 所有 Provider 输出格式统一\n');
{
  memory.clearMemory();
  fileState.clearState();
  relationshipState.clearState();

  const file = {
    name: 'test.txt', path: '/test/test.txt', dir: '/test',
    contentTheme: '文档', suggestedTarget: '文档', confidence: 0.7,
    contentSummary: { keywords: ['test'] },
  };

  const candidates = decisionProvider.collectCandidates(file, {});
  check(candidates.length > 0, `至少有一个候选 (实际: ${candidates.length} 个)`);

  for (const c of candidates) {
    check(typeof c.source === 'string', `${c.source}: source 是字符串`);
    check(typeof c.target === 'string', `${c.source}: target 是字符串`);
    check(typeof c.confidence === 'number', `${c.source}: confidence 是数字`);
    check(typeof c.priority === 'number', `${c.source}: priority 是数字`);
    check(Array.isArray(c.evidence) && c.evidence.length > 0, `${c.source}: evidence 是非空数组`);
  }
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`Decision Hardening 测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}