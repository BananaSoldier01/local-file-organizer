/**
 * scanner.js — 目录扫描引擎
 *
 * 递归扫描指定目录，收集文件元数据。
 * 支持跳过系统目录、权限错误处理、符号链接检测。
 */

const fs = require('fs');
const path = require('path');

// 默认跳过的目录（系统/大型目录）
const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'System Volume Information', '$RECYCLE.BIN',
  'Windows', 'Program Files', 'Program Files (x86)',
  'Applications', 'Library', 'Containers',
  '.Trash', '.Document-Revisions-V100', '.fseventsd', '.Spotlight-V100',
  '__pycache__', '.DS_Store',
]);

// 默认跳过的隐藏文件/目录（以 . 开头，排除用户显式指定的）
function isHidden(name) {
  return name.startsWith('.') && name !== '.' && name !== '..';
}

/**
 * 扫描目录，返回文件列表。
 *
 * @param {string} rootPath  起始目录
 * @param {object} [options]
 * @param {string[]} [options.skipDirs]  额外跳过的目录名
 * @param {boolean} [options.skipHidden=true]  是否跳过隐藏文件/目录
 * @param {number} [options.maxDepth=Infinity]  最大递归深度
 * @param {number} [options.maxFiles]  最大文件数限制
 * @returns {Promise<{files: FileEntry[], errors: ScanError[], stats: {totalDirs, totalFiles, skippedDirs}}>}
 */
async function scanDirectory(rootPath, options = {}) {
  const {
    skipDirs = [],
    skipHidden = true,
    maxDepth = Infinity,
    maxFiles = Infinity,
    onProgress,
  } = options;

  const allSkipDirs = new Set([...DEFAULT_SKIP_DIRS, ...skipDirs]);

  const files = [];
  const errors = [];
  let totalDirs = 0;
  let skippedDirs = 0;
  let dirsToScan = 0;
  let dirsScanned = 0;

  // 用于去重（符号链接可能导致重复）
  const seenRealPaths = new Set();

  // 首次遍历统计目录数（用于真实进度）
  async function countDirs(dirPath, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !allSkipDirs.has(entry.name) && !(skipHidden && isHidden(entry.name))) {
          dirsToScan++;
          await countDirs(path.join(dirPath, entry.name), depth + 1);
        }
      }
    } catch (_) { /* 忽略计数错误 */ }
  }

  async function walk(dirPath, depth) {
    if (depth > maxDepth) return;
    if (files.length >= maxFiles) return;

    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      errors.push({
        path: dirPath,
        type: 'read_error',
        message: err.message,
        code: err.code,
      });
      return;
    }

    totalDirs++;
    dirsScanned++;

    // 报告真实进度
    if (onProgress && dirsToScan > 0) {
      const pct = Math.min(95, Math.round((dirsScanned / dirsToScan) * 95));
      onProgress({ percent: pct, scanned: dirsScanned, total: dirsToScan, files: files.length });
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;

      const fullPath = path.join(dirPath, entry.name);

      // 跳过隐藏项
      if (skipHidden && isHidden(entry.name)) continue;

      try {
        if (entry.isDirectory()) {
          if (allSkipDirs.has(entry.name)) {
            skippedDirs++;
            continue;
          }
          // 检测符号链接目录
          try {
            const realPath = await fs.promises.realpath(fullPath);
            if (seenRealPaths.has(realPath)) {
              skippedDirs++;
              continue;
            }
            seenRealPaths.add(realPath);
          } catch (_) {
            // realpath 失败，继续尝试
          }
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(fullPath);
          const ext = path.extname(entry.name).toLowerCase().slice(1);

          files.push({
            name: entry.name,
            path: fullPath,
            dir: dirPath,
            size: stat.size,
            modified: stat.mtimeMs,
            created: stat.birthtimeMs,
            extension: ext,
            isSymlink: entry.isSymbolicLink(),
          });
        }
        // 忽略 socket、fifo 等特殊文件
      } catch (err) {
        errors.push({
          path: fullPath,
          type: 'stat_error',
          message: err.message,
          code: err.code,
        });
      }
    }
  }

  try {
    const realRoot = await fs.promises.realpath(rootPath);
    seenRealPaths.add(realRoot);
  } catch (_) {
    // 继续
  }

  // 预遍历统计目录数，用于真实进度
  await countDirs(rootPath, 0);

  await walk(rootPath, 0);

  return {
    files,
    errors,
    stats: {
      totalDirs,
      totalFiles: files.length,
      skippedDirs,
    },
  };
}

/**
 * 格式化文件大小为可读字符串。
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 格式化日期为可读字符串。
 */
function formatDate(timestamp) {
  if (!timestamp) return '未知';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const day = 86400000;

  if (diff < day) return '今天';
  if (diff < day * 2) return '昨天';
  if (diff < day * 7) return `${Math.floor(diff / day)} 天前`;
  if (diff < day * 30) return `${Math.floor(diff / (day * 7))} 周前`;
  if (diff < day * 365) return `${Math.floor(diff / day)} 天前`;

  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

module.exports = {
  scanDirectory,
  formatSize,
  formatDate,
};