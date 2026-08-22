/**
 * feedback.js — Plan Feedback Collection (V0.4.5)
 *
 * 在 User Review 阶段收集用户决策，写入 Memory (Schema v2)。
 *
 * 原则：
 * - 只记录用户明确操作
 * - 不记录被动行为
 * - 写入可追踪（带 timestamp 和 source）
 */

const memory = require('./memory');

/**
 * 从 Plan Review 结果中收集用户决策。
 *
 * @param {object} planData - 服务器返回的 Plan 数据
 * @param {object} userDecisions - 用户在前端的操作
 * @param {object} options
 * @returns {object} 收集结果
 */
function collectFeedback(planData, userDecisions, options = {}) {
  const results = { recorded: 0, skipped: 0, errors: [] };

  // ── Target Override ──
  if (userDecisions.targetOverrides && Array.isArray(userDecisions.targetOverrides)) {
    for (const override of userDecisions.targetOverrides) {
      try {
        memory.recordDecision({
          type: 'target_override',
          file: override.file || { name: override.filePattern, path: override.filePattern },
          target: override.target,
          reason: override.reason || `用户将目标改为 "${override.target}"`,
        });
        results.recorded++;
      } catch (err) {
        results.errors.push(`target_override: ${err.message}`);
      }
    }
  }

  // ── Exclude Decisions ──
  if (userDecisions.excludedFiles && Array.isArray(userDecisions.excludedFiles)) {
    for (const excl of userDecisions.excludedFiles) {
      try {
        memory.recordDecision({
          type: 'exclude',
          file: excl.file || { name: excl.filePattern, path: excl.filePattern },
          reason: excl.reason || `用户排除了文件`,
        });
        results.recorded++;
      } catch (err) {
        results.errors.push(`exclude: ${err.message}`);
      }
    }
  }

  // ── Relationship Accept ──
  if (userDecisions.relationshipAccepts && Array.isArray(userDecisions.relationshipAccepts)) {
    for (const accept of userDecisions.relationshipAccepts) {
      try {
        memory.recordDecision({
          type: 'relationship_accept',
          groupName: accept.groupName,
          relationshipGroup: accept.groupName,
          reason: accept.reason || `用户接受了 Group "${accept.groupName}"`,
        });
        results.recorded++;
      } catch (err) {
        results.errors.push(`relationship_accept: ${err.message}`);
      }
    }
  }

  // ── Relationship Reject ──
  if (userDecisions.relationshipRejects && Array.isArray(userDecisions.relationshipRejects)) {
    for (const reject of userDecisions.relationshipRejects) {
      try {
        memory.recordDecision({
          type: 'relationship_reject',
          groupName: reject.groupName,
          relationshipGroup: reject.groupName,
          reason: reject.reason || `用户拒绝了 Group "${reject.groupName}"`,
        });
        results.recorded++;
      } catch (err) {
        results.errors.push(`relationship_reject: ${err.message}`);
      }
    }
  }

  return results;
}

/**
 * 从 Plan 执行结果中提取用户决策。
 *
 * @param {object} originalPlan - 原始 Plan
 * @param {object} executedPlan - 实际执行的 Plan（含用户修改）
 * @returns {object} 提取的决策
 */
function extractDecisionsFromExecution(originalPlan, executedPlan) {
  const decisions = {
    targetOverrides: [],
    excludedFiles: [],
    relationshipAccepts: [],
    relationshipRejects: [],
  };

  if (!originalPlan?.moves || !executedPlan?.moves) return decisions;

  const originalMap = new Map();
  for (const m of originalPlan.moves) {
    originalMap.set(m.from, m);
  }

  for (const move of executedPlan.moves) {
    const original = originalMap.get(move.from);
    if (!original) continue;

    if (original.to !== move.to) {
      function extractDirName(filePath) {
        const parts = filePath.split('/').filter(Boolean);
        return parts.length >= 2 ? parts[parts.length - 2] : '';
      }

      const originalTargetDir = extractDirName(original.to);
      const newTargetDir = extractDirName(move.to);

      if (originalTargetDir && newTargetDir && originalTargetDir !== newTargetDir) {
        decisions.targetOverrides.push({
          file: { name: move.from, path: move.from },
          target: newTargetDir,
          originalTarget: originalTargetDir,
          reason: `执行时用户将目标从 "${originalTargetDir}" 改为 "${newTargetDir}"`,
        });
      }
    }
  }

  return decisions;
}

module.exports = {
  collectFeedback,
  extractDecisionsFromExecution,
};