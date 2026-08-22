/**
 * memory.js — User Decision Memory (V0.4.5)
 *
 * 可靠个人记忆层。从行为日志升级为偏好模型。
 *
 * Schema v2：
 * - context：文件上下文（文件名/内容/实体/主题/扩展名/关系组）
 * - action：用户操作（target / excluded）
 * - confidence：置信度生命周期（candidate → learned → trusted）
 * - timestamp：创建和最后使用时间
 *
 * 优先级链：
 *   User Override > Trusted Memory > Learned Memory > Relationship > Classification
 *
 * 原则：
 * - 本地存储（JSON 文件）
 * - 可查看、可删除、不上传
 * - 只记录用户明确操作
 * - 一次误操作不污染后续推荐
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 存储路径 ──────────────────────────────────────────────
const MEMORY_DIR = path.join(os.homedir(), '.local-file-organizer');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');
const MAX_ENTRIES = 500;

// ── 置信度阈值 ────────────────────────────────────────────
const CONFIDENCE = {
  CANDIDATE: { score: 0.3, usageMin: 1, daysRecent: 90 },
  LEARNED:   { score: 0.6, usageMin: 3, daysRecent: 90 },
  TRUSTED:   { score: 0.8, usageMin: 5, daysRecent: 90 },
};

// ── 上下文匹配权重 ────────────────────────────────────────
const CONTEXT_WEIGHTS = {
  contentTheme:    0.30,
  entities:        0.25,
  contentKeywords: 0.20,
  filenameKeywords:0.15,
  extension:       0.10,
};

const MATCH_THRESHOLD = 0.35; // 低于此分数不命中

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
 * 加载 Memory（带缓存 + 自动迁移）。
 */
function loadMemory() {
  if (memoryCache) return memoryCache;
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      // V0.4.5: 自动迁移旧格式 (v1 → v2)
      if (data.entries && data.entries.length > 0 && !data.entries[0].context) {
        data.entries = data.entries.map(migrateV1ToV2);
      }
      memoryCache = data;
    } else {
      memoryCache = { version: 2, entries: [] };
    }
  } catch (err) {
    console.error('[memory] 加载失败，使用空记忆:', err.message);
    memoryCache = { version: 2, entries: [] };
  }
  return memoryCache;
}

/**
 * 保存 Memory 到磁盘。
 */
function saveMemory(data) {
  ensureDir();
  data.version = 2;
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  memoryCache = data;
}

/**
 * V0.4.5: 旧格式 (v1) → 新格式 (v2) 自动迁移。
 */
function migrateV1ToV2(old) {
  return {
    id: old.id || 'mem_migrated_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    type: old.type || 'target_override',
    context: {
      filenameKeywords: old.filePattern ? [old.filePattern.replace('*', '').replace('.', '')] : [],
      contentKeywords: old.keywords || [],
      entities: [],
      contentTheme: '',
      extension: '',
      relationshipGroup: old.groupName || '',
    },
    action: {
      target: old.target || '',
      excluded: old.type === 'exclude',
    },
    confidence: {
      level: 'candidate',
      score: 0.3,
      usageCount: 1,
    },
    timestamp: {
      createdAt: old.timestamp || new Date().toISOString(),
      lastUsedAt: old.timestamp || new Date().toISOString(),
    },
    source: old.source || 'user',
    reason: old.reason || '',
  };
}

/**
 * 从文件中提取上下文信息。
 *
 * @param {object} file - 分类后的文件
 * @param {object} [relationshipGroup] - 可选的关系组信息
 * @returns {object} context
 */
/**
 * 记录一条用户决策（Schema v2）。
 *
 * @param {object} entry - 决策数据
 * @param {object} [entry.file] - 文件对象（用于提取上下文）
 * @param {object} [entry.relationshipGroup] - 关系组名
 * @returns {object} 完整的 memory entry
 */
function recordDecision(entry) {
  const data = loadMemory();

  const ctx = entry.file
    ? extractContext(entry.file, entry.relationshipGroup || '')
    : (entry.context || {
      filenameKeywords: entry.filePattern ? [entry.filePattern] : [],
      contentKeywords: entry.keywords || [],
      entities: [],
      contentTheme: '',
      extension: '',
      relationshipGroup: entry.groupName || '',
    });

  const fullEntry = {
    id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    type: entry.type || 'target_override',
    context: ctx,
    action: {
      target: entry.target || entry.action?.target || '',
      excluded: entry.type === 'exclude' || entry.action?.excluded || false,
    },
    confidence: {
      level: 'candidate',
      score: 0.3,
      usageCount: 1,
    },
    timestamp: {
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    },
    source: entry.source || 'user',
    reason: entry.reason || '',
  };

  data.entries.push(fullEntry);

  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(-MAX_ENTRIES);
  }

  saveMemory(data);
  return fullEntry;
}

