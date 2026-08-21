/**
 * relationship.js — 文件关系评估测试 (V0.4.2)
 *
 * 测试三个场景：
 * 1. 同一项目文件（应分组）
 * 2. 不同主题文件（不应分组）
 * 3. 弱文件名但同实体（应分组）
 *
 * 使用真实 buildRelationshipGraph()，不复制逻辑。
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

// ── 测试数据 ────────────────────────────────────────────────

/**
 * 场景 1: 同一项目文件
 * 三个文件属于同一项目，共享实体和主题。
 */
const SAME_PROJECT_FILES = [
  {
    name: '项目A_需求文档.md',
    content: '# 项目A需求文档\n\n## 功能\n- 用户登录\n- 权限管理\n\n## 技术栈\nReact + Node.js',
    contentTheme: '项目',
    contentSummary: {
      title: '项目A需求文档',
      summary: '项目A的需求分析文档，包含功能列表和技术栈选择。',
      keywords: ['项目A', '需求', '登录', '权限', 'React', 'Node.js'],
      entities: ['项目A', 'React', 'Node.js'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: '项目A_设计稿.md',
    content: '# 项目A UI设计稿\n\n## 页面\n- 首页\n- 登录页\n\n## 组件\nButton, Modal',
    contentTheme: '项目',
    contentSummary: {
      title: '项目A设计稿',
      summary: '项目A的UI设计规范，包含页面和组件设计。',
      keywords: ['项目A', '设计', 'UI', 'Button', 'Modal'],
      entities: ['项目A', 'Button', 'Modal'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: '项目A_测试报告.md',
    content: '# 项目A测试报告\n\n## 结果\n- 通过: 95%\n- 失败: 5%\n\n## 覆盖\n登录、权限、首页',
    contentTheme: '项目',
    contentSummary: {
      title: '项目A测试报告',
      summary: '项目A的测试结果，覆盖登录和权限模块。',
      keywords: ['项目A', '测试', '登录', '权限'],
      entities: ['项目A'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
];

/**
 * 场景 2: 不同主题文件
 * 三个文件属于完全不同的主题。
 */
const DIFFERENT_THEME_FILES = [
  {
    name: '会议纪要.md',
    content: '# 会议纪要\n\n## 时间\n2026年7月1日\n\n## 参与人\n张三、李四',
    contentTheme: '会议',
    contentSummary: {
      title: '会议纪要',
      summary: '团队会议记录，讨论项目进度和预算分配。',
      keywords: ['会议', '纪要', '进度', '预算'],
      entities: ['张三', '李四'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: '食谱.md',
    content: '# 番茄炒蛋食谱\n\n## 材料\n- 番茄 2个\n- 鸡蛋 3个\n\n## 步骤\n1. 切番茄',
    contentTheme: '食谱',
    contentSummary: {
      title: '番茄炒蛋食谱',
      summary: '家常菜番茄炒蛋的做法，简单易学。',
      keywords: ['番茄', '鸡蛋', '食谱', '炒蛋'],
      entities: ['番茄', '鸡蛋'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
  {
    name: '旅行计划.md',
    content: '# 日本旅行计划\n\n## 行程\n- Day1: 东京\n- Day2: 京都\n\n## 预算\n机票 3000, 住宿 5000',
    contentTheme: '旅行',
    contentSummary: {
      title: '日本旅行计划',
      summary: '日本东京京都旅行行程和预算规划。',
      keywords: ['日本', '旅行', '东京', '京都', '预算'],
      entities: ['东京', '京都'],
      confidence: 0.9,
      method: 'local-rules',
    },
  },
];

/**
 * 场景 3: 弱文件名但同实体
 * 文件名没有明确主题，但内容共享实体。
 */
const WEAK_FILENAME_FILES = [
  {
    name: '新建文档1.txt',
    content: '项目A的最新进展：完成了用户登录模块的开发，下一步是权限管理。',
    contentTheme: '项目',
    contentSummary: {
      title: '项目A进展',
      summary: '项目A最新进展，完成登录模块，下一步权限管理。',
      keywords: ['项目A', '登录', '权限'],
      entities: ['项目A'],
      confidence: 0.85,
      method: 'local-rules',
    },
  },
  {
    name: '新建文档2.txt',
    content: '项目A的UI设计评审：首页和登录页的组件设计已通过，Button和Modal组件符合规范。',
    contentTheme: '项目',
    contentSummary: {
      title: '项目A设计评审',
      summary: '项目A UI设计评审，首页和登录页组件通过审核。',
      keywords: ['项目A', 'UI', 'Button', 'Modal'],
      entities: ['项目A', 'Button', 'Modal'],
      confidence: 0.85,
      method: 'local-rules',
    },
  },
  {
    name: '资料1.txt',
    content: '项目A的测试覆盖率报告：登录和权限模块覆盖率达95%。',
    contentTheme: '项目',
    contentSummary: {
      title: '项目A测试报告',
      summary: '项目A测试覆盖率报告，登录和权限模块覆盖率达95%。',
      keywords: ['项目A', '测试', '登录', '权限'],
      entities: ['项目A'],
      confidence: 0.85,
      method: 'local-rules',
    },
  },
];

// ── 测试执行 ────────────────────────────────────────────────

console.log('\n=== V0.4.2 文件关系评估测试 ===\n');

// ── 测试 1: 同一项目文件 ──
console.log('测试 1: 同一项目文件分组\n');
{
  const result = relationship.buildRelationshipGraph(SAME_PROJECT_FILES);

  // 应该只有 1 个组（所有文件连通）
  check(result.stats.groups === 1, `所有文件应在同一组 (实际: ${result.stats.groups} 组)`);

  // 每个组应包含 3 个文件
  const group = result.groups[0];
  check(group.length === 3, `分组包含 3 个文件 (实际: ${group.length})`);

  // 分组建议名应包含项目A
  const analysis = relationship.analyzeGroup(group, result.fingerprints);
  check(
    analysis.suggestedName.includes('项目A') || analysis.suggestedName === '项目',
    `分组建议名包含项目标识: "${analysis.suggestedName}"`
  );

  // 置信度应较高
  check(analysis.confidence >= 0.5, `分组置信度 >= 0.5 (实际: ${analysis.confidence})`);

  // 边数应 >= 2（3个文件至少2条边才能连通）
  check(result.stats.totalEdges >= 2, `边数 >= 2 (实际: ${result.stats.totalEdges})`);

  // 相似度证据应包含主题匹配
  const hasThemeEvidence = result.groups.length > 0 && result.groups[0].length > 1;
  check(hasThemeEvidence, '分组包含多个文件');
}

// ── 测试 2: 不同主题文件 ──
console.log('\n测试 2: 不同主题文件不应分组\n');
{
  const result = relationship.buildRelationshipGraph(DIFFERENT_THEME_FILES);

  // 3个不同主题的文件应分为 3 个独立组
  check(result.stats.groups === 3, `不同主题应分为 3 组 (实际: ${result.stats.groups} 组)`);

  // 不应有边（无相似性）
  check(result.stats.totalEdges === 0, `不同主题间无边 (实际: ${result.stats.totalEdges} 条边)`);

  // 每组只有 1 个文件
  for (const group of result.groups) {
    check(group.length === 1, `每组只有 1 个文件 (实际: ${group.length})`);
  }
}

// ── 测试 3: 弱文件名但同实体 ──
console.log('\n测试 3: 弱文件名但同实体应分组\n');
{
  const result = relationship.buildRelationshipGraph(WEAK_FILENAME_FILES);

  // 三个文件共享实体"项目A"，应分到同一组
  check(result.stats.groups === 1, `共享实体应分为 1 组 (实际: ${result.stats.groups} 组)`);

  const group = result.groups[0];
  check(group.length === 3, `分组包含 3 个文件 (实际: ${group.length})`);

  // 分组建议名应包含项目A
  const analysis = relationship.analyzeGroup(group, result.fingerprints);
  check(
    analysis.suggestedName.includes('项目A') || analysis.suggestedName === '项目',
    `分组建议名包含项目标识: "${analysis.suggestedName}"`
  );

  // 至少有一条边（实体匹配）
  check(result.stats.totalEdges >= 2, `实体匹配产生边 (实际: ${result.stats.totalEdges} 条边)`);
}

// ── 测试 4: 候选过滤性能 ──
console.log('\n测试 4: 候选过滤性能\n');
{
  // 生成大量文件（模拟真实场景）
  // 50 个项目A文件 + 50 个会议纪要文件，文件名反映主题
  const manyFiles = [];
  for (let i = 0; i < 50; i++) {
    manyFiles.push({
      name: `项目A_模块${i}_设计.md`,
      content: `项目A模块${i}的设计文档.`,
      contentTheme: '项目',
      contentSummary: {
        title: `项目A模块${i}设计`,
        summary: `项目A模块${i}的设计文档.`,
        keywords: ['项目A', '设计', `模块${i}`],
        entities: ['项目A'],
        confidence: 0.8,
        method: 'local-rules',
      },
    });
  }
  for (let i = 0; i < 50; i++) {
    manyFiles.push({
      name: `会议纪要_${i}.md`,
      content: `第${i}次会议纪要.`,
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

  // 候选过滤应显著减少比较对数
  // 100 个文件全量比较 = 4950 对
  // 项目A文件内部: 50*49/2 = 1225, 会议文件内部: 50*49/2 = 1225
  // 跨主题: 0 (不同主题、不同关键词、不同实体、名称不相似)
  // 期望: ~2450 对
  check(
    result.stats.pairsChecked < 4950,
    `候选过滤减少比较对数 (实际: ${result.stats.pairsChecked} / 4950)`
  );

  // 执行时间应在合理范围内
  check(elapsed < 5000, `性能: 100 文件关系分析 < 5s (实际: ${elapsed}ms)`);

  // 应产生 2 个组（项目A组 + 会议组）
  check(result.stats.groups === 2, `应产生 2 个组 (实际: ${result.stats.groups} 组)`);
}

// ── 测试 5: 相似度计算 ──
console.log('\n测试 5: 相似度计算\n');
{
  const fp1 = fingerprint.buildFingerprint({
    name: '项目A_需求.md',
    contentTheme: '项目',
    contentSummary: {
      title: '项目A需求',
      keywords: ['项目A', '需求', '登录'],
      entities: ['项目A'],
    },
  });
  const fp2 = fingerprint.buildFingerprint({
    name: '项目A_设计.md',
    contentTheme: '项目',
    contentSummary: {
      title: '项目A设计',
      keywords: ['项目A', '设计', 'UI'],
      entities: ['项目A'],
    },
  });
  const fp3 = fingerprint.buildFingerprint({
    name: '会议纪要.md',
    contentTheme: '会议',
    contentSummary: {
      title: '会议纪要',
      keywords: ['会议', '纪要'],
      entities: [],
    },
  });

  // 同项目文件应高度相似
  const sim12 = similarity.similarity(fp1, fp2);
  check(sim12.score >= 0.5, `同项目相似度 >= 0.5 (实际: ${sim12.score})`);
  check(sim12.evidence.length > 0, `同项目有证据 (实际: ${sim12.evidence.length} 条)`);

  // 不同主题文件应低相似度
  const sim13 = similarity.similarity(fp1, fp3);
  check(sim13.score < 0.3, `不同主题相似度 < 0.3 (实际: ${sim13.score})`);

  // 候选过滤
  check(similarity.isCandidatePair(fp1, fp2) === true, `同项目应为候选对`);
  check(similarity.isCandidatePair(fp1, fp3) === false, `不同主题不应为候选对`);
}

// ── 测试 6: Fingerprint 生成 ──
console.log('\n测试 6: Fingerprint 生成\n');
{
  const fp = fingerprint.buildFingerprint({
    name: '项目A_需求文档.md',
    contentTheme: '项目',
    contentSummary: {
      title: '项目A需求文档',
      summary: '项目A的需求分析文档。',
      keywords: ['项目A', '需求'],
      entities: ['项目A'],
      confidence: 0.9,
      method: 'local-rules',
    },
  });

  check(fp.title === '项目A需求文档', `标题正确: "${fp.title}"`);
  check(fp.theme === '项目', `主题正确: "${fp.theme}"`);
  check(fp.keywords.includes('项目A'), `关键词包含项目A`);
  check(fp.entities.includes('项目A'), `实体包含项目A`);
  check(typeof fp.source === 'string', `来源字段存在: "${fp.source}"`);
}

// ── 测试 7: 关系报告可序列化 ──
console.log('\n测试 7: 关系报告可序列化\n');
{
  const result = relationship.buildRelationshipGraph(SAME_PROJECT_FILES);
  const report = relationship.generateReport(result);

  // 应该可以 JSON 序列化
  let serialized;
  try {
    serialized = JSON.stringify(report);
    check(true, '报告可 JSON 序列化');
  } catch (e) {
    check(false, `报告可 JSON 序列化: ${e.message}`);
  }

  // 反序列化后结构完整
  const parsed = JSON.parse(serialized);
  check(Array.isArray(parsed.groups), 'groups 是数组');
  check(Array.isArray(parsed.edges), 'edges 是数组');
  check(typeof parsed.stats === 'object', 'stats 是对象');
  check(parsed.stats.totalFiles === 3, `totalFiles = 3 (实际: ${parsed.stats.totalFiles})`);
}

// ── 测试 8: 空输入 ──
console.log('\n测试 8: 空输入处理\n');
{
  const result = relationship.buildRelationshipGraph([]);
  check(result.stats.totalFiles === 0, `空文件列表: totalFiles = 0`);
  check(result.stats.groups === 0, `空文件列表: groups = 0`);
  check(result.stats.totalEdges === 0, `空文件列表: edges = 0`);
}

// ── 测试 9: 单文件 ──
console.log('\n测试 9: 单文件处理\n');
{
  const result = relationship.buildRelationshipGraph([SAME_PROJECT_FILES[0]]);
  check(result.stats.totalFiles === 1, `单文件: totalFiles = 1`);
  check(result.stats.groups === 1, `单文件: groups = 1`);
  check(result.stats.totalEdges === 0, `单文件: edges = 0`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`文件关系评估: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}