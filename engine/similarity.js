/**
 * similarity.js — 文件相似度引擎 (V0.4.2)
 *
 * 基于 Semantic Fingerprint 计算两个文件之间的相似度。
 * 纯规则驱动，可解释，无 LLM 依赖。
 *
 * 相似度维度：
 * 1. 主题相似度（theme match）
 * 2. 关键词重叠（Jaccard）
 * 3. 实体匹配（共享实体）
 * 4. 路径邻近度（同目录加分）
 * 5. 文件名相似度（编辑距离）
 *
 * 输出：0-1 的相似度分数 + 解释性证据
 */

const path = require('path');

/**
 * 计算两个 Fingerprint 之间的相似度。
 *
 * @param {object} a - Fingerprint
 * @param {object} b - Fingerprint
 * @returns {object} { score, evidence }
 */
function similarity(a, b) {
  if (!a || !b) return { score: 0, evidence: [] };

  const evidence = [];

  // 1. 主题匹配（最高权重）
  let themeScore = 0;
  if (a.theme === b.theme) {
    themeScore = 0.4;
    evidence.push(`主题相同: "${a.theme}"`);
  } else if (themeOverlap(a.theme, b.theme) > 0.3) {
    themeScore = 0.2;
    evidence.push(`主题部分重叠: "${a.theme}" ↔ "${b.theme}"`);
  }

  // 2. 关键词 Jaccard 相似度
  const kwA = new Set(a.keywords || []);
  const kwB = new Set(b.keywords || []);
  const kwJaccard = jaccard(kwA, kwB);
  const kwScore = kwJaccard * 0.25;
  if (kwJaccard > 0) {
    evidence.push(`关键词重叠 ${Math.round(kwJaccard * 100)}%: ${[...kwA].filter(k => kwB.has(k)).slice(0, 3).join(', ')}`);
  }

  // 3. 实体匹配
  const entA = new Set(a.entities || []);
  const entB = new Set(b.entities || []);
  const sharedEntities = [...entA].filter(e => entB.has(e));
  let entScore = 0;
  if (sharedEntities.length > 0) {
    entScore = Math.min(0.15, sharedEntities.length * 0.05);
    evidence.push(`共享实体: ${sharedEntities.slice(0, 3).join(', ')}`);
  }

  // 4. 路径邻近度
  const dirA = a.dir || '';
  const dirB = b.dir || '';
  let dirScore = 0;
  if (dirA === dirB && dirA) {
    dirScore = 0.1;
    evidence.push(`同目录: ${dirA}`);
  } else if (dirA && dirB && (dirA.startsWith(dirB) || dirB.startsWith(dirA))) {
    dirScore = 0.05;
    evidence.push(`路径邻近: ${dirA} ↔ ${dirB}`);
  }

  // 5. 文件名相似度（编辑距离）
  const nameSim = nameSimilarity(a.name, b.name);
  const nameScore = nameSim * 0.1;
  if (nameSim > 0.3) {
    evidence.push(`文件名相似度 ${Math.round(nameSim * 100)}%`);
  }

  const score = Math.min(1, themeScore + kwScore + entScore + dirScore + nameScore);

  return {
    score: Math.round(score * 1000) / 1000,
    evidence: evidence.slice(0, 5),
  };
}

/**
 * 候选过滤：判断两个文件是否值得比较。
 * 基于快速启发式规则，避免全量 N² 比较。
 *
 * @param {object} a - Fingerprint
 * @param {object} b - Fingerprint
 * @returns {boolean} 是否值得比较
 */
function isCandidatePair(a, b) {
  if (!a || !b) return false;

  // 同主题
  if (a.theme === b.theme && a.theme !== '默认') return true;

  // 同目录
  if (a.dir && a.dir === b.dir) return true;

  // 关键词有重叠
  const kwA = new Set(a.keywords || []);
  const kwB = new Set(b.keywords || []);
  if ([...kwA].some(k => kwB.has(k))) return true;

  // 实体有重叠
  const entA = new Set(a.entities || []);
  const entB = new Set(b.entities || []);
  if ([...entA].some(e => entB.has(e))) return true;

  // 文件名高度相似（编辑距离 < 15%，如 project_v1.md vs project_v2.md）
  if (nameSimilarity(a.name, b.name) > 0.85) return true;

  return false;
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
  jaccard,
  nameSimilarity,
  levenshtein,
};