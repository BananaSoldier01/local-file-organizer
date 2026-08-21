/**
 * content-summary.js — 内容摘要层 (V0.4.1)
 *
 * 在 Content Extractor 和 Classifier 之间建立统一的 Content Summary 数据结构。
 *
 * 设计原则：
 * - Classifier 不直接依赖原始 textPreview
 * - Summary 接口可替换（Local Summary / LLM Summary）
 * - 统一返回 { title, summary, keywords, entities, confidence }
 *
 * Phase 1：本地规则 Summary（基于格式的结构化提取）
 * Phase 2：LLM Summary 接口预留（未来可替换）
 */

const path = require('path');

// ── Phase 1：本地规则 Summary ──────────────────────────────

/**
 * 从 Content Extractor 结果生成统一 Content Summary。
 *
 * @param {object} extractResult  contentExtractor.extract() 的返回值
 * @param {object} file           原始文件元数据 { name, path, dir, size, extension }
 * @returns {object} { title, summary, keywords, entities, confidence, method }
 */
function buildLocalSummary(extractResult, file) {
  if (!extractResult || !extractResult.success) {
    return {
      title: file.name,
      summary: '',
      keywords: [],
      entities: [],
      confidence: 0,
      method: 'fallback',
    };
  }

  const metadata = extractResult.metadata || {};
  const extractor = extractResult.extractor;
  const text = extractResult.textPreview || '';

  // 根据不同格式生成结构化 Summary
  switch (extractor) {
    case 'markdown':
      return buildMarkdownSummary(extractResult, file);
    case 'json':
      return buildJsonSummary(extractResult, file);
    case 'csv':
    case 'tsv':
      return buildCsvSummary(extractResult, file);
    case 'plain':
      return buildPlainSummary(extractResult, file);
    default:
      return buildFallbackSummary(extractResult, file);
  }
}

// ── Markdown Summary ──────────────────────────────────────

function buildMarkdownSummary(extractResult, file) {
  const m = extractResult.metadata;
  const headings = m.headings || [];
  const links = m.links || [];

  const title = headings[0] || file.name;
  const keywords = new Set();

  // 从标题提取关键词
  for (const h of headings.slice(0, 5)) {
    for (const kw of extractKeywords(h)) {
      keywords.add(kw);
    }
  }

  // 从链接文本提取关键词
  for (const link of links.slice(0, 5)) {
    for (const kw of extractKeywords(link.text)) {
      keywords.add(kw);
    }
  }

  // 从内容前几行提取
  const text = extractResult.textPreview || '';
  const firstLines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 3).join(' ');
  for (const kw of extractKeywords(firstLines)) {
    keywords.add(kw);
  }

  const summary = headings.length > 0
    ? `Markdown文档，标题: ${headings.slice(0, 3).join(' / ')}`
    : `Markdown文档，共 ${m.lineCount || 0} 行`;

  return {
    title,
    summary,
    keywords: [...keywords].slice(0, 15),
    entities: [],
    confidence: headings.length > 0 ? 0.7 : 0.4,
    method: 'local-markdown',
    source: 'markdown-headings',
  };
}

// ── JSON Summary ──────────────────────────────────────────

function buildJsonSummary(extractResult, file) {
  const m = extractResult.metadata;
  const topKeys = m.topKeys || [];
  const inferredTheme = m.inferredTheme;

  const title = inferredTheme || topKeys[0] || file.name;
  const keywords = new Set(topKeys.slice(0, 10));

  const summary = `JSON数据，${m.keyCount || 0} 个顶层字段` +
    (inferredTheme ? `，推断主题: ${inferredTheme}` : '');

  return {
    title,
    summary,
    keywords: [...keywords].slice(0, 15),
    entities: [],
    confidence: inferredTheme ? 0.7 : 0.5,
    method: 'local-json',
    source: 'json-keys',
  };
}

// ── CSV Summary ───────────────────────────────────────────

function buildCsvSummary(extractResult, file) {
  const m = extractResult.metadata;
  const headers = m.headers || [];
  const inferredTheme = m.inferredTheme;
  const rowCount = m.rowCount || 0;

  const title = inferredTheme || headers[0] || file.name;
  const keywords = new Set(headers.slice(0, 10));

  const summary = `CSV数据，${rowCount} 行 ${headers.length} 列` +
    (inferredTheme ? `，推断主题: ${inferredTheme}` : '') +
    (headers.length > 0 ? `，表头: ${headers.slice(0, 5).join(', ')}` : '');

  return {
    title,
    summary,
    keywords: [...keywords].slice(0, 15),
    entities: [],
    confidence: inferredTheme ? 0.7 : 0.5,
    method: 'local-csv',
    source: 'csv-headers',
  };
}

