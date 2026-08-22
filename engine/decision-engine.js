/**
 * decision-engine.js — Unified Decision Engine (V0.5.3)
 *
 * 可扩展的 Decision Intelligence Framework。
 *
 * Pipeline:
 *   Collect Candidates
 *   → Normalize Candidates
 *   → Resolve Conflict
 *   → Generate Final Decision
 *   → Generate Explanation
 *
 * 优先级链：
 *   User Override > Trusted Memory > Learned Memory
 *   > Existing Org State > Relationship State > Classification
 *
 * 为未来 LLM / Embedding Provider 预留接口。
 */

const path = require('path');
const decisionProvider = require('./decision-provider');

// ── 决策引擎 ──────────────────────────────────────────────
/**
 * 为单个文件生成整理决策（Pipeline 架构）。
 *
 * @param {object} file - 分类后的文件
 * @param {object} context - 决策上下文
 * @param {object} [options]
 * @returns {object} 决策结果
 */
function decide(file, context = {}) {
  // Step 1: Collect Candidates
  const candidates = decisionProvider.collectCandidates(file, context);

  // Step 2: Normalize Candidates
  const normalized = normalizeCandidates(candidates);

  // Step 3: Resolve Conflict
  const resolved = resolveConflict(normalized);

  // Step 4: Generate Final Decision
  const final = generateFinal(resolved, file, context);

  // Step 5: Generate Explanation
  const explanation = generateExplanation(final, normalized, file);

  return {
    ...final,
    explanation,
    candidates: normalized.map(c => ({
      source: c.source,
      target: c.target,
      priority: c.priority,
      confidence: c.confidence,
    })),
  };
}

/**
 * Step 2: 标准化候选决策。
 *
 * @param {object[]} candidates - 原始候选
 * @returns {object[]} 标准化候选
 */
function normalizeCandidates(candidates) {
  return candidates.map(c => ({
    source: c.source,
    target: c.target,
    confidence: c.confidence,
    priority: c.priority,
    evidence: c.evidence || [],
  })).sort((a, b) => b.priority - a.priority);
}

/**
 * Step 3: 冲突解决 — 选择最高优先级。
 * 相同 target 的候选合并 evidence。
 *
 * @param {object[]} candidates - 标准化候选
 * @returns {object[]} 冲突解决后的候选
 */
function resolveConflict(candidates) {
  if (candidates.length === 0) return [];

  // 按优先级排序，同 target 合并
  const merged = new Map();
  for (const c of candidates) {
    const key = c.target;
    if (!merged.has(key)) {
      merged.set(key, { ...c, evidence: [...c.evidence] });
    } else {
      const existing = merged.get(key);
      existing.evidence.push(...c.evidence);
      existing.confidence = Math.max(existing.confidence, c.confidence);
    }
  }

  // 按优先级排序
  return Array.from(merged.values()).sort((a, b) => b.priority - a.priority);
}

/**
 * Step 4: 生成最终决策。
 *
 * @param {object[]} resolved - 冲突解决后的候选
 * @param {object} file - 文件
 * @param {object} context - 上下文
 * @returns {object} 最终决策
 */
function generateFinal(resolved, file, context) {
  if (resolved.length === 0) {
    // 兜底：使用 Classification
    const customTargets = context.options?.customTargets || {};
    return {
      target: customTargets[file.suggestedTarget] || file.suggestedTarget || '其他',
      source: 'classification',
      priority: 10,
      confidence: file.confidence || 0.5,
      reason: `基于内容分类：${file.contentTheme || '默认'}`,
      evidence: {
        type: 'classification',
        detail: `Classification: theme="${file.contentTheme}", confidence=${file.confidence}`,
        theme: file.contentTheme,
        confidence: file.confidence,
      },
      evidenceChain: [],
    };
  }

  const best = resolved[0];
  return {
    target: best.target,
    source: best.source,
    priority: best.priority,
    confidence: best.confidence,
    reason: best.evidence[0]?.detail || `基于 ${best.source} 决策`,
    evidence: best.evidence[0] || { type: best.source, detail: '' },
    evidenceChain: resolved,
  };
}

/**
 * Step 5: 生成结构化解释。
 *
 * @param {object} final - 最终决策
 * @param {object[]} candidates - 所有候选
 * @param {object} file - 文件
 * @returns {object} 结构化解释
 */
function generateExplanation(final, candidates, file) {
  const reasons = [];
  const sources = new Set();

  // 主决策原因
  if (final.evidence) {
    reasons.push(final.evidence.detail);
    sources.add(final.evidence.type);
  }

  // 其他候选的简要说明
  for (const c of candidates.slice(1)) {
    if (c.evidence && c.evidence.length > 0) {
      sources.add(c.evidence[0].type);
    }
  }

  return {
    summary: `建议整理到 "${final.target}"`,
    reasons: reasons.length > 0 ? reasons : [`基于 ${final.source} 决策`],
    confidence: final.confidence,
    confidenceLabel: confidenceLabel(final.confidence),
    sources: Array.from(sources),
    primarySource: final.source,
    alternativeCount: Math.max(0, candidates.length - 1),
  };
}

/**
 * 置信度标签。
 */
function confidenceLabel(confidence) {
  if (confidence >= 0.9) return '极高';
  if (confidence >= 0.7) return '高';
  if (confidence >= 0.5) return '中等';
  if (confidence >= 0.3) return '较低';
  return '低';
}

/**
 * 批量决策。
 *
 * @param {object[]} files - 文件列表
 * @param {object} context - 决策上下文
 * @returns {Map<string, object>} fileId → decision
 */
function decideBatch(files, context = {}) {
  const decisions = new Map();
  for (const file of files) {
    const fileId = file.path || file.name;
    const decision = decide(file, context);
    decisions.set(fileId, decision);
  }
  return decisions;
}

/**
 * 计算决策的最终目标路径。
 *
 * @param {object} decision - 决策结果
 * @param {object} file - 文件
 * @param {object} options - 路径选项
 * @returns {string} 目标路径
 */
function resolveTargetPath(decision, file, options = {}) {
  const { targetRoot = null, flatten = false } = options;
  const targetDirName = decision.target;
  let targetDir;

  if (flatten) {
    targetDir = path.join(file.dir, targetDirName);
  } else if (targetRoot) {
    targetDir = path.join(targetRoot, targetDirName);
  } else {
    targetDir = path.join(file.dir, targetDirName);
  }

  return path.join(targetDir, file.name);
}

/**
 * 生成决策摘要。
 *
 * @param {Map<string, object>} decisions - 决策映射
 * @returns {object} 摘要
 */
function summarizeDecisions(decisions) {
  const bySource = {};
  let totalConfidence = 0;
  let count = 0;

  for (const decision of decisions.values()) {
    bySource[decision.source] = (bySource[decision.source] || 0) + 1;
    totalConfidence += decision.confidence;
    count++;
  }

  return {
    total: count,
    bySource,
    avgConfidence: count > 0 ? Math.round((totalConfidence / count) * 1000) / 1000 : 0,
  };
}

module.exports = {
  decide,
  decideBatch,
  resolveTargetPath,
  summarizeDecisions,
  generateExplanation,
  confidenceLabel,
};