/**
 * similarity.js — 文件相似度引擎 (V0.4.2.1)
 *
 * 基于 Semantic Fingerprint 计算两个文件之间的相似度。
 * 纯规则驱动，可解释，无 LLM 依赖。
 *
 * V0.4.2.1 核心修复：
 * - 主题相同不能单独建立关系（权重从 0.4 降至 0.15，且需要额外证据）
 * - 实体匹配要求"真共享"（双方都包含该实体）
 * - 候选索引替代全量遍历
 *
 * 相似度维度：
 * 1. 实体匹配（共享实体）— 最强信号
 * 2. 关键词重叠（Jaccard）
 * 3. 主题匹配（需额外证据才能计分）
 * 4. 路径邻近度（同目录加分）
 * 5. 文件名相似度（编辑距离）
 */

const path = require('path');

// ── 维度权重（V0.4.2.1 调优） ──────────────────────────────
const WEIGHTS = {
  entity: 0.35,    // 共享实体 — 最强信号（每实体 0.18，上限 0.35）
  keyword: 0.25,   // 关键词 Jaccard
  theme: 0.15,     // 主题匹配 — 需要额外证据
  directory: 0.15, // 路径邻近
  name: 0.10,      // 文件名相似度
};

// ── 阈值 ──────────────────────────────────────────────────
const THRESHOLDS = {
  minScore: 0.3,       // 最低相似度阈值
  strongEdge: 0.4,     // 强边阈值（用于 group core 检测）
  entityCoverage: 0.5, // 实体覆盖率阈值（group cohesion）
  nameCandidate: 0.85, // 文件名候选阈值
};

/**
 * 计算两个 Fingerprint 之间的相似度。
 *
 * V0.4.2.1: 主题匹配降权，需要实体/关键词/名称证据才能产生高分。
 *
 * @param {object} a - Fingerprint
 * @param {object} b - Fingerprint
 * @returns {object} { score, evidence, signals }
 */
function similarity(a, b) {
  if (!a || !b) return { score: 0, evidence: [], signals: {} };

  const evidence = [];
  const signals = {};

  // 1. 实体匹配（最强信号）
  const entA = new Set(a.entities || []);
  const entB = new Set(b.entities || []);
  const sharedEntities = [...entA].filter(e => entB.has(e));
  let entScore = 0;
  if (sharedEntities.length > 0) {
    // 实体匹配分数：每共享一个实体给 0.18，上限 0.35
    entScore = Math.min(WEIGHTS.entity, sharedEntities.length * 0.18);
    signals.entity = sharedEntities.length;
    evidence.push(`共享实体: ${sharedEntities.slice(0, 3).join(', ')}`);
  }

  // 2. 关键词 Jaccard 相似度
  const kwA = new Set(a.keywords || []);
  const kwB = new Set(b.keywords || []);
  const kwJaccard = jaccard(kwA, kwB);
  const kwScore = kwJaccard * WEIGHTS.keyword;
  if (kwJaccard > 0) {
    signals.keyword = Math.round(kwJaccard * 1000) / 1000;
    evidence.push(`关键词重叠 ${Math.round(kwJaccard * 100)}%: ${[...kwA].filter(k => kwB.has(k)).slice(0, 3).join(', ')}`);
  }

  // 3. 主题匹配（V0.4.2.1: 降权，且需要额外证据）
  let themeScore = 0;
  let hasAdditionalEvidence = sharedEntities.length > 0 || kwJaccard > 0.15 || nameSimilarity(a.name, b.name) > 0.5;
  if (a.theme === b.theme && a.theme !== '默认' && hasAdditionalEvidence) {
    themeScore = WEIGHTS.theme;
    signals.theme = true;
    evidence.push(`主题相同: "${a.theme}"`);
  } else if (a.theme === b.theme && a.theme !== '默认') {
    // 主题相同但无额外证据 — 不给分，也不记录
    // 防止"两个文件都是 theme=项目 但实际是不同项目"产生假关系
  }

  // 4. 路径邻近度
  const dirA = a.dir || '';
  const dirB = b.dir || '';
  let dirScore = 0;
  if (dirA === dirB && dirA) {
    dirScore = WEIGHTS.directory;
    signals.directory = true;
    evidence.push(`同目录: ${dirA}`);
  } else if (dirA && dirB && (dirA.startsWith(dirB) || dirB.startsWith(dirA))) {
    dirScore = WEIGHTS.directory * 0.5;
    signals.directory = true;
    evidence.push(`路径邻近: ${dirA} ↔ ${dirB}`);
  }

  // 5. 文件名相似度（编辑距离）
  const nameSim = nameSimilarity(a.name, b.name);
  const nameScore = nameSim * WEIGHTS.name;
  if (nameSim > 0.3) {
    signals.name = Math.round(nameSim * 1000) / 1000;
    evidence.push(`文件名相似度 ${Math.round(nameSim * 100)}%`);
  }

  const score = Math.min(1, themeScore + kwScore + entScore + dirScore + nameScore);

  return {
    score: Math.round(score * 1000) / 1000,
    evidence: evidence.slice(0, 5),
    signals,
  };
}

