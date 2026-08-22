/**
 * group-namer.js — 分组命名器 (V0.4.3)
 *
 * 基于 Relationship Group 的共享实体、关键词、主题和目录上下文生成建议名称。
 * 不引入 LLM，纯规则驱动。
 *
 * 命名策略：
 * 1. 优先使用共享实体（项目名）
 * 2. 实体 + 关键词组合
 * 3. 降级到主题
 * 4. 最终降级到 "项目资料"
 */

const path = require('path');

/**
 * 生成分组建议名称。
 *
 * @param {object} group - Relationship Group（含 coreEntities, themes, keywords）
 * @param {object} opts - 选项
 * @returns {object} { name, confidence, reason, fallback }
 */
function generateGroupName(group, opts = {}) {
  const entities = group.coreEntities || [];
  const themes = group.themes || [];
  const keywords = group.keywords || [];
  const dirs = (group.files || []).map(f => {
    const dir = f.dir || '';
    return dir ? path.basename(dir) : '';
  }).filter(Boolean);

  // 策略 1：共享实体作为项目名
  if (entities.length > 0) {
    const name = entities.slice(0, 2).join('');
    const confidence = Math.min(0.95, 0.6 + entities.length * 0.15);
    return {
      name,
      confidence: Math.round(confidence * 1000) / 1000,
      reason: `基于共享实体: ${entities.join(', ')}`,
      fallback: false,
    };
  }

  // 策略 2：实体 + 关键词组合
  if (entities.length === 0 && keywords.length > 0) {
    const topKeywords = keywords.slice(0, 2);
    const name = topKeywords.join('');
    const confidence = 0.5;
    return {
      name,
      confidence,
      reason: `基于关键词: ${topKeywords.join(', ')}`,
      fallback: false,
    };
  }

  // 策略 3：主题命名
  if (themes.length === 1 && themes[0] !== '默认') {
    return {
      name: themes[0],
      confidence: 0.4,
      reason: `基于统一主题: "${themes[0]}"`,
      fallback: false,
    };
  }

  // 策略 4：目录上下文
  if (dirs.length > 0) {
    const commonDir = findCommonDir(dirs);
    if (commonDir) {
      return {
        name: commonDir,
        confidence: 0.35,
        reason: `基于共同目录: ${commonDir}`,
        fallback: false,
      };
    }
  }

  // 降级
  return {
    name: '项目资料',
    confidence: 0.2,
    reason: '无法可靠命名，使用默认名称',
    fallback: true,
  };
}

/**
 * 从目录名列表中找到共同目录名。
 */
function findCommonDir(dirs) {
  if (dirs.length === 0) return null;
  if (dirs.length === 1) return dirs[0];

  // 找最长公共前缀
  let prefix = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    while (!dirs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return null;
    }
  }
  return prefix || null;
}

/**
 * 为多个 Group 生成名称，检测冲突。
 *
 * @param {Array} groups - Relationship Group 数组
 * @returns {Array} 带名称的 group 数组
 */
function nameGroups(groups) {
  return groups.map(group => {
    const naming = generateGroupName(group);
    return {
      ...group,
      suggestedName: naming.name,
      nameConfidence: naming.confidence,
      nameReason: naming.reason,
      nameFallback: naming.fallback,
    };
  });
}

/**
 * 检测文件是否属于多个 Group（冲突文件）。
 *
 * @param {Array} groups - Relationship Group 数组
 * @returns {Map} file → [group indices]
 */
function detectConflicts(groups) {
  const fileGroups = new Map();

  for (let g = 0; g < groups.length; g++) {
    for (const file of groups[g].files) {
      if (!fileGroups.has(file)) {
        fileGroups.set(file, []);
      }
      fileGroups.get(file).push(g);
    }
  }

  const conflicts = new Map();
  for (const [file, groupIndices] of fileGroups) {
    if (groupIndices.length > 1) {
      conflicts.set(file, groupIndices);
    }
  }

  return conflicts;
}

module.exports = {
  generateGroupName,
  nameGroups,
  detectConflicts,
  findCommonDir,
};