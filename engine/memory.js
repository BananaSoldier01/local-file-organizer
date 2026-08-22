/**
 * memory.js — User Decision Memory (V0.4.4)
 *
 * 记录用户明确整理行为，让系统从"一次性工具"升级为"会学习的个人文件助手"。
 *
 * 存储：
 * - target_override：用户手工修改目标目录
 * - exclude：用户排除某类文件
 * - relationship_accept/reject：用户对 Group Suggestion 的态度
 *
 * 原则：
 * - 本地存储（JSON 文件）
 * - 可查看、可删除
 * - 不上传
 * - 只记录用户明确操作，不记录被动行为
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 存储路径 ──────────────────────────────────────────────
const MEMORY_DIR = path.join(os.homedir(), '.local-file-organizer');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');
const MAX_ENTRIES = 500;

// ── 内存缓存 ──────────────────────────────────────────────
let memoryCache = null;

/**
 * 确保存储目录存在。
 */
function ensureDir() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

/**
 * 加载 Memory（带缓存）。
 */
function loadMemory() {
  if (memoryCache) return memoryCache;
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
      memoryCache = JSON.parse(raw);
    } else {
      memoryCache = { version: 1, entries: [] };
    }
  } catch (err) {
    console.error('[memory] 加载失败，使用空记忆:', err.message);
    memoryCache = { version: 1, entries: [] };
  }
  return memoryCache;
}

/**
 * 保存 Memory 到磁盘。
 */
function saveMemory(data) {
  ensureDir();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  memoryCache = data;
}

/**
 * 记录一条用户决策。
 *
 * @param {object} entry
 * @param {string} entry.type        - 'target_override' | 'exclude' | 'relationship_accept' | 'relationship_reject'
 * @param {string} entry.source      - 'user'
 * @param {string} entry.filePattern - 文件名模式（如 '*.xlsx'）
 * @param {string[]} entry.keywords  - 从文件内容/文件名提取的关键词
 * @param {string} entry.target      - 目标目录名（target_override 时有效）
 * @param {string} entry.groupName   - 组名（relationship_* 时有效）
 * @param {string} entry.reason      - 用户决策的简要描述
 * @returns {object} 完整的 memory entry
 */
function recordDecision(entry) {
  const data = loadMemory();

  const fullEntry = {
    id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    type: entry.type,
    source: 'user',
    filePattern: entry.filePattern || '*',
    keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
    target: entry.target || null,
    groupName: entry.groupName || null,
    reason: entry.reason || '',
  };

  data.entries.push(fullEntry);

  // 限制最大条数
  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(-MAX_ENTRIES);
  }

  saveMemory(data);
  return fullEntry;
}

/**
 * 查询匹配的 Memory 条目。
 *
 * @param {object} query
 * @param {string} [query.keywords] - 文件关键词
 * @param {string} [query.filePattern] - 文件名模式
 * @param {string} [query.type] - 决策类型
 * @returns {object[]} 匹配的 memory 条目，按时间倒序
 */
function queryMemory(query = {}) {
  const data = loadMemory();
  let entries = data.entries;

  if (query.type) {
    entries = entries.filter(e => e.type === query.type);
  }

  if (query.keywords && query.keywords.length > 0) {
    entries = entries.filter(e => {
      return query.keywords.some(kw =>
        e.keywords.some(ek => ek.includes(kw) || kw.includes(ek))
      );
    });
  }

  if (query.filePattern) {
    const pattern = query.filePattern.toLowerCase();
    entries = entries.filter(e =>
      e.filePattern.toLowerCase().includes(pattern) ||
      pattern.includes(e.filePattern.toLowerCase())
    );
  }

  // 按时间倒序
  return entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * 从文件中提取 Memory 关键词。
 *
 * @param {object} file - 分类后的文件
 * @returns {string[]}
 */
function extractFileKeywords(file) {
  const keywords = new Set();

  // 从文件名提取
  const nameWithoutExt = path.basename(file.name, path.extname(file.name));
  const nameParts = nameWithoutExt.split(/[-_\s]/);
  for (const part of nameParts) {
    if (part.length >= 2) keywords.add(part.toLowerCase());
  }

  // 从内容摘要提取
  if (file.contentSummary) {
    if (file.contentSummary.keywords) {
      for (const k of file.contentSummary.keywords) {
        keywords.add(k.toLowerCase());
      }
    }
    if (file.contentSummary.entities) {
      for (const e of file.contentSummary.entities) {
        keywords.add(e.toLowerCase());
      }
    }
  }

  // 从分类主题提取
  if (file.contentTheme && file.contentTheme !== '默认') {
    keywords.add(file.contentTheme.toLowerCase());
  }

  return [...keywords];
}

/**
 * 从 Memory 中查找文件的建议目标目录。
 *
 * @param {object} file - 分类后的文件
 * @returns {object|null} { target, confidence, reason, entries }
 */
function lookupMemorySuggestion(file) {
  const fileKeywords = extractFileKeywords(file);
  const entries = queryMemory({ keywords: fileKeywords, type: 'target_override' });

  if (entries.length === 0) return null;

  // 按目标目录分组统计
  const targetCounts = new Map();
  for (const entry of entries) {
    const t = entry.target;
    if (!t) continue;
    if (!targetCounts.has(t)) targetCounts.set(t, { count: 0, entries: [] });
    targetCounts.get(t).count++;
    targetCounts.get(t).entries.push(entry);
  }

  // 找最高频的目标
  let bestTarget = null;
  let bestCount = 0;
  let bestEntries = [];
  for (const [t, data] of targetCounts) {
    if (data.count > bestCount) {
      bestCount = data.count;
      bestTarget = t;
      bestEntries = data.entries;
    }
  }

  if (!bestTarget) return null;

  // 置信度：基于匹配次数和时间衰减
  const now = Date.now();
  let totalWeight = 0;
  for (const e of bestEntries) {
    const ageDays = (now - new Date(e.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    const weight = Math.max(0.1, 1 - ageDays / 90); // 90 天衰减
    totalWeight += weight;
  }
  const confidence = Math.min(0.95, 0.3 + bestCount * 0.15 + totalWeight * 0.1);

  return {
    target: bestTarget,
    confidence: Math.round(confidence * 1000) / 1000,
    reason: `历史用户选择：${bestCount} 次将类似文件放入 ${bestTarget}`,
    entries: bestEntries.slice(0, 5),
    count: bestCount,
  };
}

/**
 * 清空所有 Memory。
 */
function clearMemory() {
  saveMemory({ version: 1, entries: [] });
}

/**
 * 删除指定条目的 Memory。
 *
 * @param {string} entryId
 */
function deleteEntry(entryId) {
  const data = loadMemory();
  data.entries = data.entries.filter(e => e.id !== entryId);
  saveMemory(data);
}

/**
 * 获取 Memory 统计信息。
 *
 * @returns {object}
 */
function getMemoryStats() {
  const data = loadMemory();
  const byType = {};
  for (const e of data.entries) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }
  return {
    total: data.entries.length,
    byType,
    oldest: data.entries.length > 0 ? data.entries[0].timestamp : null,
    newest: data.entries.length > 0 ? data.entries[data.entries.length - 1].timestamp : null,
  };
}

/**
 * 导出所有 Memory（用于备份/查看）。
 */
function exportMemory() {
  return loadMemory();
}

module.exports = {
  recordDecision,
  queryMemory,
  extractFileKeywords,
  lookupMemorySuggestion,
  clearMemory,
  deleteEntry,
  getMemoryStats,
  exportMemory,
  MEMORY_FILE,
};