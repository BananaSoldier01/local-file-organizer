/**
 * executor.js — 安全文件操作执行器
 *
 * 执行文件移动操作，包含安全检查、冲突处理、进度报告。
 * 所有操作记录到历史中以便撤销。
 */

const fs = require('fs');
const path = require('path');

/**
 * 执行整理方案。
 *
 * @param {object} plan  整理方案 (来自 organizer.generatePlan)
 * @param {object} [options]
 * @param {function} [options.onProgress]  进度回调 (current, total, currentFile)
 * @param {function} [options.onError]  错误回调 (error, move)
 * @param {object} [options.conflictStrategy]  冲突策略 {overwrite: 'skip'|'rename'|'overwrite'}
 * @returns {Promise<{success: Array, failed: Array, skipped: Array}>}
 */
async function executePlan(plan, options = {}) {
  const {
    onProgress,
    onError,
    conflictStrategy = { overwrite: 'skip' },
  } = options;

  const success = [];
  const failed = [];
  const skipped = [];
  const total = plan.moves.length;

  for (let i = 0; i < plan.moves.length; i++) {
    const move = plan.moves[i];

    if (onProgress) {
      onProgress(i + 1, total, path.basename(move.from));
    }

    try {
      // 安全检查
      const safety = checkMoveSafety(move);
      if (!safety.safe) {
        failed.push({ move, error: safety.reason });
        if (onError) onError({ move, error: safety.reason }, move);
        continue;
      }

      // 确保目标目录存在
      const targetDir = path.dirname(move.to);
      await fs.promises.mkdir(targetDir, { recursive: true });

      // 检查目标文件是否已存在
      let finalTarget = move.to;
      if (fs.existsSync(finalTarget)) {
        const strategy = conflictStrategy.overwrite || 'skip';
        if (strategy === 'skip') {
          skipped.push({ move, reason: '目标文件已存在，已跳过' });
          continue;
        } else if (strategy === 'rename') {
          const ext = path.extname(move.to);
          const base = path.basename(move.to, ext);
          let counter = 2;
          do {
            finalTarget = path.join(targetDir, `${base}_${counter}${ext}`);
            counter++;
          } while (fs.existsSync(finalTarget));
        }
        // overwrite: 直接覆盖
      }

      // 执行移动（跨驱动器时使用 copy+delete）
      try {
        await fs.promises.rename(move.from, finalTarget);
      } catch (renameErr) {
        if (renameErr.code === 'EXDEV' || renameErr.code === 'EEXDEV') {
          // 跨驱动器：复制后删除
          await fs.promises.copyFile(move.from, finalTarget);
          await fs.promises.unlink(move.from);
        } else {
          throw renameErr;
        }
      }

      success.push({
        ...move,
        actualTarget: finalTarget,
      });
    } catch (err) {
      failed.push({ move, error: err.message });
      if (onError) onError({ move, error: err.message }, move);
    }
  }

  return { success, failed, skipped };
}

/**
 * 安全检查：验证移动操作是否安全。
 *
 * @param {object} move  移动操作 {from, to, category}
 * @returns {{safe: boolean, reason?: string}}
 */
function checkMoveSafety(move) {
  const { from, to } = move;

  // 检查源文件是否存在
  if (!fs.existsSync(from)) {
    return { safe: false, reason: '源文件不存在' };
  }

  // 检查源文件是否是目录
  try {
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      return { safe: false, reason: '源路径是目录，不是文件' };
    }
  } catch (err) {
    return { safe: false, reason: `无法访问源文件: ${err.message}` };
  }

  // 检查目标路径是否在源路径的子目录中
  const resolvedFrom = path.resolve(from);
  const resolvedTo = path.resolve(to);

  if (resolvedTo === resolvedFrom) {
    return { safe: false, reason: '源文件与目标路径相同' };
  }

  if (resolvedTo.startsWith(resolvedFrom + path.sep)) {
    return { safe: false, reason: '目标路径是源文件的子目录，无法移动' };
  }

  // 检查目标路径是否包含特殊字符
  if (/[<>:"|?*]/.test(path.basename(to))) {
    return { safe: false, reason: '目标文件名包含非法字符' };
  }

  return { safe: true };
}

/**
 * 撤销单个移动操作。
 *
 * @param {object} move  移动操作 {from, to, actualTarget}
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function undoMove(move) {
  const source = move.actualTarget || move.to;
  const target = move.from;

  try {
    if (!fs.existsSync(source)) {
      return { success: false, error: '已移动的文件不存在，无法撤销' };
    }

    // 确保目标目录存在
    const targetDir = path.dirname(target);
    await fs.promises.mkdir(targetDir, { recursive: true });

    // 处理目标已存在的情况
    if (fs.existsSync(target)) {
      const ext = path.extname(target);
      const base = path.basename(target, ext);
      let counter = 2;
      let newTarget;
      do {
        newTarget = path.join(targetDir, `${base}_撤销_${counter}${ext}`);
        counter++;
      } while (fs.existsSync(newTarget));

      await fs.promises.rename(source, newTarget);
      return { success: true, renamedTo: newTarget };
    }

    await fs.promises.rename(source, target);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 批量撤销操作。
 *
 * @param {Array} moves  移动操作列表（按执行顺序的逆序）
 * @param {object} [options]
 * @param {function} [options.onProgress]
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
async function undoMoves(moves, options = {}) {
  const { onProgress } = options;
  let successCount = 0;
  let failedCount = 0;
  const errors = [];

  // 逆序撤销
  for (let i = moves.length - 1; i >= 0; i--) {
    const move = moves[i];
    if (onProgress) {
      onProgress(moves.length - i, moves.length, path.basename(move.actualTarget || move.to));
    }

    const result = await undoMove(move);
    if (result.success) {
      successCount++;
    } else {
      failedCount++;
      errors.push({ move, error: result.error });
    }
  }

  // 清理可能残留的空目录
  cleanupEmptyDirs(moves);

  return { success: successCount, failed: failedCount, errors };
}

/**
 * 清理因移动操作产生的空目录。
 * 仅删除在移动过程中创建的分类目录（目标目录）。
 */
function cleanupEmptyDirs(moves) {
  // 收集所有目标目录
  const targetDirs = new Set();
  for (const move of moves) {
    const targetDir = path.dirname(move.actualTarget || move.to);
    targetDirs.add(targetDir);
  }

  // 按路径深度降序排序（先删除深层目录）
  const sortedDirs = [...targetDirs].sort((a, b) => b.length - a.length);

  for (const dir of sortedDirs) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch (_) {
      // 忽略清理失败（目录可能非空或无权限）
    }
  }
}

module.exports = {
  executePlan,
  checkMoveSafety,
  undoMove,
  undoMoves,
};