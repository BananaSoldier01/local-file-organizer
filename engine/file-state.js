/**
 * file-state.js — File State Store (V0.5.0)
 *
 * 持久化已处理文件的状态，使系统具备长期记忆能力。
 *
 * 与 Memory 的区别：
 * - Memory：用户偏好（"用户喜欢把 X 放到 Y"）
 * - File State：文件历史状态（"这个文件上次在哪儿，分类是什么"）
 *
 * 存储：~/.local-file-organizer/file-state.json
 * 本地存储，可恢复，不依赖当前 Session。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const fileIdentity = require('./file-identity');

// ── 存储路径 ──────────────────────────────────────────────
const STATE_DIR = path.join(os.homedir(), '.local-file-organizer');
const STATE_FILE = path.join(STATE_DIR, 'file-state.json');
const MAX_STATE_ENTRIES = 10000;

let stateCache = null;

/**
 * 确保存储目录存在。
 */
function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

/**
 * 加载 File State（带缓存）。
 */
function loadState() {
  if (stateCache) return stateCache;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      stateCache = JSON.parse(raw);
    } else {
      stateCache = { version: 1, entries: {} };
    }
  } catch (err) {
    console.error('[file-state] 加载失败，使用空状态:', err.message);
    stateCache = { version: 1, entries: {} };
  }
  return stateCache;
}

/**
 * 保存 File State 到磁盘。
 */
function saveState(data) {
  ensureDir();
  data.version = 1;
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  stateCache = data;
}

/**
 * 计算文件指纹（用于变化检测）。
 * V0.5.1: 使用 file-identity 多级指纹。
 *
 * @param {object} file - 文件信息
 * @param {string} [filePath] - 可选的完整文件路径（用于 Level 2/3）
 * @returns {string} 指纹字符串
 */
function computeFingerprint(file, filePath) {
  // 默认使用 Level 1 快速指纹
  return fileIdentity.fastFingerprint(file);
}

/**
 * 记录或更新文件状态。
 *
 * @param {object} file - 分类后的文件
 * @param {object} classification - 分类结果
 * @param {object} organization - 组织结果（可选）
 * @returns {object} 更新后的状态条目
 */
function upsertFileState(file, classification, organization = null) {
  const state = loadState();
  const key = file.path;
  const fingerprint = computeFingerprint(file);

  const entry = {
    path: file.path,
    size: file.size,
    modified: file.modified,
    fingerprint,
    lastProcessedAt: new Date().toISOString(),
    classification: {
      theme: (classification && classification.contentTheme) || file.contentTheme || '默认',
      confidence: (classification && classification.confidence) || file.confidence || 0,
    },
    organization: organization || {
      currentPath: file.dir || '',
      targetPath: null,
    },
  };

  state.entries[key] = entry;

  // 限制条目数
  const keys = Object.keys(state.entries);
  if (keys.length > MAX_STATE_ENTRIES) {
    // 删除最旧的条目
    keys.sort((a, b) => {
      const ta = state.entries[a].lastProcessedAt || '';
      const tb = state.entries[b].lastProcessedAt || '';
      return ta.localeCompare(tb);
    });
    for (let i = 0; i < keys.length - MAX_STATE_ENTRIES; i++) {
      delete state.entries[keys[i]];
    }
  }

  saveState(state);
  return entry;
}

/**
 * 更新文件的组织路径。
 *
 * @param {string} filePath
 * @param {string} targetPath
 */
function updateOrganization(filePath, targetPath) {
  const state = loadState();
  const entry = state.entries[filePath];
  if (entry) {
    entry.organization.targetPath = targetPath;
    entry.organization.currentPath = path.dirname(filePath);
    entry.lastProcessedAt = new Date().toISOString();
    saveState(state);
  }
}

/**
 * 获取单个文件的状态。
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function getFileState(filePath) {
  const state = loadState();
  return state.entries[filePath] || null;
}

/**
 * 比较当前文件列表与 File State，检测变化。
 *
 * @param {object[]} currentFiles - 当前扫描的文件列表
 * @returns {object} 变化检测结果
 */
