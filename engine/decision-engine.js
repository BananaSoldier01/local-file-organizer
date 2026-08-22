/**
 * decision-engine.js — Unified Decision Engine (V0.5.2)
 *
 * 统一决策中心。将分散在 Organizer 中的判断逻辑集中管理。
 *
 * 输入：
 *   file + Memory + File State + Relationship State + Agent History
 *
 * 输出：
 *   Decision + Evidence + Confidence
 *
 * 优先级链：
 *   User Override
 *   > Trusted Memory
 *   > Learned Memory
 *   > Existing Organization State
 *   > Relationship State
 *   > Classification
 *
 * 原则：
 * - 每个决策必须携带可解释证据
 * - 观察状态 > 推断状态
 * - 用户操作永远最高优先级
 */

const path = require('path');
const memory = require('./memory');
const fileState = require('./file-state');
const relationshipState = require('./relationship-state');
const agentHistory = require('./agent-history');

// ── 优先级常量 ────────────────────────────────────────────
const PRIORITY = {
  USER_OVERRIDE:          100,
  TRUSTED_MEMORY:          80,
  LEARNED_MEMORY:          60,
  EXISTING_ORG_STATE:      40,
  RELATIONSHIP_STATE:      20,
  CLASSIFICATION:          10,
};

// ── 决策引擎 ──────────────────────────────────────────────
/**
 * 为单个文件生成整理决策。
 *
 * @param {object} file - 分类后的文件
 * @param {object} context - 决策上下文
 * @param {object} [context.relationshipGroups] - Relationship Group 数组
 * @param {object} [context.groupSuggestions] - Group Suggestion 数组
 * @param {object} [context.options] - 额外选项
 * @returns {object} 决策结果
 */
function decide(file, context = {}) {
  const {
    relationshipGroups = null,
    groupSuggestions = [],
    options = {},
  } = context;

  const customTargets = options.customTargets || {};
  const targetRoot = options.targetRoot || null;
  const flatten = options.flatten || false;

  // 收集所有候选决策
  const candidates = [];

  // ── 1. User Override（最高优先级） ──
  if (file._userOverride) {
    candidates.push({
      source: 'user_override',
      priority: PRIORITY.USER_OVERRIDE,
      target: customTargets[file.suggestedTarget] || file.suggestedTarget || '其他',
      reason: '用户手工修改目标目录',
      evidence: {
        type: 'user_action',
        detail: `用户将目标设置为 "${file.suggestedTarget}"`,
      },
      confidence: 1.0,
    });
  }

  // ── 2. Memory（Trusted > Learned） ──
  const memSug = memory.lookupMemorySuggestion(file);
  if (memSug && memSug.participates) {
    const isTrusted = memSug.level === 'trusted';
    candidates.push({
      source: isTrusted ? 'trusted_memory' : 'learned_memory',
      priority: isTrusted ? PRIORITY.TRUSTED_MEMORY : PRIORITY.LEARNED_MEMORY,
      target: customTargets[memSug.target] || memSug.target,
      reason: memSug.reason,
      evidence: {
        type: 'memory',
        detail: memSug.reason,
        memoryId: memSug.entries?.[0]?.id || '',
        level: memSug.level,
        score: memSug.confidence,
        matchScore: memSug.matchScore,
      },
      confidence: memSug.confidence,
    });
  }

  // ── 3. Existing Organization State ──
  const existingTarget = fileState.getOrganizationTargets ?
    fileState.getOrganizationTargets().get(file.path) : null;
  if (existingTarget) {
    candidates.push({
      source: 'existing_org_state',
      priority: PRIORITY.EXISTING_ORG_STATE,
      target: existingTarget,
      reason: `文件历史组织目录为「${existingTarget}」，保持一致性`,
      evidence: {
        type: 'file_state',
        detail: `File State 记录该文件目标为 "${existingTarget}"`,
      },
      confidence: 0.85,
    });
  }

  // ── 4. Relationship State ──
  const relGroup = relationshipState.getGroupContaining ?
    relationshipState.getGroupContaining(file.path) : null;
  if (relGroup) {
    candidates.push({
      source: 'relationship_state',
      priority: PRIORITY.RELATIONSHIP_STATE,
      target: relGroup.name,
      reason: `文件属于 Group「${relGroup.name}」（持久化关系状态）`,
      evidence: {
        type: 'relationship_state',
        detail: `Relationship State Group "${relGroup.name}"，包含 ${relGroup.files.length} 个文件`,
        groupId: relGroup.groupId,
        entities: [...relGroup.entities],
      },
      confidence: relGroup.confidence || 0.7,
    });
  }

  // ── 5. Relationship Group Suggestion（来自 Relationship Engine） ──
  if (relationshipGroups && relationshipGroups.length > 0) {
    for (let g = 0; g < relationshipGroups.length; g++) {
      const group = relationshipGroups[g];
      const groupFiles = group.files || [];
      const inGroup = groupFiles.some(f => {
        const fId = typeof f === 'string' ? f : (f.path || f.name);
        return fId === (file.path || file.name);
      });
      if (inGroup) {
        const suggestion = groupSuggestions.find(s =>
          s.files.some(f => {
            const fId = typeof f === 'string' ? f : (f.path || f.name);
            return fId === (file.path || file.name);
          })
        );
        const groupName = suggestion ? suggestion.groupName : (group.name || '未命名');
        candidates.push({
          source: 'relationship',
          priority: PRIORITY.RELATIONSHIP_STATE,
          target: groupName,
          reason: suggestion ?
            `属于 Group「${groupName}」（关系分析建议）` :
            `属于 Group「${groupName}」`,
          evidence: {
            type: 'relationship',
            detail: suggestion ?
              `Relationship Group "${groupName}"，置信度 ${suggestion.confidence || group.cohesion}` :
              `Relationship Group "${groupName}"`,
            cohesion: group.cohesion,
            coreEntities: group.coreEntities ? [...group.coreEntities] : [],
          },
          confidence: suggestion ? (suggestion.confidence || 0.7) : (group.cohesion || 0.5),
        });
        break; // 只取第一个匹配的 Group
      }
    }
  }

  // ── 6. Classification（兜底） ──
  candidates.push({
    source: 'classification',
    priority: PRIORITY.CLASSIFICATION,
    target: customTargets[file.suggestedTarget] || file.suggestedTarget || '其他',
    reason: `基于内容分类：${file.contentTheme || '默认'}`,
    evidence: {
      type: 'classification',
      detail: `Classification: theme="${file.contentTheme}", confidence=${file.confidence}`,
      theme: file.contentTheme,
      confidence: file.confidence,
    },
    confidence: file.confidence || 0.5,
  });

  // ── 选择最高优先级 ──
  candidates.sort((a, b) => b.priority - a.priority);
  const best = candidates[0];

  // 构建完整证据链
  const evidenceChain = candidates.map(c => ({
    source: c.source,
    priority: c.priority,
    target: c.target,
    reason: c.reason,
    confidence: c.confidence,
  }));

  return {
    target: best.target,
    source: best.source,
    priority: best.priority,
    confidence: best.confidence,
    reason: best.reason,
    evidence: best.evidence,
    evidenceChain,
    candidates: candidates.map(c => ({
      source: c.source,
      target: c.target,
      priority: c.priority,
    })),
  };
}

/**
 * 批量决策（为多个文件生成决策）。
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
 * 生成决策摘要（用于 Plan 和 UI）。
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
  PRIORITY,
};