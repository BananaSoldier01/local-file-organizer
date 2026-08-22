/**
 * relationship.js — 文件关系评估测试 (V0.4.2.1)
 *
 * V0.4.2.1 核心修复：
 * - 真正的 Precision / Recall / False Positive 评估
 * - Hard Negatives：多项目同主题、bridge file、公共模板
 * - 候选索引性能验证
 * - Group Cohesion 约束验证
 * - 每个数据集使用唯一实体名，避免跨数据集假关联
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const relationship = require('../engine/relationship');
const fingerprint = require('../engine/fingerprint');
const similarity = require('../engine/similarity');

let passed = 0;
let failed = 0;

function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// ── 测试数据集 ──────────────────────────────────────────────
// 每个数据集使用唯一的实体名，避免跨数据集假关联

const DATASET = {
  // ── 正例：项目Alpha（3 个文件，共享实体 alpha） ──
  groupAlpha: [
    {
      name: 'Alpha_需求文档.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Alpha需求文档',
        summary: 'Alpha项目的需求分析文档，包含功能列表和技术栈选择。',
        keywords: ['Alpha', '需求', '登录', '权限', 'React', 'Node.js'],
        entities: ['Alpha', 'React', 'Node.js'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: 'Alpha_设计稿.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Alpha设计稿',
        summary: 'Alpha项目的UI设计规范，包含页面和组件设计。',
        keywords: ['Alpha', '设计', 'UI', 'Button', 'Modal'],
        entities: ['Alpha', 'Button', 'Modal'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: 'Alpha_测试报告.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Alpha测试报告',
        summary: 'Alpha项目的测试结果，覆盖登录和权限模块。',
        keywords: ['Alpha', '测试', '登录', '权限'],
        entities: ['Alpha'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
  ],

  // ── 正例：项目Beta（3 个文件，共享实体 beta） ──
  groupBeta: [
    {
      name: 'Beta_架构设计.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Beta架构设计',
        summary: 'Beta项目的系统架构设计文档。',
        keywords: ['Beta', '架构', '微服务', '数据库'],
        entities: ['Beta', '微服务'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: 'Beta_接口文档.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Beta接口文档',
        summary: 'Beta项目的API接口文档。',
        keywords: ['Beta', 'API', '接口', 'REST'],
        entities: ['Beta'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: 'Beta_部署指南.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Beta部署指南',
        summary: 'Beta项目的部署和运维指南。',
        keywords: ['Beta', '部署', 'Docker', 'K8s'],
        entities: ['Beta', 'Docker'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
  ],

  // ── 正例：弱文件名但同实体（Alpha） ──
  weakFilenameAlpha: [
    {
      name: '新建文档1.txt',
      contentTheme: '项目',
      contentSummary: {
        title: 'Alpha进展',
        summary: 'Alpha最新进展，完成登录模块，下一步权限管理。',
        keywords: ['Alpha', '登录', '权限'],
        entities: ['Alpha'],
        confidence: 0.85,
        method: 'local-rules',
      },
    },
    {
      name: '新建文档2.txt',
      contentTheme: '项目',
      contentSummary: {
        title: 'Alpha设计评审',
        summary: 'Alpha UI设计评审，首页和登录页组件通过审核。',
        keywords: ['Alpha', 'UI', 'Button'],
        entities: ['Alpha', 'Button'],
        confidence: 0.85,
        method: 'local-rules',
      },
    },
    {
      name: '资料1.txt',
      contentTheme: '项目',
      contentSummary: {
        title: 'Alpha测试报告',
        summary: 'Alpha测试覆盖率报告，登录和权限模块覆盖率达95%。',
        keywords: ['Alpha', '测试', '登录', '权限'],
        entities: ['Alpha'],
        confidence: 0.85,
        method: 'local-rules',
      },
    },
  ],

  // ── Hard Negative 1: 多项目同主题（Gamma 和 Delta，theme=项目，实体不同） ──
  multiProjectSameTheme: [
    {
      name: 'Gamma_需求文档.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Gamma需求文档',
        summary: 'Gamma项目的需求分析文档。',
        keywords: ['Gamma', '需求', '登录'],
        entities: ['Gamma'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: 'Delta_架构设计.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Delta架构设计',
        summary: 'Delta项目的系统架构设计文档。',
        keywords: ['Delta', '架构', '微服务'],
        entities: ['Delta', '微服务'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
  ],

  // ── Hard Negative 2: Bridge File（桥接 Gamma 和 Delta） ──
  bridgeFile: [
    {
      name: 'Gamma_需求文档.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Gamma需求文档',
        summary: 'Gamma项目的需求分析文档。',
        keywords: ['Gamma', '需求', '登录'],
        entities: ['Gamma'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: '跨项目会议纪要.md',
      contentTheme: '会议',
      contentSummary: {
        title: '跨项目会议纪要',
        summary: 'Gamma和Delta的联合会议记录，讨论了接口对接方案。',
        keywords: ['Gamma', 'Delta', '会议', '接口'],
        entities: ['Gamma', 'Delta'],
        confidence: 0.85,
        method: 'local-rules',
      },
    },
    {
      name: 'Delta_架构设计.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Delta架构设计',
        summary: 'Delta项目的系统架构设计文档。',
        keywords: ['Delta', '架构', '微服务'],
        entities: ['Delta', '微服务'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
  ],

  // ── Hard Negative 3: 公共模板（无项目实体） ──
  publicTemplates: [
    {
      name: '会议纪要模板.md',
      contentTheme: '模板',
      contentSummary: {
        title: '会议纪要模板',
        summary: '通用会议纪要模板，包含时间、参与人、议题等字段。',
        keywords: ['会议', '纪要', '模板', '时间'],
        entities: [],
        confidence: 0.7,
        method: 'local-rules',
      },
    },
    {
      name: '需求文档模板.md',
      contentTheme: '模板',
      contentSummary: {
        title: '需求文档模板',
        summary: '通用需求文档模板，包含功能、非功能、验收标准等字段。',
        keywords: ['需求', '文档', '模板', '功能'],
        entities: [],
        confidence: 0.7,
        method: 'local-rules',
      },
    },
  ],

  // ── Hard Negative 4: 同目录但不同项目（Epsilon 和 Zeta） ──
  sameDirDifferentProject: [
    {
      name: 'Epsilon_需求文档.md',
      contentTheme: '项目',
      dir: '工作/项目',
      contentSummary: {
        title: 'Epsilon需求文档',
        summary: 'Epsilon项目的需求分析文档。',
        keywords: ['Epsilon', '需求'],
        entities: ['Epsilon'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: 'Zeta_架构设计.md',
      contentTheme: '项目',
      dir: '工作/项目',
      contentSummary: {
        title: 'Zeta架构设计',
        summary: 'Zeta项目的系统架构设计文档。',
        keywords: ['Zeta', '架构'],
        entities: ['Zeta'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
  ],

  // ── Hard Negative 5: 不同主题文件 ──
  differentThemes: [
    {
      name: '会议纪要.md',
      contentTheme: '会议',
      contentSummary: {
        title: '会议纪要',
        summary: '团队会议记录。',
        keywords: ['会议', '纪要'],
        entities: [],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: '食谱.md',
      contentTheme: '食谱',
      contentSummary: {
        title: '番茄炒蛋食谱',
        summary: '家常菜番茄炒蛋的做法。',
        keywords: ['番茄', '鸡蛋', '食谱'],
        entities: [],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: '旅行计划.md',
      contentTheme: '旅行',
      contentSummary: {
        title: '日本旅行计划',
        summary: '日本东京京都旅行行程。',
        keywords: ['日本', '旅行', '东京'],
        entities: [],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
  ],
};

// ── Ground Truth 映射 ──────────────────────────────────────
// file name → expected group label
const GROUND_TRUTH = {};
for (const f of DATASET.groupAlpha) GROUND_TRUTH[f.name] = 'Alpha';
for (const f of DATASET.groupBeta) GROUND_TRUTH[f.name] = 'Beta';
for (const f of DATASET.weakFilenameAlpha) GROUND_TRUTH[f.name] = 'Alpha';

// ── 测试执行 ────────────────────────────────────────────────

console.log('\n=== V0.4.2.1 文件关系评估测试 ===\n');

// ── 测试 1: 同一项目文件分组 (Group Alpha) ──
console.log('测试 1: 同一项目文件分组 (Alpha)\n');
{
  const result = relationship.buildRelationshipGraph(DATASET.groupAlpha);

  check(result.stats.groups === 1, `所有文件应在同一组 (实际: ${result.stats.groups} 组)`);

  const group = result.groups[0];
  check(group.files.length === 3, `分组包含 3 个文件 (实际: ${group.files.length})`);
  check(group.coreEntities.includes('Alpha'), `核心实体包含 Alpha: ${JSON.stringify(group.coreEntities)}`);
  check(group.cohesion >= 0.5, `组凝聚力 >= 0.5 (实际: ${group.cohesion})`);
}

// ── 测试 2: 不同主题文件不应分组 ──
console.log('\n测试 2: 不同主题文件不应分组\n');
{
  const result = relationship.buildRelationshipGraph(DATASET.differentThemes);

  check(result.stats.groups === 3, `不同主题应分为 3 组 (实际: ${result.stats.groups} 组)`);
  check(result.stats.totalEdges === 0, `不同主题间无边 (实际: ${result.stats.totalEdges} 条边)`);
  for (const group of result.groups) {
    check(group.files.length === 1, `每组只有 1 个文件 (实际: ${group.files.length})`);
  }
}

// ── 测试 3: 弱文件名但同实体 ──
console.log('\n测试 3: 弱文件名但同实体应分组\n');
{
  const result = relationship.buildRelationshipGraph(DATASET.weakFilenameAlpha);

  check(result.stats.groups === 1, `共享实体应分为 1 组 (实际: ${result.stats.groups} 组)`);
  const group = result.groups[0];
  check(group.files.length === 3, `分组包含 3 个文件 (实际: ${group.files.length})`);
  check(group.coreEntities.includes('Alpha'), `核心实体包含 Alpha: ${JSON.stringify(group.coreEntities)}`);
}

// ── 测试 4: Hard Negative — 多项目同主题 ──
console.log('\n测试 4: Hard Negative — 多项目同主题不应分组\n');
{
  const result = relationship.buildRelationshipGraph(DATASET.multiProjectSameTheme);

  // Gamma 和 Delta 都是 theme=项目，但实体完全不同
  check(result.stats.groups === 2, `不同项目应分为 2 组 (实际: ${result.stats.groups} 组)`);
  check(result.stats.totalEdges === 0, `不同项目间无边 (实际: ${result.stats.totalEdges} 条边)`);
}

// ── 测试 5: Hard Negative — Bridge File ──
console.log('\n测试 5: Hard Negative — Bridge File 不应合并项目\n');
{
  const result = relationship.buildRelationshipGraph(DATASET.bridgeFile);

  // Bridge file 同时提到 Gamma 和 Delta
  // 不应将两个项目合并为一个组
  const largeGroups = result.groups.filter(g => g.files.length >= 3);
  check(largeGroups.length === 0, `不应形成 3+ 文件大组 (实际: ${largeGroups.length} 个)`);

  for (const group of result.groups) {
    const hasGamma = group.files.some(f => (f.path || f).includes('Gamma'));
    const hasDelta = group.files.some(f => (f.path || f).includes('Delta'));
    check(!(hasGamma && hasDelta), `组不应同时包含Gamma和Delta: ${JSON.stringify(group.files)}`);
  }
}

// ── 测试 6: Hard Negative — 公共模板 ──
console.log('\n测试 6: Hard Negative — 公共模板不应分组\n');
{
  const result = relationship.buildRelationshipGraph(DATASET.publicTemplates);

  check(result.stats.groups === 2, `公共模板应分为 2 组 (实际: ${result.stats.groups} 组)`);
  check(result.stats.totalEdges === 0, `公共模板间无边 (实际: ${result.stats.totalEdges} 条边)`);
}

// ── 测试 7: Hard Negative — 同目录不同项目 ──
console.log('\n测试 7: Hard Negative — 同目录但不同项目不应分组\n');
{
  const result = relationship.buildRelationshipGraph(DATASET.sameDirDifferentProject);

  // 同目录 + 同主题，但实体完全不同 → 不应分组
  check(result.stats.groups === 2, `同目录不同项目应分为 2 组 (实际: ${result.stats.groups} 组)`);
}

// ── 测试 8: 候选索引性能 ──
console.log('\n测试 8: 候选索引性能\n');
{
  const manyFiles = [];
  for (let i = 0; i < 50; i++) {
    manyFiles.push({
      name: `Alpha_模块${i}_设计.md`,
      contentTheme: '项目',
      contentSummary: {
        title: `Alpha模块${i}设计`,
        summary: `Alpha模块${i}的设计文档.`,
        keywords: ['Alpha', '设计', `模块${i}`],
        entities: ['Alpha'],
        confidence: 0.8,
        method: 'local-rules',
      },
    });
  }
  for (let i = 0; i < 50; i++) {
    manyFiles.push({
      name: `会议纪要_${i}.md`,
      contentTheme: '会议',
      contentSummary: {
        title: `会议纪要_${i}`,
        summary: `第${i}次会议纪要.`,
        keywords: ['会议', '纪要'],
        entities: [],
        confidence: 0.8,
        method: 'local-rules',
      },
    });
  }

  const start = Date.now();
  const result = relationship.buildRelationshipGraph(manyFiles);
  const elapsed = Date.now() - start;

  check(
    result.stats.candidatePairs < 4950,
    `候选索引减少比较对数 (实际: ${result.stats.candidatePairs} / 4950)`
  );
  check(elapsed < 5000, `性能: 100 文件关系分析 < 5s (实际: ${elapsed}ms)`);
  check(result.stats.groups === 2, `应产生 2 个组 (实际: ${result.stats.groups} 组)`);
}

// ── 测试 9: 主题相同不能单独计分 ──
console.log('\n测试 9: 主题相同不能单独计分\n');
{
  const fp1 = fingerprint.buildFingerprint({
    name: 'Alpha_需求.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'Alpha需求',
      keywords: ['Alpha', '需求', '登录'],
      entities: ['Alpha'],
    },
  });
  const fp2 = fingerprint.buildFingerprint({
    name: 'Beta_架构.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'Beta架构',
      keywords: ['Beta', '架构', '微服务'],
      entities: ['Beta', '微服务'],
    },
  });

  const sim = similarity.similarity(fp1, fp2);
  check(sim.score < 0.3, `同主题无证据时相似度 < 0.3 (实际: ${sim.score})`);
  check(!sim.signals.theme, `同主题无额外证据时不给主题信号`);
}

// ── 测试 10: 有实体证据时主题才计分 ──
console.log('\n测试 10: 有实体证据时主题才计分\n');
{
  const fp1 = fingerprint.buildFingerprint({
    name: 'Alpha_需求.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'Alpha需求',
      keywords: ['Alpha', '需求', '登录'],
      entities: ['Alpha'],
    },
  });
  const fp2 = fingerprint.buildFingerprint({
    name: 'Alpha_设计.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'Alpha设计',
      keywords: ['Alpha', '设计', 'UI'],
      entities: ['Alpha'],
    },
  });

  const sim = similarity.similarity(fp1, fp2);
  check(sim.score >= 0.4, `有实体证据时相似度 >= 0.4 (实际: ${sim.score})`);
  check(sim.signals.theme === true, `有实体证据时给主题信号`);
  check(sim.signals.entity > 0, `有实体信号`);
}

// ── 测试 11: Group Evidence — 真共享实体 ──
console.log('\n测试 11: Group Evidence — 真共享实体\n');
{
  const result = relationship.buildRelationshipGraph(DATASET.groupAlpha);
  const group = result.groups[0];

  check(group.coreEntities.includes('Alpha'), `核心实体包含 Alpha`);

  const fpMap = new Map();
  for (const fp of result.fingerprints) {
    fpMap.set(fp.id, fp.fingerprint);
  }
  for (const f of group.files) {
    const fileId = typeof f === 'string' ? f : (f.path || f.name);
    const fp = fpMap.get(fileId);
    check(fp && (fp.entities || []).includes('Alpha'), `文件 ${fileId} 包含实体 Alpha`);
  }
}

// ── 测试 12: Group Cohesion 约束 ──
console.log('\n测试 12: Group Cohesion 约束\n');
{
  const files = [
    {
      name: 'Alpha_需求.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Alpha需求',
        keywords: ['Alpha', '需求'],
        entities: ['Alpha'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: 'Alpha_设计.md',
      contentTheme: '项目',
      contentSummary: {
        title: 'Alpha设计',
        keywords: ['Alpha', '设计'],
        entities: ['Alpha'],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
    {
      name: '会议纪要.md',
      contentTheme: '会议',
      contentSummary: {
        title: '会议纪要',
        keywords: ['会议', '纪要'],
        entities: [],
        confidence: 0.9,
        method: 'local-rules',
      },
    },
  ];

  const result = relationship.buildRelationshipGraph(files);
  check(result.stats.groups >= 2, `弱连接不应合并 (实际: ${result.stats.groups} 组)`);
}

// ── 测试 13: Fingerprint 生成 ──
console.log('\n测试 13: Fingerprint 生成\n');
{
  const fp = fingerprint.buildFingerprint({
    name: 'Alpha_需求文档.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'Alpha需求文档',
      summary: 'Alpha的需求分析文档。',
      keywords: ['Alpha', '需求'],
      entities: ['Alpha'],
      confidence: 0.9,
      method: 'local-rules',
    },
  });

  check(fp.title === 'Alpha需求文档', `标题正确: "${fp.title}"`);
  check(fp.theme === '项目', `主题正确: "${fp.theme}"`);
  check(fp.keywords.includes('Alpha'), `关键词包含 Alpha`);
  check(fp.entities.includes('Alpha'), `实体包含 Alpha`);
}

// ── 测试 14: 关系报告可序列化 ──
console.log('\n测试 14: 关系报告可序列化\n');
{
  const result = relationship.buildRelationshipGraph(DATASET.groupAlpha);
  const report = relationship.generateReport(result);

  let serialized;
  try {
    serialized = JSON.stringify(report);
    check(true, '报告可 JSON 序列化');
  } catch (e) {
    check(false, `报告可 JSON 序列化: ${e.message}`);
  }

  const parsed = JSON.parse(serialized);
  check(Array.isArray(parsed.groups), 'groups 是数组');
  check(Array.isArray(parsed.edges), 'edges 是数组');
  check(typeof parsed.stats === 'object', 'stats 是对象');
  check(parsed.stats.totalFiles === 3, `totalFiles = 3 (实际: ${parsed.stats.totalFiles})`);
}

// ── 测试 15: 空输入 / 单文件 ──
console.log('\n测试 15: 空输入 / 单文件处理\n');
{
  const emptyResult = relationship.buildRelationshipGraph([]);
  check(emptyResult.stats.totalFiles === 0, `空文件列表: totalFiles = 0`);
  check(emptyResult.stats.groups === 0, `空文件列表: groups = 0`);

  const singleResult = relationship.buildRelationshipGraph([DATASET.groupAlpha[0]]);
  check(singleResult.stats.totalFiles === 1, `单文件: totalFiles = 1`);
  check(singleResult.stats.groups === 1, `单文件: groups = 1`);
  check(singleResult.stats.totalEdges === 0, `单文件: edges = 0`);
}

// ── Precision / Recall / F1 计算 ────────────────────────────
console.log('\n=== Precision / Recall / False Positive Rate ===\n');

// 构建独立的 Precision/Recall 数据集
// 每个文件使用唯一实体名，避免跨数据集假关联
const prFiles = [
  // 正例：项目 Alpha（3 个文件）
  {
    name: 'PR_Alpha_需求.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Alpha需求',
      keywords: ['PR_Alpha', '需求', '登录'],
      entities: ['PR_Alpha'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: 'PR_Alpha_设计.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Alpha设计',
      keywords: ['PR_Alpha', '设计', 'UI'],
      entities: ['PR_Alpha'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: 'PR_Alpha_测试.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Alpha测试',
      keywords: ['PR_Alpha', '测试', '登录'],
      entities: ['PR_Alpha'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  // 正例：项目 Beta（3 个文件）
  {
    name: 'PR_Beta_架构.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Beta架构',
      keywords: ['PR_Beta', '架构', '微服务'],
      entities: ['PR_Beta'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: 'PR_Beta_接口.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Beta接口',
      keywords: ['PR_Beta', 'API', '接口'],
      entities: ['PR_Beta'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: 'PR_Beta_部署.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Beta部署',
      keywords: ['PR_Beta', '部署', 'Docker'],
      entities: ['PR_Beta'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  // Hard Negative: 同主题不同项目（Gamma 和 Delta）
  {
    name: 'PR_Gamma_需求.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Gamma需求',
      keywords: ['PR_Gamma', '需求'],
      entities: ['PR_Gamma'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: 'PR_Delta_架构.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Delta架构',
      keywords: ['PR_Delta', '架构'],
      entities: ['PR_Delta'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  // Hard Negative: Bridge File（同时提到 Gamma 和 Delta，但不合并）
  {
    name: 'PR_Gamma_需求.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Gamma需求',
      keywords: ['PR_Gamma', '需求'],
      entities: ['PR_Gamma'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: 'PR_跨项目会议.md',
    contentTheme: '会议',
    contentSummary: {
      title: 'PR_跨项目会议',
      keywords: ['PR_Gamma', 'PR_Delta', '会议'],
      entities: ['PR_Gamma', 'PR_Delta'],
      confidence: 0.85,
      method: 'local-rules',
    },
  },
  {
    name: 'PR_Delta_架构.md',
    contentTheme: '项目',
    contentSummary: {
      title: 'PR_Delta架构',
      keywords: ['PR_Delta', '架构'],
      entities: ['PR_Delta'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  // Hard Negative: 公共模板（无实体）
  {
    name: 'PR_会议模板.md',
    contentTheme: '模板',
    contentSummary: {
      title: 'PR_会议模板',
      keywords: ['会议', '模板'],
      entities: [],
      confidence: 0.7,
      method: 'local-rules',
    },
  },
  {
    name: 'PR_需求模板.md',
    contentTheme: '模板',
    contentSummary: {
      title: 'PR_需求模板',
      keywords: ['需求', '模板'],
      entities: [],
      confidence: 0.7,
      method: 'local-rules',
    },
  },
  // Hard Negative: 不同主题
  {
    name: 'PR_食谱.md',
    contentTheme: '食谱',
    contentSummary: {
      title: 'PR_食谱',
      keywords: ['番茄', '鸡蛋'],
      entities: [],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: 'PR_旅行.md',
    contentTheme: '旅行',
    contentSummary: {
      title: 'PR_旅行',
      keywords: ['日本', '东京'],
      entities: [],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
];

// 注意：PR_Gamma_需求.md 和 PR_Delta_架构.md 在 multiProjectSameTheme 和 bridgeFile 中重复
// 需要去重（同一文件名 = 同一文件）
const uniquePRFiles = [];
const seenNames = new Set();
for (const f of prFiles) {
  if (!seenNames.has(f.name)) {
    seenNames.add(f.name);
    uniquePRFiles.push(f);
  }
}

// Ground Truth: 文件名 → group label
const prTruth = {};
for (const f of prFiles) {
  if (f.name.startsWith('PR_Alpha')) prTruth[f.name] = 'Alpha';
  if (f.name.startsWith('PR_Beta')) prTruth[f.name] = 'Beta';
}

const prResult = relationship.buildRelationshipGraph(uniquePRFiles);

// 构建预测分组映射
const prPredicted = {};
for (let g = 0; g < prResult.groups.length; g++) {
  for (const f of prResult.groups[g].files) {
    // V0.4.3.1: group.files 现在是对象数组，提取 name 作为 key
    const fId = typeof f === 'string' ? f : (f.name || f.path);
    prPredicted[fId] = g;
  }
}

// 计算 TP / FP / FN / TN
let prTP = 0, prFP = 0, prFN = 0, prTN = 0;

const prFileNames = uniquePRFiles.map(f => f.name);
for (let i = 0; i < prFileNames.length; i++) {
  for (let j = i + 1; j < prFileNames.length; j++) {
    const nameA = prFileNames[i];
    const nameB = prFileNames[j];
    const truthA = prTruth[nameA] || null;
    const truthB = prTruth[nameB] || null;
    const predA = prPredicted[nameA];
    const predB = prPredicted[nameB];

    const shouldGroup = truthA && truthB && truthA === truthB;
    const didGroup = predA !== undefined && predB !== undefined && predA === predB;

    if (shouldGroup && didGroup) {
      prTP++;
    } else if (!shouldGroup && didGroup) {
      prFP++;
    } else if (shouldGroup && !didGroup) {
      prFN++;
    } else {
      prTN++;
    }
  }
}

const precision = prTP + prFP > 0 ? prTP / (prTP + prFP) : 0;
const recall = prTP + prFN > 0 ? prTP / (prTP + prFN) : 0;
const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
const falsePositiveRate = prFP + prTN > 0 ? prFP / (prFP + prTN) : 0;

console.log(`  True Positive pairs:  ${prTP}`);
console.log(`  False Positive pairs: ${prFP}`);
console.log(`  False Negative pairs: ${prFN}`);
console.log(`  True Negative pairs:  ${prTN}`);
console.log(`  Precision: ${precision.toFixed(3)}`);
console.log(`  Recall:    ${recall.toFixed(3)}`);
console.log(`  F1:        ${f1.toFixed(3)}`);
console.log(`  FPR:       ${falsePositiveRate.toFixed(3)}`);

check(precision >= 0.8, `Precision >= 0.8 (实际: ${precision.toFixed(3)})`);
check(recall >= 0.8, `Recall >= 0.8 (实际: ${recall.toFixed(3)})`);
check(f1 >= 0.8, `F1 >= 0.8 (实际: ${f1.toFixed(3)})`);
check(falsePositiveRate <= 0.15, `False Positive Rate <= 0.15 (实际: ${falsePositiveRate.toFixed(3)})`);

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`文件关系评估: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}