function detectChanges(currentFiles) {
  const state = loadState();
  const stateEntries = state.entries;
  const currentPaths = new Set();

  const result = {
    added: [],
    modified: [],
    unchanged: [],
    deleted: [],
    moved: [],
    stats: {
      totalCurrent: currentFiles.length,
      totalState: Object.keys(stateEntries).length,
      addedCount: 0,
      modifiedCount: 0,
      unchangedCount: 0,
      deletedCount: 0,
      movedCount: 0,
    },
  };

  // 检查当前文件
  for (const file of currentFiles) {
    const filePath = file.path;
    currentPaths.add(filePath);
    const existing = stateEntries[filePath];

    if (!existing) {
      // 新增文件
      result.added.push({
        file,
        reason: 'new',
      });
      result.stats.addedCount++;
    } else if (existing.fingerprint !== computeFingerprint(file)) {
      // 文件变化（大小或修改时间改变）
      result.modified.push({
        file,
        previousState: existing,
        reason: 'modified',
      });
      result.stats.modifiedCount++;
    } else {
      // 未变化
      result.unchanged.push({
        file,
        existing,
      });
      result.stats.unchangedCount++;
    }
  }

  // 检查 State 中是否有文件不再存在（删除）
  for (const [filePath, entry] of Object.entries(stateEntries)) {
    if (!currentPaths.has(filePath)) {
      result.deleted.push({
        path: filePath,
        previousState: entry,
        reason: 'deleted',
      });
      result.stats.deletedCount++;
    }
  }

  return result;
}

/**
 * 检测文件移动（通过指纹匹配）。
 *
 * @param {object} changeResult - detectChanges 的结果
 * @returns {object} 更新后的变化检测结果
 */
function detectMoves(changeResult) {
  // 简化实现：通过文件名匹配检测移动
  // 生产环境可以加入更复杂的匹配逻辑
  const deletedPaths = new Set(changeResult.deleted.map(d => d.path));
  const addedFiles = changeResult.added;

  for (const added of addedFiles) {
    const fileName = path.basename(added.file.path);
    for (const deleted of changeResult.deleted) {
      const deletedName = path.basename(deleted.path);
      if (fileName === deletedName && deleted.path !== added.file.path) {
        // 可能是移动
        changeResult.moved.push({
          from: deleted.path,
          to: added.file.path,
          previousState: deleted.previousState,
          file: added.file,
          reason: 'moved',
        });
        // 从 added 和 deleted 中移除
        changeResult.added = changeResult.added.filter(a => a !== added);
        changeResult.deleted = changeResult.deleted.filter(d => d !== deleted);
        changeResult.stats.addedCount--;
        changeResult.stats.deletedCount++;
        changeResult.stats.movedCount++;
        break;
      }
    }
  }

  return changeResult;
}

/**
 * 清空 File State。
 */
function clearState() {
  saveState({ version: 1, entries: {} });
}

/**
 * 删除指定文件的状态。
 *
 * @param {string} filePath
 */
function deleteFileState(filePath) {
  const state = loadState();
  delete state.entries[filePath];
  saveState(state);
}

/**
 * 获取 File State 统计信息。
 *
 * @returns {object}
 */
function getStateStats() {
  const state = loadState();
  const entries = state.entries;
  const keys = Object.keys(entries);

  let classifiedCount = 0;
  let organizedCount = 0;

  for (const key of keys) {
    const e = entries[key];
    if (e.classification && e.classification.theme) classifiedCount++;
    if (e.organization && e.organization.targetPath) organizedCount++;
  }

  return {
    total: keys.length,
    classified: classifiedCount,
    organized: organizedCount,
    version: state.version,
  };
}

/**
 * 导出 File State（用于备份/查看）。
 */
function exportState() {
  return loadState();
}

/**
 * 获取所有已知的组织目标路径（用于 Memory 优先级链）。
 *
 * @returns {Map<path, targetPath>}
 */
function getOrganizationTargets() {
  const state = loadState();
  const targets = new Map();
  for (const [filePath, entry] of Object.entries(state.entries)) {
    if (entry.organization && entry.organization.targetPath) {
      const dirName = path.basename(entry.organization.targetPath);
      targets.set(filePath, dirName);
    }
  }
  return targets;
}

module.exports = {
  computeFingerprint,
  upsertFileState,
  updateOrganization,
  getFileState,
  detectChanges,
  detectMoves,
  clearState,
  deleteFileState,
  getStateStats,
  exportState,
  getOrganizationTargets,
  STATE_FILE,
};