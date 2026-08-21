/**
 * evaluation.js — Content-Aware 分类评估测试
 *
 * 对比 metadata-only 与 content-aware 分类准确率。
 *
 * 测试样例：
 * - 新建文档.txt（无内容线索，metadata-only 可能误判）
 * - project_plan.json（内容包含 project 关键词）
 * - meeting_notes.md（内容包含 meeting 关键词）
 * - config_data.csv（内容包含 config 关键词）
 * - source_code.py（内容包含代码特征）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const classifier = require('../engine/classifier');
const contentExtractor = require('../engine/content-extractor');

let passed = 0;
let failed = 0;

function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// ── 测试数据 ──────────────────────────────────────────────
const TEST_FILES = [
  {
    name: '新建文档.txt',
    content: '这是项目A的季度总结报告，包含财务数据和后续计划。',
    expectedTheme: '项目',
    description: '内容包含项目关键词，但文件名无线索',
  },
  {
    name: 'project_plan.json',
    content: JSON.stringify({
      project: 'Alpha',
      tasks: [{ id: 1, name: '设计阶段', status: 'done' }],
      budget: 50000,
      timeline: '2026-Q2',
    }),
    expectedTheme: '项目',
    description: 'JSON 内容包含 project/budget 关键词',
  },
  {
    name: 'meeting_notes.md',
    content: '# 会议纪要\n\n## 时间\n2026年7月1日\n\n## 参与人\n张三、李四\n\n## 讨论议题\n1. 项目进度\n2. 预算分配',
    expectedTheme: '会议',
    description: 'Markdown 标题包含会议关键词',
  },
  {
    name: 'config_data.csv',
    content: 'setting,value\ndatabase_host,localhost\napi_port,8080\nlog_level,debug',
    expectedTheme: '配置',
    description: 'CSV 表头包含 setting/config 关键词',
  },
  {
    name: 'source_code.py',
    content: '#!/usr/bin/env python3\nimport os\nimport json\n\ndef main():\n    config = load_config()\n    print(f"Running with {config}")\n\nif __name__ == "__main__":\n    main()',
    expectedTheme: '代码',
    description: 'Python 源码文件',
  },
];

async function main() {
  console.log('=== Content-Aware Classification Evaluation ===\n');

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

  // ── Content-aware 分类 ──
  console.log('\n2. Content-aware 分类:');
  const contentResults = [];
  for (const f of testFiles) {
    // 先走规则分类
    const ruleResult = classifier.classifyByRules(f, {});
    let result = { ...f, ...ruleResult, mode: 'content-aware' };

    // 对低置信度文件尝试内容提取
    if (result.confidence < 0.6 || result.contentTheme === '默认') {
      const extracted = contentExtractor.extract(f);
      if (extracted && extracted.success) {
        const evidence = {
          extractor: extracted.extractor,
          preview: (extracted.textPreview || '').slice(0, 200),
        };
        if (extracted.metadata) {
          if (extracted.metadata.inferredTheme) evidence.inferredTheme = extracted.metadata.inferredTheme;
          if (extracted.metadata.headings) evidence.headings = extracted.metadata.headings.slice(0, 5);
          if (extracted.metadata.topKeys) evidence.jsonKeys = extracted.metadata.topKeys.slice(0, 8);
        }
        result.contentEvidence = evidence;

        // 应用内容证据
        if (extracted.metadata.inferredTheme && result.contentTheme === '默认') {
          result.contentTheme = extracted.metadata.inferredTheme;
          result.suggestedTarget = extracted.metadata.inferredTheme;
          result.method = result.method + '+content';
          result.confidence = Math.max(result.confidence, 0.7);
        }
      }
    }
    contentResults.push(result);
  }

  for (const r of contentResults) {
    const themeMatch = r.contentTheme === r.expectedTheme;
    console.log(`  ${r.name}: theme=${r.contentTheme} (expected: ${r.expectedTheme}) ${themeMatch ? '✓' : '✗'}`);
    if (r.contentEvidence) {
      console.log(`    evidence: extractor=${r.contentEvidence.extractor}, inferred=${r.contentEvidence.inferredTheme || 'N/A'}`);
    }
  }

  // ── 对比分析 ──
  console.log('\n3. 对比分析:');
  let metadataCorrect = 0;
  let contentCorrect = 0;
  const improvements = [];

  for (let i = 0; i < testFiles.length; i++) {
    const m = metadataResults[i];
    const c = contentResults[i];
    const mCorrect = m.contentTheme === m.expectedTheme;
    const cCorrect = c.contentTheme === c.expectedTheme;
    if (mCorrect) metadataCorrect++;
    if (cCorrect) contentCorrect++;
    if (!mCorrect && cCorrect) {
      improvements.push(`${m.name}: ${m.contentTheme} → ${c.contentTheme}`);
    }
  }

  console.log(`  Metadata-only 准确率: ${metadataCorrect}/${testFiles.length}`);
  console.log(`  Content-aware 准确率: ${contentCorrect}/${testFiles.length}`);
  console.log(`  提升: ${improvements.length} 个文件`);

  for (const imp of improvements) {
    console.log(`    - ${imp}`);
  }

  check(contentCorrect >= metadataCorrect,
    `Content-aware 准确率不低于 metadata-only (${contentCorrect}/${testFiles.length} vs ${metadataCorrect}/${testFiles.length})`);
  check(improvements.length > 0,
    `至少有 ${improvements.length} 个文件通过内容读取提升分类`);

  // ── 内容证据展示验证 ──
  console.log('\n4. 内容证据展示:');
  for (const r of contentResults) {
    if (r.contentEvidence) {
      check(true, `${r.name} 有内容证据 (extractor: ${r.contentEvidence.extractor})`);
    }
  }

  // ── 资源限制验证 ──
  console.log('\n5. 资源限制:');
  const largeFile = {
    name: 'large.txt',
    path: path.join(root, 'large.txt'),
    dir: root,
    size: contentExtractor.MAX_READ_SIZE + 1,
    extension: '.txt',
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

main().catch(err => {
  console.error('Evaluation error:', err);
  process.exit(1);
});