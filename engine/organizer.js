/**
 * organizer.js — 整理方案生成器 (V0.2)
 *
 * 基于多维分类结果生成文件移动方案。
 * 使用 suggestedTarget 作为目标目录，支持自定义目标根目录。
 */

const path = require('path');

const DANGEROUS_DIRS = new Set([
  '/', '/System', '/Library', '/Applications', '/bin', '/sbin',
  '/usr', '/etc', '/var', '/tmp', '/dev', '/proc', '/sys',
  'C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
]);

/**
 * 生成整理方案。
 *
 * @param {object[]} classifiedFiles  分类后的文件列表（含 fileType/suggestedTarget）
 * @param {object} [options]
 * @param {string} [options.targetRoot]  目标根目录
 * @param {boolean} [options.flatten=true]  平铺到目标根目录
 * @param {object} [options.customTargets]  自定义目标目录 {suggestedTarget: dirName}
 * @returns {{moves: Array, conflicts: Array, summary: object}}
 */
function generatePlan(classifiedFiles, options = {}) {
  const {
    targetRoot,
    flatten = true,
    customTargets = {},
  } = options;

  const moves = [];
  const conflicts = [];
  const seenTargets = new Map();

  // 确定目标根目录
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

  for (const file of classifiedFiles) {
    const targetDirName = customTargets[file.suggestedTarget] || file.suggestedTarget || '其他';

    let targetDir;
    if (flatten) {
      targetDir = path.join(rootDir || file.dir, targetDirName);
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
      });
    } else {
      seenTargets.set(targetPath, { original: file.path });
      moves.push({
        from: file.path,
        to: targetPath,
        category: file.suggestedTarget,
        fileType: file.fileType,
        conflictResolution: null,
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
  for (const move of plan.moves) {
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
  };
}

module.exports = { generatePlan, validatePlan, getPlanStats };