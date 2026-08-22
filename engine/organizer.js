/**
 * organizer.js — 整理方案生成器 (V0.4.3)
 *
 * 基于多维分类结果 + 文件关系生成整理方案。
 * V0.4.3: 支持 Relationship Context 参与 Plan 生成。
 *
 * 原则：
 * - Relationship 提供上下文，不完全覆盖 Classification
 * - Group Suggestion 进入 Plan Review，不直接执行
 * - 冲突文件标记为 shared，不强制归组
 */

const path = require('path');
const groupNamer = require('./group-namer');

const DANGEROUS_DIRS = new Set([
  '/', '/System', '/Library', '/Applications', '/bin', '/sbin',
  '/usr', '/etc', '/var', '/tmp', '/dev', '/proc', '/sys',
  'C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
]);

/**
 * 生成整理方案。
 *
 * V0.4.3: 新增 relationshipGroups 参数，支持基于关系分组的组织建议。
 *
 * @param {object[]} classifiedFiles  分类后的文件列表
 * @param {object} [options]
 * @param {string} [options.targetRoot]  目标根目录
 * @param {boolean} [options.flatten=true]  平铺到目标根目录
 * @param {object} [options.customTargets]  自定义目标目录
 * @param {Array} [options.relationshipGroups]  Relationship Group 数组
 * @returns {{moves: Array, conflicts: Array, summary: object, groupSuggestions: Array}}
 */
function generatePlan(classifiedFiles, options = {}) {
  const {
    targetRoot,
    flatten = false,
    customTargets = {},
    relationshipGroups = null,
  } = options;

  const moves = [];
  const conflicts = [];
  const seenTargets = new Map();

  // ── V0.4.3: 构建 file → group 映射 ──
  const fileToGroup = new Map();     // file → primary group index
  const fileToGroups = new Map();    // file → [all group indices]
  const conflictFiles = new Set();   // 属于多个 group 的文件

  if (relationshipGroups && relationshipGroups.length > 0) {
    for (let g = 0; g < relationshipGroups.length; g++) {
      const group = relationshipGroups[g];
      for (const file of group.files) {
        // V0.4.3: group.files 可能是字符串（file ID）或对象
        const fileId = typeof file === 'string' ? file : (file.path || file.name);
        if (!fileToGroups.has(fileId)) {
          fileToGroups.set(fileId, []);
        }
        fileToGroups.get(fileId).push(g);
      }
    }

    // 检测冲突文件（属于多个 group）
    for (const [fileId, groupIndices] of fileToGroups) {
      if (groupIndices.length > 1) {
        conflictFiles.add(fileId);
      }
      // 主 group = 第一个（分数最高的 group）
      fileToGroup.set(fileId, groupIndices[0]);
    }
  }

  // ── V0.4.3: 生成 Group Suggestion ──
  const groupSuggestions = [];
  if (relationshipGroups && relationshipGroups.length > 0) {
    for (let g = 0; g < relationshipGroups.length; g++) {
      const group = relationshipGroups[g];
      // 过滤冲突文件（group.files 可能是字符串或对象）
      const groupFiles = group.files.filter(f => {
        const fileId = typeof f === 'string' ? f : (f.path || f.name);
        return !conflictFiles.has(fileId);
      });

      if (groupFiles.length < 2) continue; // 至少 2 个文件才建议

      const naming = groupNamer.generateGroupName({
        coreEntities: group.coreEntities,
        themes: group.themes,
        keywords: group.keywords,
        files: groupFiles,
      });

      groupSuggestions.push({
        groupName: naming.name,
        nameConfidence: naming.confidence,
        nameReason: naming.reason,
        files: groupFiles.map(f => {
          const fileObj = classifiedFiles.find(cf => {
            const cfId = cf.path || cf.name;
            const fId = typeof f === 'string' ? f : (f.path || f.name);
            return cfId === fId;
          });
          return {
            path: typeof f === 'string' ? f : (f.path || f.name),
            name: fileObj ? fileObj.name : (typeof f === 'string' ? f : f.name),
            fileType: fileObj ? fileObj.fileType : null,
            suggestedTarget: fileObj ? fileObj.suggestedTarget : null,
          };
        }),
        coreEntities: group.coreEntities,
        themes: group.themes,
        confidence: group.confidence,
        cohesion: group.cohesion,
      });
    }
  }

  // ── 确定目标根目录 ──
  let rootDir = targetRoot;
  if (!rootDir && classifiedFiles.length > 0) {
    const dirs = [...new Set(classifiedFiles.map(f => f.dir))];
    if (dirs.length === 1) {
      rootDir = dirs[0];
    } else {
      rootDir = findCommonParent(dirs);
    }
  }

  // 安全检查
  if (rootDir && DANGEROUS_DIRS.has(rootDir)) {
    rootDir = classifiedFiles[0]?.dir || null;
  }

  // ── V0.4.3: 构建 file → group 目录映射 ──
  // 如果文件属于某个 group，其目标目录优先使用 group 名称
  const groupDirMap = new Map(); // group index → target dir name
  for (const suggestion of groupSuggestions) {
    // 使用 group 名称作为目录名
    const dirName = suggestion.groupName;
    groupDirMap.set(suggestion, dirName);
  }

  // ── 生成 Moves ──
  for (const file of classifiedFiles) {
    const fileId = file.path || file.name;
    const groupIndex = fileToGroup.get(fileId);
    let targetDirName;

    if (groupIndex !== undefined && !conflictFiles.has(fileId)) {
      // 文件属于某个 group → 使用 group 名称作为目录
      const group = relationshipGroups[groupIndex];
      const suggestion = groupSuggestions.find(s =>
        s.files.some(f => {
          const fId = typeof f === 'string' ? f : (f.path || f.name);
          return fId === fileId;
        })
      );
      if (suggestion) {
        targetDirName = suggestion.groupName;
      } else {
        targetDirName = customTargets[file.suggestedTarget] || file.suggestedTarget || '其他';
      }
    } else {
      // 使用分类建议
      targetDirName = customTargets[file.suggestedTarget] || file.suggestedTarget || '其他';
    }

    let targetDir;
    if (flatten) {
      targetDir = path.join(rootDir || file.dir, targetDirName);
    } else if (targetRoot) {
      targetDir = path.join(targetRoot, targetDirName);
    } else {
      targetDir = path.join(file.dir, targetDirName);
    }

    let targetPath = path.join(targetDir, file.name);

    // 跳过：文件已在正确位置
    if (path.resolve(targetPath) === path.resolve(file.path)) continue;

    // 跳过：文件已在同名分类目录中
    const currentDirName = path.basename(file.dir);
    if (currentDirName === targetDirName) continue;

    // 冲突处理
    if (seenTargets.has(targetPath)) {
      const ext = path.extname(file.name);
      const base = path.basename(file.name, ext);
      let counter = 2;
      let newPath;
      do {
        newPath = path.join(targetDir, `${base}_${counter}${ext}`);
        counter++;
      } while (seenTargets.has(newPath));

      seenTargets.set(newPath, { original: file.path, counter });
      moves.push({
        from: file.path,
        to: newPath,
        category: file.suggestedTarget,
        fileType: file.fileType,
        conflictResolution: 'renamed',
        originalTarget: targetPath,
        relationshipGroup: groupIndex !== undefined ? relationshipGroups[groupIndex].coreEntities : null,
      });
    } else {
      seenTargets.set(targetPath, { original: file.path });
      moves.push({
        from: file.path,
        to: targetPath,
        category: file.suggestedTarget,
        fileType: file.fileType,
        conflictResolution: null,
        relationshipGroup: groupIndex !== undefined ? relationshipGroups[groupIndex].coreEntities : null,
      });
    }
  }

  // 按分类统计
  const summary = {};
  for (const move of moves) {
    if (!summary[move.category]) {
      summary[move.category] = { count: 0, label: move.category };
    }
    summary[move.category].count++;
  }

  return {
    moves,
    conflicts: moves.filter(m => m.conflictResolution === 'renamed'),
    summary,
    targetRoot: rootDir || null,
    groupSuggestions,
    conflictFiles: [...conflictFiles],
  };
}

