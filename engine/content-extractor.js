/**
 * content-extractor.js — 内容提取器 (V0.4)
 *
 * 统一接口，为分类提供有限的文件内容理解。
 *
 * 设计原则：
 * - 不无差别读取全部文件
 * - 不把完整文件内容直接发送给 LLM
 * - 单文件最大读取限制 + 最大字符长度限制
 * - 超大文件自动跳过
 * - 解析失败自动降级（不影响分类流程）
 *
 * 接口：
 *   extract(file) → { success, extractor, metadata, textPreview, truncated, error }
 */

const fs = require('fs');
const path = require('path');

// ── 资源限制 ──────────────────────────────────────────────
const MAX_READ_SIZE = 1 * 1024 * 1024;     // 单文件最大读取 1MB
const MAX_TEXT_LENGTH = 8000;              // 最大提取字符数
const MAX_JSON_DEPTH = 20;                // JSON 解析最大嵌套深度

// ── 内容缓存 (V0.4.1) ─────────────────────────────────────
// Key: filePath + mtime + size，避免重复读取相同文件
const contentCache = new Map();
const MAX_CACHE_SIZE = 200;

function getCacheKey(file) {
  // 使用文件路径 + mtime + size 作为缓存键
  // mtime 确保文件修改后缓存失效
  return file.path + '|' + (file.mtime || 0) + '|' + (file.size || 0);
}

function getFromCache(file) {
  const key = getCacheKey(file);
  return contentCache.get(key) || null;
}

function setToCache(file, result) {
  const key = getCacheKey(file);
  contentCache.set(key, result);
  // 限制缓存大小，避免内存泄漏
  if (contentCache.size > MAX_CACHE_SIZE) {
    const firstKey = contentCache.keys().next().value;
    contentCache.delete(firstKey);
  }
}

function clearCache() {
  contentCache.clear();
}

// ── 支持的格式 ────────────────────────────────────────────
// 第一阶段：txt / md / json / csv / 常见源码文件
const SUPPORTED_EXTENSIONS = new Set([
  // 纯文本
  '.txt', '.text', '.md', '.markdown', '.rst',
  // 结构化数据
  '.json', '.csv', '.tsv',
  // 源码（常见语言）
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.cc',
  '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.xml', '.yaml', '.yml', '.sql', '.sh', '.bash', '.zsh',
  '.ini', '.cfg', '.conf', '.toml', '.env', '.properties',
  '.proto', '.graphql', '.vue', '.svelte', '.dart', '.kt', '.swift',
  '.gradle', '.dockerfile', '.gitignore',
]);

// ── JSON 安全解析 ─────────────────────────────────────────
function safeJsonParse(text) {
  // 限制嵌套深度
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      depth++;
      if (depth > MAX_JSON_DEPTH) {
        return { ok: false, error: 'JSON 嵌套过深' };
      }
    } else if (ch === '}' || ch === ']') {
      depth--;
    }
  }
  try {
    const parsed = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败: ' + e.message };
  }
}

// ── CSV 解析（轻量，仅提取表头和前几行） ──────────────────
function parseCsvPreview(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { headers: [], sampleRows: [], rowCount: 0 };
  const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
  const sampleRows = lines.slice(1, 6).map(line =>
    line.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''))
  );
  return { headers, sampleRows, rowCount: lines.length };
}

// ── 主提取函数 ─────────────────────────────────────────────
/**
 * 从单个文件中提取有限内容。
 *
 * @param {object} file  { path, name, dir, size, extension }
 * @returns {object} { success, extractor, metadata, textPreview, truncated, error }
 */
