/**
 * organizer.js — 整理方案生成器
 *
 * 根据分类结果生成文件移动方案。
 * 处理重名冲突、目标目录创建策略。
 */

const path = require('path');
const { getCategoryTargetDir } = require('./classifier');

/**
 * 生成整理方案。
 *
 * @param {object[]} classifiedFiles  分类后的文件列表
 * @param {object} [options]
 * @param {string} [options.targetRoot]  目标根目录（默认使用源文件所在目录）
 * @param {boolean} [options.flatten=true]  是否将所有文件平铺到目标根目录的分类子目录中
 * @param {boolean} [options.preserveSubdir=false]  是否保留子目录结构
 * @param {object} [options.customNames]  自定义分类目标目录名 {categoryKey: dirName}
 * @returns {{moves: Array, conflicts: Array, summary: object}}
 */
function generatePlan(classifiedFiles, options = {}) {
  const {
    targetRoot,
    flatten = true,
    preserveSubdir = false,
    customNames = {},
  } = options;

  const moves = [];
  const conflicts = [];
  const seenTargets = new Map();

  // 确定目标根目录：优先使用指定的 targetRoot，否则使用所有文件的共同父目录
  let rootDir = targetRoot;
  if (!rootDir && classifiedFiles.length > 0) {
    // 找到所有文件所在目录的共同父目录
    const dirs = [...new Set(classifiedFiles.map(f => f.dir))];
    if (dirs.length === 1) {
      rootDir = dirs[0];
    } else {
      // 找到共同的父目录
      rootDir = findCommonParent(dirs);
    }
  }

  // 安全检查：防止在根目录或系统目录下创建分类文件夹
  const DANGEROUS_DIRS = ['/', '/System', '/Library', '/Applications', '/bin', '/sbin',
    '/usr', '/etc', '/var', '/tmp', '/dev', '/proc', '/sys'];
  if (rootDir && DANGEROUS_DIRS.includes(rootDir)) {
    // 回退到第一个文件的所在目录
    rootDir = classifiedFiles[0]?.dir || null;
  }

  for (const file of classifiedFiles) {
    const category = file.category || 'other';
    const targetDirName = customNames[category] || getCategoryTargetDir(category);

    let targetDir;
    if (flatten) {
      // 平铺模式：所有文件放到目标根目录下的分类子目录中
      targetDir = path.join(rootDir || file.dir, targetDirName);
    } else if (preserveSubdir) {
      // 保留子目录结构：在源文件所在目录下创建分类子目录
      targetDir = path.join(file.dir, targetDirName);
    } else {
      // 默认：在源文件所在目录下创建分类子目录
      targetDir = path.join(file.dir, targetDirName);
    }

    let targetPath = path.join(targetDir, file.name);

    // 检查目标是否与源相同（文件已经在正确位置）
    if (path.resolve(targetPath) === path.resolve(file.path)) {
      continue;
    }

    // 检查文件是否已经在正确的分类目录中（目录名匹配即跳过）
    const currentDirName = path.basename(file.dir);
    if (currentDirName === targetDirName) {
      continue;
    }

    // 处理重名冲突
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
        category,
        conflictResolution: 'renamed',
        originalTarget: targetPath,
      });
    } else {
      seenTargets.set(targetPath, { original: file.path });
      moves.push({
        from: file.path,
        to: targetPath,
        category,
        conflictResolution: null,
      });
    }
  }

  // 按分类分组统计
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

/**
 * 找到多个目录的共同父目录。
 */
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
    } else {
      break;
    }
  }

  if (common.length === 0) return null;

  // 重建路径
  const result = common.join(path.sep);
  return path.isAbsolute(dirs[0]) ? path.sep + result : result;
}

/**
 * 验证方案的可行性。
 */
function validatePlan(plan) {
  const issues = [];

  for (const move of plan.moves) {
    const sourceDir = path.dirname(move.from);

    // 检查目标路径是否在源路径的子目录中（防止移动到自己的子目录）
    if (move.to.startsWith(sourceDir + path.sep) || move.to === sourceDir) {
      issues.push({
        type: 'circular',
        message: '目标路径 "' + move.to + '" 是源路径 "' + move.from + '" 的子目录，无法移动',
        move,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * 计算整理方案的统计信息。
 */
function getPlanStats(plan) {
  const totalMoves = plan.moves.length;
  const categories = Object.keys(plan.summary).length;
  const renamed = plan.conflicts.length;
  const totalSize = plan.moves.reduce((sum, m) => sum + (m.size || 0), 0);

  return {
    totalMoves,
    categories,
    renamed,
    totalSize,
  };
}

module.exports = {
  generatePlan,
  validatePlan,
  getPlanStats,
};