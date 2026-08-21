/**
 * fingerprint.js — 语义指纹 (V0.4.2)
 *
 * 基于已有 Content Summary + Classification Result，为每个文件生成用于关系分析的语义指纹。
 *
 * 设计原则：
 * - 不破坏现有 Classification
 * - 不修改 FileEntry Contract
 * - 与现有 Content Summary 解耦
 * - 不直接重新读取文件内容
 *
 * Fingerprint 来源优先级：
 * 1. Content Summary（title / summary / keywords / entities）
 * 2. Classification Result（theme / suggestedTarget）
 * 3. Metadata（name / dir）
 */

const path = require('path');

/**
 * 生成 Semantic Fingerprint。
 *
 * @param {object} file        FileEntry（含 classification 结果）
 * @param {object} contentSummary  Content Summary（可选）
 * @returns {object} Fingerprint
 */
function buildFingerprint(file, contentSummary) {
  const summary = contentSummary || file.contentSummary || {};

  // 提取实体（从关键词中识别项目名等专有名词）
  const entities = extractEntities(file, summary);

  // 统一主题
  const theme = (file.contentTheme && file.contentTheme !== '默认')
    ? file.contentTheme
    : (summary.title || '默认');

  return {
    fileId: file.path,
    title: summary.title || file.name,
    summary: summary.summary || '',
    keywords: uniqueArray([
      ...(summary.keywords || []),
      ...(file.contentTheme ? [file.contentTheme] : []),
    ]),
    entities,
    theme,
    source: summary.method ? 'content-summary' : 'metadata',
    dir: file.dir ? path.basename(file.dir) : '',
    name: file.name,
  };
}

/**
 * 从文件名和 Summary 中提取实体（专有名词）。
 * 简单规则：中文词组、英文专有名词（首字母大写）。
 */
function extractEntities(file, summary) {
  const entities = new Set();
  const text = [
    file.name,
    summary.title || '',
    summary.summary || '',
    ...(summary.keywords || []),
  ].join(' ');

  // 中文项目名模式：匹配"项目A"、"项目B"等
  const cnProjectPattern = /项目\s*[A-Za-z0-9一-鿿]+/g;
  let m;
  while ((m = cnProjectPattern.exec(text)) !== null) {
    entities.add(m[0]);
  }

  // 英文专有名词（首字母大写且长度 > 1）
  const enPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
  while ((m = enPattern.exec(text)) !== null) {
    if (m[0].length > 1 && !isCommonWord(m[0])) {
      entities.add(m[0]);
    }
  }

  // 从文件名中提取可能的项目名
  const nameWithoutExt = path.basename(file.name, path.extname(file.name));
  const nameParts = nameWithoutExt.split(/[-_\s]/);
  for (const part of nameParts) {
    if (part.length >= 2 && !isCommonWord(part)) {
      entities.add(part);
    }
  }

  return [...entities].slice(0, 20);
}

const COMMON_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can',
  'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has',
  'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see',
  'two', 'way', 'who', 'boy', 'did', 'she', 'use', 'her', 'oil',
  'sit', 'set', 'run', 'eat', 'far', 'sea', 'eye', 'ago', 'off',
  'too', 'any', 'say', 'man', 'try', 'ask', 'end', 'why', 'let',
  'put', 'say', 'she', 'try', 'way', 'own', 'say', 'too', 'old',
  'tell', 'very', 'when', 'come', 'here', 'just', 'like', 'long',
  'make', 'many', 'over', 'such', 'take', 'them', 'well', 'were',
]);

function isCommonWord(word) {
  return COMMON_WORDS.has(word.toLowerCase());
}

function uniqueArray(arr) {
  return [...new Set(arr.filter(Boolean))];
}

module.exports = {
  buildFingerprint,
  extractEntities,
};