function extract(file) {
  // ── 0. 缓存检查 (V0.4.1) ──
  const cached = getFromCache(file);
  if (cached) return cached;

  const filePath = file.path;
  const ext = (file.extension || '').toLowerCase();
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  // ── 1. 资源限制检查 ──
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    const result = {
      success: false,
      extractor: null,
      metadata: null,
      textPreview: '',
      truncated: false,
      error: '文件不可读: ' + e.message,
    };
    setToCache(file, result);
    return result;
  }

  // 超大文件自动跳过
  if (stat.size > MAX_READ_SIZE) {
    const result = {
      success: false,
      extractor: 'skip',
      metadata: { reason: 'file_too_large', size: stat.size, limit: MAX_READ_SIZE },
      textPreview: '',
      truncated: false,
      error: null,
    };
    setToCache(file, result);
    return result;
  }

  // 不支持的格式自动跳过
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    const result = {
      success: false,
      extractor: 'skip',
      metadata: { reason: 'unsupported_format', extension: ext },
      textPreview: '',
      truncated: false,
      error: null,
    };
    setToCache(file, result);
    return result;
  }

  // ── 2. 读取文件内容 ──
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf-8');
  } catch (e) {
    const result = {
      success: false,
      extractor: null,
      metadata: null,
      textPreview: '',
      truncated: false,
      error: '读取失败: ' + e.message,
    };
    setToCache(file, result);
    return result;
  }

  // ── 3. 截断长文本 ──
  const truncated = raw.length > MAX_TEXT_LENGTH;
  const text = truncated ? raw.slice(0, MAX_TEXT_LENGTH) : raw;

  // ── 4. 按格式提取 ──
  let result;
  switch (ext) {
    case '.json':
      result = extractJson(text);
      break;
    case '.csv':
    case '.tsv':
      result = extractCsv(text, ext);
      break;
    case '.md':
    case '.markdown':
    case '.rst':
      result = extractMarkdown(text);
      break;
    default:
      result = extractPlain(text);
  }

  const finalResult = {
    success: true,
    extractor: result.extractor,
    metadata: result.metadata || {},
    textPreview: result.textPreview || text.slice(0, 500),
    truncated,
    error: null,
  };
  setToCache(file, finalResult);
  return finalResult;
}

// ── 各格式提取函数 ─────────────────────────────────────────

function extractPlain(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const inferredTheme = inferThemeFromText(text);
  return {
    extractor: 'plain',
    metadata: {
      lineCount: lines.length,
      firstLines: lines.slice(0, 5),
      inferredTheme,
    },
    textPreview: text.slice(0, 500),
  };
}

function extractMarkdown(text) {
  // 提取标题
  const headings = [];
  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  let m;
  while ((m = headingRegex.exec(text)) !== null) {
    headings.push(m[1].trim());
  }

  // 提取链接
  const links = [];
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((m = linkRegex.exec(text)) !== null) {
    links.push({ text: m[1], url: m[2] });
  }

  const lines = text.split(/\r?\n/).filter(l => l.trim());

  return {
    extractor: 'markdown',
    metadata: {
      lineCount: lines.length,
      headings: headings.slice(0, 10),
      linkCount: links.length,
      links: links.slice(0, 10),
    },
    textPreview: text.slice(0, 500),
  };
}

function extractJson(text) {
  const parsed = safeJsonParse(text);
  if (!parsed.ok) {
    return {
      extractor: 'json',
      metadata: { error: parsed.error },
      textPreview: text.slice(0, 500),
    };
  }

  const obj = parsed.value;
  const keys = typeof obj === 'object' && obj !== null ? Object.keys(obj).slice(0, 20) : [];

  // 提取可能的主题关键词
  const topKeys = keys.slice(0, 10);

  return {
    extractor: 'json',
    metadata: {
      type: Array.isArray(obj) ? 'array' : typeof obj,
      keyCount: keys.length,
      topKeys,
      // 尝试从常见字段推断内容主题
      inferredTheme: inferThemeFromJson(obj),
    },
    textPreview: JSON.stringify(obj).slice(0, 500),
  };
}