/**
 * 从文件中提取上下文信息。
 *
 * @param {object} file - 分类后的文件
 * @param {object} [relationshipGroup] - 可选的关系组信息
 * @returns {object} context
 */
function extractContext(file, relationshipGroup = null) {
  const ctx = {
    filenameKeywords: [],
    contentKeywords: [],
    entities: [],
    contentTheme: '',
    extension: '',
    relationshipGroup: '',
  };

  // 文件名片段
  const nameWithoutExt = path.basename(file.name, path.extname(file.name));
  const nameParts = nameWithoutExt.split(/[-_\s]/);
  for (const part of nameParts) {
    if (part.length >= 2) ctx.filenameKeywords.push(part.toLowerCase());
  }

  // 扩展名
  const ext = path.extname(file.name).replace('.', '').toLowerCase();
  ctx.extension = ext;

  // 内容主题
  ctx.contentTheme = file.contentTheme || '';

  // 内容摘要
  if (file.contentSummary) {
    if (file.contentSummary.keywords) {
      for (const k of file.contentSummary.keywords) {
        ctx.contentKeywords.push(k.toLowerCase());
      }
    }
    if (file.contentSummary.entities) {
      for (const e of file.contentSummary.entities) {
        ctx.entities.push(e.toLowerCase());
      }
    }
  }

  // 关系组
  if (relationshipGroup) {
    ctx.relationshipGroup = relationshipGroup;
  }

  return ctx;
}

/**
 * 计算两个上下文的匹配分数。
 *
 * @param {object} ctx1 - Memory 上下文
 * @param {object} ctx2 - 文件上下文
 * @returns {number} 0-1 匹配分数
 */
function contextMatchScore(ctx1, ctx2) {
  let totalWeight = 0;
  let matchedWeight = 0;

  // contentTheme（30%）
  const weight = CONTEXT_WEIGHTS.contentTheme;
  totalWeight += weight;
  if (ctx1.contentTheme && ctx2.contentTheme && ctx1.contentTheme === ctx2.contentTheme) {
    matchedWeight += weight;
  }

  // entities（25%）— 完全不重叠时施加惩罚
  const entWeight = CONTEXT_WEIGHTS.entities;
  totalWeight += entWeight;
  if (ctx1.entities && ctx2.entities && ctx1.entities.length > 0 && ctx2.entities.length > 0) {
    const sharedEnt = ctx2.entities.filter(e => ctx1.entities.includes(e));
    if (sharedEnt.length > 0) {
      matchedWeight += entWeight * (sharedEnt.length / Math.max(ctx1.entities.length, ctx2.entities.length));
    } else {
      // 实体完全不重叠 → 强负信号（不同项目/不同实体）
      matchedWeight -= entWeight * 1.0;
    }
  }

  // contentKeywords（20%）
  const ckWeight = CONTEXT_WEIGHTS.contentKeywords;
  totalWeight += ckWeight;
  if (ctx1.contentKeywords && ctx2.contentKeywords && ctx1.contentKeywords.length > 0) {
    const sharedKw = ctx2.contentKeywords.filter(k => ctx1.contentKeywords.includes(k));
    if (sharedKw.length > 0) {
      matchedWeight += ckWeight * (sharedKw.length / Math.max(ctx1.contentKeywords.length, ctx2.contentKeywords.length));
    }
  }

  // filenameKeywords（15%）
  const fkWeight = CONTEXT_WEIGHTS.filenameKeywords;
  totalWeight += fkWeight;
  if (ctx1.filenameKeywords && ctx2.filenameKeywords && ctx1.filenameKeywords.length > 0) {
    const sharedFk = ctx2.filenameKeywords.filter(k => ctx1.filenameKeywords.includes(k));
    if (sharedFk.length > 0) {
      matchedWeight += fkWeight * (sharedFk.length / Math.max(ctx1.filenameKeywords.length, ctx2.filenameKeywords.length));
    }
  }

  // extension（10%）
  const extWeight = CONTEXT_WEIGHTS.extension;
  totalWeight += extWeight;
  if (ctx1.extension && ctx2.extension && ctx1.extension === ctx2.extension) {
    matchedWeight += extWeight;
  }

  const score = totalWeight > 0 ? matchedWeight / totalWeight : 0;
  return Math.max(0, score);
}

/**
 * 计算 Memory 置信度等级。
 *
 * @param {object} entry - Memory entry
 * @param {number} matchScore - 上下文匹配分数
 * @returns {object} { level, score, usageCount }
 */