function findCommonParent(dirs) {
  if (dirs.length === 0) return null;
  if (dirs.length === 1) return dirs[0];

  const splitDirs = dirs.map(d => d.split(path.sep).filter(Boolean));
  let common = [];
  const minLen = Math.min(...splitDirs.map(s => s.length));

  for (let i = 0; i < minLen; i++) {
    const segment = splitDirs[0][i];
    if (splitDirs.every(s => s[i] === segment)) {
      common.push(segment);
    } else break;
  }

  if (common.length === 0) return null;
  const result = common.join(path.sep);
  return path.isAbsolute(dirs[0]) ? path.sep + result : result;
}

function validatePlan(plan) {
  const issues = [];
  const fs = require('fs');
  for (const move of plan.moves) {
    let sourceIsDir = false;
    try {
      sourceIsDir = fs.statSync(move.from).isDirectory();
    } catch (_) { /* 文件不存在，跳过 */ }

    if (!sourceIsDir) continue;

    const sourceDir = path.dirname(move.from);
    if (move.to.startsWith(sourceDir + path.sep) || move.to === sourceDir) {
      issues.push({
        type: 'circular',
        message: `目标路径 "${move.to}" 是源路径 "${move.from}" 的子目录，无法移动`,
        move,
      });
    }
  }
  return { valid: issues.length === 0, issues };
}

function getPlanStats(plan) {
  return {
    totalMoves: plan.moves.length,
    categories: Object.keys(plan.summary).length,
    renamed: plan.conflicts.length,
    totalSize: plan.moves.reduce((sum, m) => sum + (m.size || 0), 0),
    groupSuggestions: plan.groupSuggestions ? plan.groupSuggestions.length : 0,
    conflictFiles: plan.conflictFiles ? plan.conflictFiles.length : 0,
  };
}

module.exports = { generatePlan, validatePlan, getPlanStats };