function extractCsv(text, ext) {
  const parsed = parseCsvPreview(text);
  // 从 CSV 表头和内容中推断主题
  const headerText = parsed.headers.join(' ').toLowerCase();
  const contentSample = parsed.sampleRows.map(r => r.join(' ')).join(' ').toLowerCase();
  const fullText = (headerText + ' ' + contentSample).toLowerCase();
  const inferredTheme = inferThemeFromText(fullText);

  return {
    extractor: ext === '.tsv' ? 'tsv' : 'csv',
    metadata: {
      rowCount: parsed.rowCount,
      headers: parsed.headers,
      sampleRows: parsed.sampleRows,
      columnCount: parsed.headers.length,
      inferredTheme,
    },
    textPreview: text.slice(0, 500),
  };
}

/**
 * 从 JSON 数据中推断内容主题
 */
function inferThemeFromJson(obj) {
  if (typeof obj !== 'object' || obj === null) return null;

  const objStr = JSON.stringify(obj).toLowerCase();

  // 常见主题关键词
  const themes = [
    { keywords: ['invoice', '账单', '发票', 'billing', 'payment', '财务'], theme: '财务' },
    { keywords: ['meeting', '会议', 'agenda', 'minutes', '议程'], theme: '会议' },
    { keywords: ['project', '项目', 'task', 'milestone', 'roadmap'], theme: '项目' },
    { keywords: ['config', '设置', 'setting', 'preferences'], theme: '配置' },
    { keywords: ['user', '用户', 'profile', 'account'], theme: '用户数据' },
    { keywords: ['schema', '模型', 'database', '表'], theme: '数据模型' },
    { keywords: ['api', 'endpoint', 'route'], theme: 'API' },
    { keywords: ['test', '测试', 'spec', 'fixture'], theme: '测试数据' },
  ];

  for (const { keywords, theme } of themes) {
    for (const kw of keywords) {
      if (objStr.includes(kw)) return theme;
    }
  }

  return null;
}

/**
 * 从纯文本内容中推断主题
 */
function inferThemeFromText(text) {
  const lower = text.toLowerCase();

  const themes = [
    { keywords: ['invoice', '账单', '发票', 'billing', 'payment', '结算', '对账', '报税', '财务'], theme: '财务' },
    { keywords: ['meeting', '会议', 'minutes', '议程', 'agenda', '参会人', '讨论'], theme: '会议' },
    { keywords: ['project', '项目', 'milestone', 'roadmap', '提案', '计划', '进度'], theme: '项目' },
    { keywords: ['config', '设置', 'setting', 'preferences', '配置', '参数'], theme: '配置' },
    { keywords: ['report', '报告', 'summary', '总结', 'briefing', '季度', '年度'], theme: '报告' },
    { keywords: ['contract', '合同', '协议', 'agreement', 'nda'], theme: '合同' },
    { keywords: ['resume', '简历', 'cv', 'portfolio', '自我介绍'], theme: '个人简历' },
    { keywords: ['design', '设计', 'mockup', 'wireframe', '原型', '草图'], theme: '设计' },
    { keywords: ['thesis', '论文', 'dissertation', '学术', '参考文献'], theme: '学术' },
    { keywords: ['homework', '作业', 'assignment', '习题', '试卷'], theme: '学习' },
    { keywords: ['backup', '备份', 'archive', 'archived', '历史'], theme: '备份' },
    { keywords: ['draft', '草稿', 'wip', 'work in progress'], theme: '草稿' },
  ];

  for (const { keywords, theme } of themes) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return theme;
    }
  }

  return null;
}

// ── 批量提取 ──────────────────────────────────────────────
/**
 * 对一批文件执行内容提取。
 * 自动跳过不支持的格式和超大文件。
 *
 * @param {Array} files  文件列表
 * @returns {Map} path → extract result
 */
function extractBatch(files) {
  const results = new Map();
  for (const file of files) {
    results.set(file.path, extract(file));
  }
  return results;
}

module.exports = {
  extract,
  extractBatch,
  SUPPORTED_EXTENSIONS,
  MAX_READ_SIZE,
  MAX_TEXT_LENGTH,
};