function computeConfidence(entry, matchScore) {
  const now = Date.now();
  const created = new Date(entry.timestamp.createdAt).getTime();
  const ageDays = (now - created) / (1000 * 60 * 60 * 24);
  const usageCount = entry.confidence.usageCount;

  // 时间衰减：180 天外的 Memory 降级
  const timeFactor = Math.max(0.1, 1 - ageDays / 180);

  // 基础分数
  let score = 0.3 + usageCount * 0.1 + matchScore * 0.3;
  score *= timeFactor;

  // 确定等级
  let level = 'candidate';
  if (usageCount >= CONFIDENCE.TRUSTED.usageMin && score >= CONFIDENCE.TRUSTED.score && ageDays <= CONFIDENCE.TRUSTED.daysRecent) {
    level = 'trusted';
  } else if (usageCount >= CONFIDENCE.LEARNED.usageMin && score >= CONFIDENCE.LEARNED.score && ageDays <= CONFIDENCE.LEARNED.daysRecent) {
    level = 'learned';
  }

  return { level, score: Math.round(score * 1000) / 1000, usageCount };
}

/**
 * 从 Memory 中查找文件的建议目标。
 *
 * V0.4.5: 使用上下文匹配 + 置信度生命周期。
 *
 * @param {object} file - 分类后的文件
 * @param {object} [relationshipGroup] - 关系组信息
 * @returns {object|null} { target, confidence, level, reason, matchScore, entries, participates }
 */
function lookupMemorySuggestion(file, relationshipGroup = null) {
  const data = loadMemory();
  const fileCtx = extractContext(file, relationshipGroup);

  // 只查询 target_override 类型
  const candidates = data.entries.filter(e => e.type === 'target_override');

  if (candidates.length === 0) return null;

  // 计算每个 Memory 的匹配分数
  const scored = [];
  for (const entry of candidates) {
    const matchScore = contextMatchScore(entry.context, fileCtx);
    if (matchScore < MATCH_THRESHOLD) continue;

    const conf = computeConfidence(entry, matchScore);
    scored.push({ entry, matchScore, ...conf });
  }

  if (scored.length === 0) return null;

  // 按置信度分数排序
  scored.sort((a, b) => b.score - a.score);

  // 取最高分
  const best = scored[0];

  // V0.4.5: candidate 级别不参与最终决策
  if (best.level === 'candidate') {
    return {
      target: best.entry.action.target,
      confidence: best.score,
      level: best.level,
      reason: `候选记忆（${best.entry.confidence.usageCount} 次），待更多数据确认`,
      matchScore: best.matchScore,
      entries: [best.entry],
      participates: false, // 不参与最终决策
    };
  }

  // learned / trusted 参与决策
  return {
    target: best.entry.action.target,
    confidence: best.score,
    level: best.level,
    reason: `过去90天内，用户${best.entry.confidence.usageCount}次将类似文件放入「${best.entry.action.target}」`,
    matchScore: best.matchScore,
    entries: scored.slice(0, 5),
    participates: true,
  };
}

/**
 * 更新 Memory 的使用计数。
 *
 * @param {string} entryId
 */
function touchMemory(entryId) {
  const data = loadMemory();
  const entry = data.entries.find(e => e.id === entryId);
  if (entry) {
    entry.confidence.usageCount++;
    entry.timestamp.lastUsedAt = new Date().toISOString();
    // 重新计算等级
    const conf = computeConfidence(entry, 1.0);
    entry.confidence.level = conf.level;
    entry.confidence.score = conf.score;
    saveMemory(data);
  }
}

/**
 * 查询匹配的 Memory 条目。
 *
 * @param {object} query
 * @returns {object[]} 匹配的 memory 条目
 */
function queryMemory(query = {}) {
  const data = loadMemory();
  let entries = data.entries;

  if (query.type) {
    entries = entries.filter(e => e.type === query.type);
  }

  if (query.level) {
    entries = entries.filter(e => e.confidence.level === query.level);
  }

  if (query.keywords && query.keywords.length > 0) {
    entries = entries.filter(e => {
      const ctx = e.context;
      const allKw = [
        ...(ctx.contentKeywords || []),
        ...(ctx.filenameKeywords || []),
      ];
      return query.keywords.some(k => allKw.includes(k.toLowerCase()));
    });
  }

  return entries.sort((a, b) => new Date(b.timestamp.createdAt) - new Date(a.timestamp.createdAt));
}

/**
 * 清空所有 Memory。
 */
function clearMemory() {
  saveMemory({ version: 2, entries: [] });
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
  const byLevel = {};
  for (const e of data.entries) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    byLevel[e.confidence.level] = (byLevel[e.confidence.level] || 0) + 1;
  }
  return {
    total: data.entries.length,
    byType,
    byLevel,
    version: data.version,
    oldest: data.entries.length > 0 ? data.entries[0].timestamp.createdAt : null,
    newest: data.entries.length > 0 ? data.entries[data.entries.length - 1].timestamp.createdAt : null,
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
  extractContext,
  contextMatchScore,
  computeConfidence,
  lookupMemorySuggestion,
  touchMemory,
  clearMemory,
  deleteEntry,
  getMemoryStats,
  exportMemory,
  MEMORY_FILE,
  CONFIDENCE,
  CONTEXT_WEIGHTS,
};