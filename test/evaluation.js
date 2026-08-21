/**
 * evaluation.js — Content-Aware 分类评估测试 (V0.4.1 升级)
 *
 * 对比 metadata-only / content-summary / content-aware 分类准确率。
 *
 * V0.4.1 新增：
 * - Ambiguous Filename Dataset（仅靠文件名无法判断的文件）
 * - Content Summary 层评估
 * - 结构化分类依据验证
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

async function main() {
  console.log('=== Content-Aware Classification Evaluation (V0.4.1) ===\n');

  // 创建测试目录和文件
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));
  const testFiles = [];

  for (const tf of TEST_FILES) {
    const filePath = path.join(root, tf.name);
    fs.writeFileSync(filePath, tf.content);
    testFiles.push({
      name: tf.name,
      path: filePath,
      dir: root,
      size: fs.statSync(filePath).size,
      extension: path.extname(tf.name),
      mtime: fs.statSync(filePath).mtimeMs,
      description: tf.description,
      expectedTheme: tf.expectedTheme,
    });
  }

  // ── Metadata-only 分类 ──
  console.log('1. Metadata-only 分类:');
  const metadataResults = testFiles.map(f => {
    const result = classifier.classifyByRules(f, {});
    return {
      ...f,
      ...result,
      mode: 'metadata-only',
    };
  });

  for (const r of metadataResults) {
    const themeMatch = r.contentTheme === r.expectedTheme;
    console.log(`  ${r.name}: theme=${r.contentTheme} (expected: ${r.expectedTheme}) ${themeMatch ? '✓' : '✗'}`);
  }

  // ── Content Summary 分类 ──
  console.log('\n2. Content Summary 分类:');
  const summaryResults = [];
  for (const f of testFiles) {
    const ruleResult = classifier.classifyByRules(f, {});
    let result = { ...f, ...ruleResult, mode: 'content-summary' };

    // 内容提取 + Summary 生成
    const extracted = contentExtractor.extract(f);
    if (extracted && extracted.success) {
      const summary = contentSummary.buildLocalSummary(extracted, f);
      result.contentSummary = summary;

      // 应用 Summary 调整分类
      const metadataEvidence = [`文件类型: ${result.fileTypeLabel || result.fileType}`];
      const contentEvidence = [];

      if (summary.title && summary.title !== f.name) {
        contentEvidence.push(`内容标题: ${summary.title}`);
      }
      if (summary.summary) {
        contentEvidence.push(`内容摘要: ${summary.summary}`);
      }
      if (summary.keywords && summary.keywords.length > 0) {
        contentEvidence.push(`发现关键词: ${summary.keywords.slice(0, 5).join(', ')}`);
      }

      result.metadataEvidence = metadataEvidence;
      result.contentEvidenceDetail = contentEvidence;
      result.finalReason = buildFinalReason(metadataEvidence, contentEvidence, result);

      // 用 Summary 提升分类
      if (summary.confidence > result.confidence) {
        result.confidence = summary.confidence;
      }
      if (result.contentTheme === '默认' && summary.title) {
        for (const kw of summary.keywords) {
          for (const { pattern, theme, weight } of classifier.THEME_PATTERNS) {
            if (pattern.test(kw) || pattern.test(summary.title)) {
              result.contentTheme = theme;
              result.suggestedTarget = theme;
              result.method = result.method + '+content-summary';
              result.confidence = Math.max(result.confidence, weight);
              break;
            }
          }
          if (result.contentTheme !== '默认') break;
        }
      }
    }
    summaryResults.push(result);
  }

  for (const r of summaryResults) {
    const themeMatch = r.contentTheme === r.expectedTheme;
    console.log(`  ${r.name}: theme=${r.contentTheme} (expected: ${r.expectedTheme}) ${themeMatch ? '✓' : '✗'}`);
    if (r.contentSummary) {
      console.log(`    summary: "${r.contentSummary.summary.slice(0, 60)}..."`);
      console.log(`    keywords: ${r.contentSummary.keywords.slice(0, 5).join(', ')}`);
    }
  }

  // ── 对比分析 ──
  console.log('\n3. 对比分析:');
  let metadataCorrect = 0;
  let summaryCorrect = 0;
  const improvements = [];

  for (let i = 0; i < testFiles.length; i++) {
    const m = metadataResults[i];
    const s = summaryResults[i];
    const mCorrect = m.contentTheme === m.expectedTheme;
    const sCorrect = s.contentTheme === s.expectedTheme;
    if (mCorrect) metadataCorrect++;
    if (sCorrect) summaryCorrect++;
    if (!mCorrect && sCorrect) {
      improvements.push(`${m.name}: ${m.contentTheme} → ${s.contentTheme}`);
    }
  }

  console.log(`  Metadata-only 准确率: ${metadataCorrect}/${testFiles.length}`);
  console.log(`  Content Summary 准确率: ${summaryCorrect}/${testFiles.length}`);
  console.log(`  提升: ${improvements.length} 个文件`);

  for (const imp of improvements) {
    console.log(`    - ${imp}`);
  }

  check(summaryCorrect >= metadataCorrect,
    `Content Summary 准确率不低于 metadata-only (${summaryCorrect}/${testFiles.length} vs ${metadataCorrect}/${testFiles.length})`);
  check(improvements.length > 0,
    `至少有 ${improvements.length} 个文件通过内容 Summary 提升分类`);

  // ── 结构化证据验证 ──
  console.log('\n4. 结构化分类依据:');
  for (const r of summaryResults) {
    if (r.contentSummary) {
      check(r.finalReason !== undefined, `${r.name} 有 finalReason`);
      check(r.contentEvidenceDetail !== undefined, `${r.name} 有 contentEvidenceDetail`);
      check(r.metadataEvidence !== undefined, `${r.name} 有 metadataEvidence`);
    }
  }

  // ── Content Summary 数据结构验证 ──
  console.log('\n5. Content Summary 数据结构:');
  const sampleSummary = summaryResults.find(r => r.contentSummary)?.contentSummary;
  if (sampleSummary) {
    check(sampleSummary.title !== undefined, `Summary 有 title: ${sampleSummary.title}`);
    check(sampleSummary.summary !== undefined, `Summary 有 summary`);
    check(Array.isArray(sampleSummary.keywords), `Summary 有 keywords 数组`);
    check(Array.isArray(sampleSummary.entities), `Summary 有 entities 数组`);
    check(sampleSummary.confidence !== undefined, `Summary 有 confidence: ${sampleSummary.confidence}`);
    check(sampleSummary.method !== undefined, `Summary 有 method: ${sampleSummary.method}`);
  }

  // ── 缓存机制验证 ──
  console.log('\n6. 缓存机制:');
  const cacheFile = testFiles[0];
  const extract1 = contentExtractor.extract(cacheFile);
  const extract2 = contentExtractor.extract(cacheFile);
  check(extract1 === extract2, `相同文件两次提取返回同一缓存对象`);

  // 验证 mtime 变化后缓存失效
  const newMtimeFile = { ...cacheFile, mtime: cacheFile.mtime + 1000 };
  const extract3 = contentExtractor.extract(newMtimeFile);
  check(extract3 !== extract1, `mtime 变化后缓存失效`);

  // ── 资源限制验证 ──
  console.log('\n7. 资源限制:');
  const largeFile = {
    name: 'large.txt',
    path: path.join(root, 'large.txt'),
    dir: root,
    size: contentExtractor.MAX_READ_SIZE + 1,
    extension: '.txt',
    mtime: Date.now(),
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
    extension: '.png',
    mtime: Date.now(),
  };
  fs.writeFileSync(unsupportedFile.path, 'fake-png');
  const unsupportedResult = contentExtractor.extract(unsupportedFile);
  check(!unsupportedResult.success && unsupportedResult.extractor === 'skip',
    `不支持的格式自动跳过 (${unsupportedResult.metadata?.reason})`);

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

function buildFinalReason(metadataEvidence, contentEvidence, result) {
  const parts = [];
  parts.push(`分类: ${result.fileTypeLabel || result.fileType}`);
  if (result.contentTheme && result.contentTheme !== '默认') {
    parts.push(`主题: ${result.contentTheme}`);
  }
  parts.push(`方法: ${result.method}`);
  if (contentEvidence.length > 0) {
    parts.push(`内容依据: ${contentEvidence.slice(0, 3).join(' | ')}`);
  }
  return parts.join(' · ');
}

main().catch(err => {
  console.error('Evaluation error:', err);
  process.exit(1);
});