// ── Plain Text / Code Summary ─────────────────────────────

function buildPlainSummary(extractResult, file) {
  const m = extractResult.metadata;
  const inferredTheme = m.inferredTheme;
  const firstLines = m.firstLines || [];
  const lineCount = m.lineCount || 0;

  // 从内容中提取关键词
  const text = extractResult.textPreview || '';
  const keywords = new Set(extractKeywords(text));

  const title = inferredTheme || firstLines[0] || file.name;
  const summary = `${lineCount} 行文本` +
    (inferredTheme ? `，推断主题: ${inferredTheme}` : '') +
    (firstLines.length > 0 ? `，首行: ${firstLines[0].slice(0, 60)}` : '');

  return {
    title,
    summary,
    keywords: [...keywords].slice(0, 15),
    entities: [],
    confidence: inferredTheme ? 0.6 : 0.3,
    method: 'local-plain',
    source: 'text-keywords',
  };
}

// ── Fallback Summary ──────────────────────────────────────

function buildFallbackSummary(extractResult, file) {
  const text = extractResult.textPreview || '';
  const keywords = new Set(extractKeywords(text));

  return {
    title: file.name,
    summary: text.slice(0, 100),
    keywords: [...keywords].slice(0, 10),
    entities: [],
    confidence: 0.2,
    method: 'fallback',
    source: 'raw-text',
  };
}

// ── 关键词提取工具 ────────────────────────────────────────

function extractKeywords(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const keywords = new Set();

  // 常见主题关键词
  const themeKws = [
    '项目', '会议', '报告', '财务', '合同', '设计', '技术', '配置',
    '备份', '草稿', '简历', '学习', '学术', '截图', '照片', '笔记',
    '发票', '结算', '报税', '预算', '验收', '施工', '整改',
    'project', 'meeting', 'report', 'invoice', 'contract', 'design',
    'config', 'backup', 'draft', 'resume', 'api', 'database', 'schema',
  ];

  for (const kw of themeKws) {
    if (lower.includes(kw)) keywords.add(kw);
  }

  return [...keywords];
}

// ── Phase 2：LLM Summary 接口预留 ─────────────────────────

/**
 * LLM Summary 接口（预留，当前不实现）。
 *
 * 未来实现时：
 * - 只发送 Content Summary（不含完整文件内容）
 * - 统一返回 { summary, keywords, confidence }
 * - 不让 classifier 依赖具体实现
 *
 * @param {object} contentSummary  本地 Summary 结果
 * @param {object} llmConfig       LLM 配置
 * @returns {Promise<object|null>} LLM 增强 Summary，失败返回 null
 */
async function summarizeWithLLM(contentSummary, llmConfig) {
  // Phase 2 预留：当前不实现
  // 未来可以：
  // 1. 将本地 Summary 发送给 LLM
  // 2. LLM 返回更准确的 summary / keywords
  // 3. 合并本地和 LLM 结果
  return null;
}

// ── 统一入口 ──────────────────────────────────────────────

/**
 * 生成 Content Summary。
 *
 * @param {object} extractResult  contentExtractor.extract() 的返回值
 * @param {object} file           原始文件元数据
 * @param {object} [llmConfig]    LLM 配置（可选，Phase 2 预留）
 * @returns {object} Content Summary
 */
async function buildContentSummary(extractResult, file, llmConfig) {
  // Phase 1：本地规则 Summary
  const localSummary = buildLocalSummary(extractResult, file);

  // Phase 2：LLM 增强（预留，当前不实现）
  if (llmConfig && llmConfig.enabled) {
    const llmSummary = await summarizeWithLLM(localSummary, llmConfig);
    if (llmSummary) {
      return {
        ...localSummary,
        ...llmSummary,
        method: 'llm-enhanced',
      };
    }
  }

  return localSummary;
}

module.exports = {
  buildLocalSummary,
  buildContentSummary,
  summarizeWithLLM,
};