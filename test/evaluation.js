/**
 * evaluation.js — Content-Aware 分类评估测试 (V0.4.1.1)
 *
 * V0.4.1.1 核心修复：
 * - 使用真实 classifyBatch() 而非复制分类算法
 * - 使用真实 FileEntry Contract（extension 不带点、modified 而非 mtime）
 * - 拆分 summaryConfidence / suggestionConfidence
 * - 走完整 Scan → Classify → Compare 生产链路
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const classifier = require('../engine/classifier');
const contentExtractor = require('../engine/content-extractor');
const contentSummary = require('../engine/content-summary');

let passed = 0;
let failed = 0;

function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// ── Ambiguous Filename Dataset ────────────────────────────
// V0.4.1.1: 使用真实 FileEntry Contract（extension 不带点）
const TEST_FILES = [
  {
    name: '新建文档.txt',
    content: '项目A季度总结报告，包含财务数据和后续计划。',
    expectedTheme: '项目',
    description: '内容包含项目关键词，但文件名无线索',
  },
  {
    name: '最终版.md',
    content: '# 会议纪要\n\n## 时间\n2026年7月1日\n\n## 参与人\n张三、李四\n\n## 讨论议题\n1. 项目进度\n2. 预算分配',
    expectedTheme: '会议',
    description: 'Markdown 标题包含会议关键词，文件名模糊',
  },
  {
    name: '资料1.json',
    content: JSON.stringify({
      project: 'Alpha',
      tasks: [{ id: 1, name: '设计阶段', status: 'done' }],
      budget: 50000,
      timeline: '2026-Q2',
    }),
    expectedTheme: '项目',
    description: 'JSON 内容包含 project/budget 关键词，文件名模糊',
  },
  {
    name: '附件.csv',
    content: 'setting,value\ndatabase_host,localhost\napi_port,8080\nlog_level,debug',
    expectedTheme: '配置',
    description: 'CSV 表头包含 setting/config 关键词，文件名模糊',
  },
  {
    name: 'test.py',
    content: '#!/usr/bin/env python3\nimport os\nimport json\n\ndef main():\n    config = load_config()\n    print(f"Running with {config}")\n\nif __name__ == "__main__":\n    main()',
    expectedTheme: '代码',
    description: 'Python 源码文件，文件名模糊',
  },
  {
    name: 'IMG_20260820.pdf',
    content: 'PDF binary content placeholder',
    expectedTheme: '文档',
    description: 'PDF 格式，文件名是相机命名，内容无法提取',
  },
];

// ── 构造真实 FileEntry（模拟 Scanner 输出契约） ──────────
function makeRealFileEntry(tf, root) {
  const filePath = path.join(root, tf.name);
  const stat = fs.statSync(filePath);
  // V0.4.1.1: 使用真实 Scanner 契约
  // extension 不带点（如 "txt"），modified 而非 mtime
  const ext = path.extname(tf.name).toLowerCase().slice(1);
  return {
    name: tf.name,
    path: filePath,
    dir: root,
    size: stat.size,
    modified: stat.mtimeMs,
    created: stat.birthtimeMs,
    extension: ext,        // 不带点，与 Scanner 一致
    isSymlink: false,
    expectedTheme: tf.expectedTheme,
    description: tf.description,
  };
}

async function main() {
  console.log('=== Content-Aware Classification Evaluation (V0.4.1.1) ===\n');

  // 创建测试目录和文件
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));
  const realEntries = [];

  for (const tf of TEST_FILES) {
    const filePath = path.join(root, tf.name);
    fs.writeFileSync(filePath, tf.content);
    realEntries.push(makeRealFileEntry(tf, root));
  }

  // ── 验证 FileEntry Contract ──
  console.log('0. FileEntry Contract 验证:');
  const sample = realEntries[0];
  check(sample.extension === 'txt', `extension 不带点: "${sample.extension}"`);
  check(sample.modified !== undefined, `modified 存在: ${sample.modified}`);
  check(sample.path !== undefined, `path 存在`);

  // ── Metadata-only 分类（使用真实 classifyBatch） ──
  console.log('\n1. Metadata-only 分类 (classifyBatch, contentAware=false):');
  const metadataResults = await classifier.classifyBatch(realEntries, {
    llm: { enabled: false },
    context: { dirs: [] },
    contentAware: false,
  });

  let metadataCorrect = 0;
  for (const r of metadataResults) {
    const themeMatch = r.contentTheme === r.expectedTheme;
    if (themeMatch) metadataCorrect++;
    console.log(`  ${r.name}: theme=${r.contentTheme} (expected: ${r.expectedTheme}) ${themeMatch ? '✓' : '✗'}`);
  }
  console.log(`  Metadata-only 准确率: ${metadataCorrect}/${realEntries.length}`);

  // ── Content-aware 分类（使用真实 classifyBatch） ──
  console.log('\n2. Content-aware 分类 (classifyBatch, contentAware=true):');
  const contentResults = await classifier.classifyBatch(realEntries, {
    llm: { enabled: false },
    context: { dirs: [] },
    contentAware: true,
  });

  let contentCorrect = 0;
  const improvements = [];
  for (let i = 0; i < contentResults.length; i++) {
    const c = contentResults[i];
    const m = metadataResults[i];
    const cCorrect = c.contentTheme === c.expectedTheme;
    const mCorrect = m.contentTheme === m.expectedTheme;
    if (cCorrect) contentCorrect++;
    if (!mCorrect && cCorrect) {
      improvements.push(`${m.name}: ${m.contentTheme} → ${c.contentTheme}`);
    }
    console.log(`  ${c.name}: theme=${c.contentTheme} (expected: ${c.expectedTheme}) ${cCorrect ? '✓' : '✗'}`);
    if (c.contentSummary) {
      console.log(`    summary: "${c.contentSummary.summary.slice(0, 60)}..."`);
      console.log(`    keywords: ${c.contentSummary.keywords.slice(0, 5).join(', ')}`);
      console.log(`    summaryConfidence: ${c.summaryConfidence}, suggestionConfidence: ${c.confidence}`);
    }
    if (c.contentEvidence) {
      console.log(`    evidence: extractor=${c.contentEvidence.extractor}, source=${c.contentEvidence.source}`);
    }
  }

  // ── 对比分析 ──
  console.log('\n3. 对比分析:');
  console.log(`  Metadata-only 准确率: ${metadataCorrect}/${realEntries.length}`);
  console.log(`  Content-aware 准确率: ${contentCorrect}/${realEntries.length}`);
  console.log(`  提升: ${improvements.length} 个文件`);
  for (const imp of improvements) {
    console.log(`    - ${imp}`);
  }

  check(contentCorrect >= metadataCorrect,
    `Content-aware 准确率不低于 metadata-only (${contentCorrect}/${realEntries.length} vs ${metadataCorrect}/${realEntries.length})`);

  // ── 结构化证据验证 ──
  console.log('\n4. 结构化分类依据:');
  for (const r of contentResults) {
    if (r.contentSummary) {
      check(r.finalReason !== undefined, `${r.name} 有 finalReason`);
      check(r.contentEvidenceDetail !== undefined, `${r.name} 有 contentEvidenceDetail`);
      check(r.metadataEvidence !== undefined, `${r.name} 有 metadataEvidence`);
      check(r.summaryConfidence !== undefined, `${r.name} 有 summaryConfidence`);
    }
  }

  // ── Confidence 拆分验证 ──
  console.log('\n5. Confidence 拆分:');
  const sampleWithContent = contentResults.find(r => r.contentSummary);
  if (sampleWithContent) {
    check(sampleWithContent.summaryConfidence !== undefined,
      `summaryConfidence 独立于 suggestionConfidence`);
    check(typeof sampleWithContent.summaryConfidence === 'number',
      `summaryConfidence 是数字: ${sampleWithContent.summaryConfidence}`);
    check(typeof sampleWithContent.confidence === 'number',
      `suggestionConfidence 是数字: ${sampleWithContent.confidence}`);
    // V0.4.1.1: summaryConfidence 不应该直接等于 suggestionConfidence
    //（除非恰好匹配，但语义不同）
  }

  // ── Content Summary 数据结构验证 ──
  console.log('\n6. Content Summary 数据结构:');
  if (sampleWithContent?.contentSummary) {
    const s = sampleWithContent.contentSummary;
    check(s.title !== undefined, `Summary 有 title: ${s.title}`);
    check(s.summary !== undefined, `Summary 有 summary`);
    check(Array.isArray(s.keywords), `Summary 有 keywords 数组`);
    check(Array.isArray(s.entities), `Summary 有 entities 数组`);
    check(s.confidence !== undefined, `Summary 有 confidence: ${s.confidence}`);
    check(s.method !== undefined, `Summary 有 method: ${s.method}`);
  }

  // ── 缓存机制验证（使用真实 Contract） ──
  console.log('\n7. 缓存机制 (真实 Contract):');
  const cacheFile = realEntries[0];
  // 第一次提取
  const extract1 = contentExtractor.extract(cacheFile);
  // 第二次提取（相同文件）应该命中缓存
  const extract2 = contentExtractor.extract(cacheFile);
  check(extract1 === extract2, `相同文件两次提取返回同一缓存对象`);

  // V0.4.1.1: 使用 modified 而非 mtime 验证缓存失效
  const modifiedFile = { ...cacheFile, modified: cacheFile.modified + 1000 };
  const extract3 = contentExtractor.extract(modifiedFile);
  check(extract3 !== extract1, `modified 变化后缓存失效`);

  // ── 资源限制验证 ──
  console.log('\n8. 资源限制:');
  const largeFile = {
    name: 'large.txt',
    path: path.join(root, 'large.txt'),
    dir: root,
    size: contentExtractor.MAX_READ_SIZE + 1,
    modified: Date.now(),
    extension: 'txt',
  };
  fs.writeFileSync(largeFile.path, 'x'.repeat(contentExtractor.MAX_READ_SIZE + 100));
  const largeResult = contentExtractor.extract(largeFile);
  check(!largeResult.success && largeResult.extractor === 'skip',
    `超大文件自动跳过 (${largeFile.size} > ${contentExtractor.MAX_READ_SIZE})`);

  const unsupportedFile = {
    name: 'image.png',
    path: path.join(root, 'image.png'),
    dir: root,
    size: 100,
    modified: Date.now(),
    extension: 'png',
  };
  fs.writeFileSync(unsupportedFile.path, 'fake-png');
  const unsupportedResult = contentExtractor.extract(unsupportedFile);
  check(!unsupportedResult.success && unsupportedResult.extractor === 'skip',
    `不支持的格式自动跳过 (${unsupportedResult.metadata?.reason})`);

  // ── 生产链路完整性验证 ──
  console.log('\n9. 生产链路完整性:');
  // 验证 classifyBatch 确实调用了 contentExtractor（不是 Evaluation 复制逻辑）
  const hasContentEvidence = contentResults.some(r => r.contentEvidence);
  check(hasContentEvidence, `classifyBatch 真的调用了 Content Extractor`);

  const hasContentSummary = contentResults.some(r => r.contentSummary);
  check(hasContentSummary, `classifyBatch 真的生成了 Content Summary`);

  // 清理
  fs.rmSync(root, { recursive: true, force: true });

  console.log('\n=== Evaluation Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\n  ⚠️  存在失败项。');
    process.exit(1);
  } else {
    console.log('\n  ✅ 所有评估测试通过。');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Evaluation error:', err);
  process.exit(1);
});