/**
 * 候选过滤：判断两个文件是否值得比较。
 *
 * V0.4.2.1: 主题相同不再单独作为候选条件。
 * 必须有：实体重叠 / 关键词重叠 / 同目录 / 文件名高度相似。
 *
 * @param {object} a - Fingerprint
 * @param {object} b - Fingerprint
 * @returns {boolean} 是否值得比较
 */
function isCandidatePair(a, b) {
  if (!a || !b) return false;

  // 实体有重叠（强信号）
  const entA = new Set(a.entities || []);
  const entB = new Set(b.entities || []);
  if ([...entA].some(e => entB.has(e))) return true;

  // 关键词有重叠
  const kwA = new Set(a.keywords || []);
  const kwB = new Set(b.keywords || []);
  if ([...kwA].some(k => kwB.has(k))) return true;

  // 同目录
  if (a.dir && a.dir === b.dir) return true;

  // 文件名高度相似（编辑距离 < 15%）
  if (nameSimilarity(a.name, b.name) > THRESHOLDS.nameCandidate) return true;

  // 主题相同不再单独触发 — 防止"项目A vs 项目B"产生假候选
  return false;
}

/**
 * 候选索引：基于倒排索引快速找到候选对，避免全量 N²。
 *
 * @param {Array} fingerprints - Fingerprint 数组
 * @returns {Array} 候选对数组 [{ i, j }]
 */
function buildCandidateIndex(fingerprints) {
  const pairs = new Set();
  const n = fingerprints.length;

  // 倒排索引：entity → [indices]
  const entityIndex = new Map();
  const keywordIndex = new Map();
  const dirIndex = new Map();

  for (let i = 0; i < n; i++) {
    const fp = fingerprints[i].fingerprint;

    // 实体索引
    for (const e of fp.entities || []) {
      if (!entityIndex.has(e)) entityIndex.set(e, []);
      entityIndex.get(e).push(i);
    }

    // 关键词索引
    for (const k of fp.keywords || []) {
      if (!keywordIndex.has(k)) keywordIndex.set(k, []);
      keywordIndex.get(k).push(i);
    }

    // 目录索引
    if (fp.dir) {
      if (!dirIndex.has(fp.dir)) dirIndex.set(fp.dir, []);
      dirIndex.get(fp.dir).push(i);
    }
  }

  // 从实体索引生成候选对
  for (const [, indices] of entityIndex) {
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        const key = indices[x] < indices[y]
          ? `${indices[x]}||${indices[y]}`
          : `${indices[y]}||${indices[x]}`;
        pairs.add(key);
      }
    }
  }

  // 从关键词索引生成候选对
  for (const [, indices] of keywordIndex) {
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        const key = indices[x] < indices[y]
          ? `${indices[x]}||${indices[y]}`
          : `${indices[y]}||${indices[x]}`;
        pairs.add(key);
      }
    }
  }

  // 从目录索引生成候选对
  for (const [, indices] of dirIndex) {
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        const key = indices[x] < indices[y]
          ? `${indices[x]}||${indices[y]}`
          : `${indices[y]}||${indices[x]}`;
        pairs.add(key);
      }
    }
  }

  // 解析为 { i, j } 数组
  const result = [];
  for (const key of pairs) {
    const [i, j] = key.split('||').map(Number);
    result.push({ i, j });
  }

  return result;
}

/**
 * 主题重叠度（基于关键词集合）
 */
function themeOverlap(themeA, themeB) {
  if (!themeA || !themeB) return 0;
  const a = new Set(String(themeA).split(/[,\s、]+/).filter(Boolean));
  const b = new Set(String(themeB).split(/[,\s、]+/).filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  return jaccard(a, b);
}

/**
 * Jaccard 相似度
 */
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 文件名相似度（基于编辑距离的归一化）
 */
function nameSimilarity(nameA, nameB) {
  if (!nameA || !nameB) return 0;
  const a = path.basename(nameA, path.extname(nameA));
  const b = path.basename(nameB, path.extname(nameB));
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
  return 1 - dist / maxLen;
}

/**
 * Levenshtein 编辑距离
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],
          dp[i][j - 1],
          dp[i - 1][j - 1]
        );
      }
    }
  }
  return dp[m][n];
}

module.exports = {
  similarity,
  isCandidatePair,
  buildCandidateIndex,
  jaccard,
  nameSimilarity,
  levenshtein,
  WEIGHTS,
  THRESHOLDS,
};