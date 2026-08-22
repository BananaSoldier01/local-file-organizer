/**
 * relationship-plan.js — 关系感知整理集成测试 (V0.4.3)
 *
 * 测试 Relationship Engine 接入 Plan Generation 的完整链路。
 *
 * 场景：
 * 1. 项目资料整理 — 同一项目的文件被正确分组并建议到同一目录
 * 2. 多项目 — 不同项目的文件不被合并
 * 3. 公共模板 — 模板文件不导致项目错误合并
 * 4. Group Naming — 分组名称正确生成
 * 5. 冲突处理 — 属于多个 group 的文件被标记
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const relationship = require('../engine/relationship');
const groupNamer = require('../engine/group-namer');
const organizer = require('../engine/organizer');

let passed = 0;
let failed = 0;

function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// ── 测试数据 ────────────────────────────────────────────────

const PROJECT_ALPHA_FILES = [
  {
    name: '项目A方案.md',
    path: '/test/项目A方案.md',
    dir: '/test',
    fileType: 'document',
    contentTheme: '项目',
    suggestedTarget: '文档',
    confidence: 0.85,
    contentSummary: {
      title: '项目A方案',
      keywords: ['项目A', '方案', '建设'],
      entities: ['项目A'],
    },
  },
  {
    name: '项目A预算.csv',
    path: '/test/项目A预算.csv',
    dir: '/test',
    fileType: 'document',
    contentTheme: '项目',
    suggestedTarget: '表格',
    confidence: 0.85,
    contentSummary: {
      title: '项目A预算',
      keywords: ['项目A', '预算', '建设'],
      entities: ['项目A'],
    },
  },
  {
    name: '项目A验收.txt',
    path: '/test/项目A验收.txt',
    dir: '/test',
    fileType: 'document',
    contentTheme: '项目',
    suggestedTarget: '文档',
    confidence: 0.85,
    contentSummary: {
      title: '项目A验收',
      keywords: ['项目A', '验收', '建设'],
      entities: ['项目A'],
    },
  },
];

const PROJECT_BETA_FILES = [
  {
    name: '项目B方案.md',
    path: '/test/项目B方案.md',
    dir: '/test',
    fileType: 'document',
    contentTheme: '项目',
    suggestedTarget: '文档',
    confidence: 0.85,
    contentSummary: {
      title: '项目B方案',
      keywords: ['项目B', '方案'],
      entities: ['项目B'],
    },
  },
  {
    name: '项目B预算.csv',
    path: '/test/项目B预算.csv',
    dir: '/test',
    fileType: 'document',
    contentTheme: '项目',
    suggestedTarget: '表格',
    confidence: 0.85,
    contentSummary: {
      title: '项目B预算',
      keywords: ['项目B', '预算'],
      entities: ['项目B'],
    },
  },
];

const TRAVEL_FILES = [
  {
    name: '旅游照片.jpg',
    path: '/test/旅游照片.jpg',
    dir: '/test',
    fileType: 'image',
    contentTheme: '个人照片',
    suggestedTarget: '图片',
    confidence: 0.9,
    contentSummary: {
      title: '旅游照片',
      keywords: ['旅游', '照片'],
      entities: [],
    },
  },
];

// ── 测试执行 ────────────────────────────────────────────────

console.log('\n=== V0.4.3 关系感知整理集成测试 ===\n');

// ── 测试 1: Group Suggestion 生成 ──
console.log('测试 1: Group Suggestion 生成\n');
{
  const allFiles = [...PROJECT_ALPHA_FILES, ...PROJECT_BETA_FILES, ...TRAVEL_FILES];
  const relResult = relationship.buildRelationshipGraph(allFiles);

  // 应该有 2 个 group（Alpha 和 Beta），Travel 独立
  const multiFileGroups = relResult.groups.filter(g => g.files.length >= 2);
  check(multiFileGroups.length === 2, `应产生 2 个多文件组 (实际: ${multiFileGroups.length})`);

  // Alpha group 应包含 3 个文件
  const alphaGroup = multiFileGroups.find(g => g.coreEntities.includes('项目A'));
  check(!!alphaGroup, `应找到项目A group`);
  if (alphaGroup) {
    check(alphaGroup.files.length === 3, `项目A group 包含 3 个文件 (实际: ${alphaGroup.files.length})`);
  }
}

// ── 测试 2: Group Naming ──
console.log('\n测试 2: Group Naming\n');
{
  const allFiles = [...PROJECT_ALPHA_FILES, ...PROJECT_BETA_FILES, ...TRAVEL_FILES];
  const relResult = relationship.buildRelationshipGraph(allFiles);
  const named = groupNamer.nameGroups(relResult.groups);

  const alphaGroup = named.find(g => g.coreEntities && g.coreEntities.includes('项目A'));
  check(!!alphaGroup, `应找到项目A group`);
  if (alphaGroup) {
    check(alphaGroup.suggestedName === '项目A', `项目A group 名称应为 "项目A" (实际: "${alphaGroup.suggestedName}")`);
    check(alphaGroup.nameConfidence >= 0.5, `名称置信度 >= 0.5 (实际: ${alphaGroup.nameConfidence})`);
    check(alphaGroup.nameFallback === false, `不应是 fallback 名称`);
  }

  const betaGroup = named.find(g => g.coreEntities && g.coreEntities.includes('项目B'));
  check(!!betaGroup, `应找到项目B group`);
  if (betaGroup) {
    check(betaGroup.suggestedName === '项目B', `项目B group 名称应为 "项目B" (实际: "${betaGroup.suggestedName}")`);
  }
}

// ── 测试 3: Relationship-aware Plan Generation ──
console.log('\n测试 3: Relationship-aware Plan Generation\n');
{
  const allFiles = [...PROJECT_ALPHA_FILES, ...PROJECT_BETA_FILES, ...TRAVEL_FILES];
  const relResult = relationship.buildRelationshipGraph(allFiles);

  // 生成 Plan，传入 relationshipGroups
  const plan = organizer.generatePlan(allFiles, {
    relationshipGroups: relResult.groups,
  });

  // Alpha 文件应被建议到 "项目A/" 目录
  const alphaMoves = plan.moves.filter(m => m.from.includes('项目A'));
  check(alphaMoves.length === 3, `项目A应有 3 条 move (实际: ${alphaMoves.length})`);

  for (const move of alphaMoves) {
    check(
      move.to.includes('项目A'),
      `${move.from} → ${move.to} 应包含 "项目A"`
    );
  }

  // Beta 文件应被建议到 "项目B/" 目录
  const betaMoves = plan.moves.filter(m => m.from.includes('项目B'));
  check(betaMoves.length === 2, `项目B应有 2 条 move (实际: ${betaMoves.length})`);
  for (const move of betaMoves) {
    check(
      move.to.includes('项目B'),
      `${move.from} → ${move.to} 应包含 "项目B"`
    );
  }

  // Travel 文件应保持独立分类
  const travelMoves = plan.moves.filter(m => m.from.includes('旅游'));
  check(travelMoves.length === 1, `旅游文件应有 1 条 move (实际: ${travelMoves.length})`);
  check(travelMoves[0].to.includes('图片'), `旅游文件应归入图片目录`);

  // Group Suggestions 应包含 Alpha 和 Beta
  check(plan.groupSuggestions.length >= 2, `应有 >= 2 个 group suggestion (实际: ${plan.groupSuggestions.length})`);
}

// ── 测试 4: 多项目不合并 ──
console.log('\n测试 4: 多项目不合并\n');
{
  const allFiles = [...PROJECT_ALPHA_FILES, ...PROJECT_BETA_FILES];
  const relResult = relationship.buildRelationshipGraph(allFiles);

  // Alpha 和 Beta 不应被分到同一组
  const allInOneGroup = relResult.groups.some(g =>
    g.files.length === 5 &&
    g.files.some(f => f.includes('项目A')) &&
    g.files.some(f => f.includes('项目B'))
  );
  check(!allInOneGroup, `项目A和项目B不应被合并到同一组`);

  // Plan 中 Alpha 和 Beta 应在不同目录
  const plan = organizer.generatePlan(allFiles, {
    relationshipGroups: relResult.groups,
  });

  const alphaTarget = plan.moves.find(m => m.from.includes('项目A方案'))?.to || '';
  const betaTarget = plan.moves.find(m => m.from.includes('项目B方案'))?.to || '';
  check(alphaTarget !== betaTarget, `项目A和项目B应目标到不同目录`);
  check(alphaTarget.includes('项目A'), `项目A目标包含 "项目A"`);
  check(betaTarget.includes('项目B'), `项目B目标包含 "项目B"`);
}

// ── 测试 5: 公共模板不导致项目合并 ──
console.log('\n测试 5: 公共模板不导致项目合并\n');
{
  const templateFile = {
    name: '报告模板.docx',
    path: '/test/报告模板.docx',
    dir: '/test',
    fileType: 'document',
    contentTheme: '模板',
    suggestedTarget: '文档',
    confidence: 0.7,
    contentSummary: {
      title: '报告模板',
      keywords: ['报告', '模板'],
      entities: [],
    },
  };

  const allFiles = [...PROJECT_ALPHA_FILES, templateFile];
  const relResult = relationship.buildRelationshipGraph(allFiles);

  // 模板文件不应与项目A文件合并
  const mergedGroup = relResult.groups.some(g =>
    g.files.length === 4 &&
    g.files.some(f => f.includes('项目A')) &&
    g.files.some(f => f.includes('报告模板'))
  );
  check(!mergedGroup, `模板文件不应与项目A文件合并`);

  // Plan 中模板文件应独立
  const plan = organizer.generatePlan(allFiles, {
    relationshipGroups: relResult.groups,
  });
  const templateMove = plan.moves.find(m => m.from.includes('报告模板'));
  check(!!templateMove, `模板文件应有 move`);
  if (templateMove) {
    check(!templateMove.to.includes('项目A'), `模板文件不应归入项目A目录`);
  }
}

// ── 测试 6: Group Suggestion 可解释性 ──
console.log('\n测试 6: Group Suggestion 可解释性\n');
{
  const allFiles = [...PROJECT_ALPHA_FILES, ...PROJECT_BETA_FILES, ...TRAVEL_FILES];
  const relResult = relationship.buildRelationshipGraph(allFiles);
  const plan = organizer.generatePlan(allFiles, {
    relationshipGroups: relResult.groups,
  });

  for (const suggestion of plan.groupSuggestions) {
    check(!!suggestion.groupName, `group 有名称: "${suggestion.groupName}"`);
    check(!!suggestion.nameReason, `group 有命名理由: "${suggestion.nameReason}"`);
    check(suggestion.files.length >= 2, `group 至少 2 个文件 (实际: ${suggestion.files.length})`);
    check(typeof suggestion.confidence === 'number', `group 有置信度: ${suggestion.confidence}`);
  }
}

// ── 测试 7: 冲突文件处理 ──
console.log('\n测试 7: 冲突文件处理\n');
{
  // V0.4.3.1: 验证 conflictFiles 是数组且结构正确
  const allFiles = [...PROJECT_ALPHA_FILES, ...PROJECT_BETA_FILES];
  const relResult = relationship.buildRelationshipGraph(allFiles);

  const plan = organizer.generatePlan(allFiles, {
    relationshipGroups: relResult.groups,
  });

  check(Array.isArray(plan.conflictFiles), `conflictFiles 是数组`);
  // V0.4.3.1: 修复永远成立的断言 conflictFiles.length >= 0
  // 改为验证：无冲突时长度为 0，有冲突时长度 > 0
  check(plan.conflictFiles.length === 0, `无冲突文件时 conflictFiles 为空 (实际: ${plan.conflictFiles.length})`);
}

// ── 测试 8: 不传 Relationship Groups 的兼容性 ──
console.log('\n测试 8: 不传 Relationship Groups 的兼容性\n');
{
  const allFiles = [...PROJECT_ALPHA_FILES, ...PROJECT_BETA_FILES];

  // 不传 relationshipGroups，应与旧版行为一致
  const plan = organizer.generatePlan(allFiles, {});

  check(plan.moves.length > 0, `不传 relationshipGroups 时仍有 moves (实际: ${plan.moves.length})`);
  check(plan.groupSuggestions.length === 0, `不传 relationshipGroups 时无 group suggestions`);
  check(Array.isArray(plan.conflictFiles), `conflictFiles 是数组（默认空）`);
}

// ── 测试 9: Group Naming 降级 ──
console.log('\n测试 9: Group Naming 降级\n');
{
  // 无实体、无关键词、无目录上下文的 group
  const naming = groupNamer.generateGroupName({
    coreEntities: [],
    themes: ['默认'],
    keywords: [],
    files: [{ dir: '' }, { dir: '' }],
  });

  check(naming.name === '项目资料', `无实体时降级为 "项目资料" (实际: "${naming.name}")`);
  check(naming.fallback === true, `应标记为 fallback`);
}

// ── 测试 10: Group Naming — 目录上下文 ──
console.log('\n测试 10: Group Naming — 目录上下文\n');
{
  const naming = groupNamer.generateGroupName({
    coreEntities: [],
    themes: ['默认'],
    keywords: [],
    files: [
      { dir: '/工作/南京联通' },
      { dir: '/工作/南京联通' },
    ],
  });

  check(naming.name === '南京联通', `目录上下文命名应为 "南京联通" (实际: "${naming.name}")`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`关系感知整理集成测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}