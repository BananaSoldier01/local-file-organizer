/**
 * relationship-state.js — Persistent Relationship State (V0.5.1)
 *
 * 持久化 Relationship Group 状态，支持增量更新。
 *
 * 与 Relationship Engine 的区别：
 * - Relationship Engine：临时计算，每次 Scan 重新分析
 * - Relationship State：持久化存储，维护 Group 生命周期
 *
 * 存储：~/.local-file-organizer/relationship-state.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 存储路径 ──────────────────────────────────────────────
const STATE_DIR = path.join(os.homedir(), '.local-file-organizer');
const REL_STATE_FILE = path.join(STATE_DIR, 'relationship-state.json');

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
 * 加载 Relationship State（带缓存）。
 */
function loadState() {
  if (stateCache) return stateCache;
  try {
    if (fs.existsSync(REL_STATE_FILE)) {
      const raw = fs.readFileSync(REL_STATE_FILE, 'utf-8');
      stateCache = JSON.parse(raw);
    } else {
      stateCache = { version: 1, groups: [] };
    }
  } catch (err) {
    console.error('[relationship-state] 加载失败，使用空状态:', err.message);
    stateCache = { version: 1, groups: [] };
  }
  return stateCache;
}

/**
 * 保存 Relationship State 到磁盘。
 */
function saveState(data) {
  ensureDir();
  data.version = 1;
  fs.writeFileSync(REL_STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  stateCache = data;
}

/**
 * 创建新的 Group。
 *
 * @param {object} groupData - Group 数据
 * @returns {object} 创建的 Group
 */
function createGroup(groupData) {
  const state = loadState();
  const group = {
    groupId: 'rg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    files: groupData.files || [],
    name: groupData.name || '未命名',
    entities: groupData.entities || [],
    confidence: groupData.confidence || 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.groups.push(group);
  saveState(state);
  return group;
}

/**
 * 更新 Group（添加/移除文件）。
 *
 * @param {string} groupId
 * @param {object} updates - { add?: string[], remove?: string[], name?: string, entities?: string[] }
 * @returns {object|null} 更新后的 Group
 */
function updateGroup(groupId, updates) {
  const state = loadState();
  const group = state.groups.find(g => g.groupId === groupId);
  if (!group) return null;

  if (updates.add) {
    for (const f of updates.add) {
      if (!group.files.includes(f)) group.files.push(f);
    }
  }
  if (updates.remove) {
    group.files = group.files.filter(f => !updates.remove.includes(f));
  }
  if (updates.name) group.name = updates.name;
  if (updates.entities) group.entities = updates.entities;
  if (updates.confidence !== undefined) group.confidence = updates.confidence;

  group.updatedAt = new Date().toISOString();
  saveState(state);
  return group;
}

/**
 * 删除 Group。
 *
 * @param {string} groupId
 */
function deleteGroup(groupId) {
  const state = loadState();
  state.groups = state.groups.filter(g => g.groupId !== groupId);
  saveState(state);
}

/**
 * 获取单个 Group。
 *
 * @param {string} groupId
 * @returns {object|null}
 */
function getGroup(groupId) {
  const state = loadState();
  return state.groups.find(g => g.groupId === groupId) || null;
}

/**
 * 获取包含指定文件的 Group。
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function getGroupContaining(filePath) {
  const state = loadState();
  return state.groups.find(g => g.files.includes(filePath)) || null;
}

/**
 * 增量更新：新文件尝试加入已有 Group。
 *
 * @param {object[]} newFiles - 新文件列表
 * @param {object[]} existingGroups - 已有 Relationship Group（来自 Relationship Engine）
 * @returns {object} 更新结果
 */
function incrementalUpdate(newFiles, existingGroups = []) {
  const state = loadState();
  const result = { added: [], updated: [], created: [] };

  for (const newFile of newFiles) {
    const filePath = newFile.path || newFile.name;
    let matched = false;

    // 尝试匹配已有 Group
    for (const group of state.groups) {
      // 检查文件是否与 Group 中的文件有共同实体
      const newEntities = (newFile.contentSummary && newFile.contentSummary.entities) || [];
      const groupEntities = (group.entities || []).map(e => e.toLowerCase());
      const sharedEnt = newEntities.filter(e => groupEntities.includes(e.toLowerCase()));

      if (sharedEnt.length > 0) {
        // 加入已有 Group
        if (!group.files.includes(filePath)) {
          group.files.push(filePath);
          group.updatedAt = new Date().toISOString();
          result.updated.push({ groupId: group.groupId, file: filePath });
        }
        matched = true;
        break;
      }
    }

    // 尝试匹配 Relationship Engine 的 Group
    if (!matched) {
      for (const engGroup of existingGroups) {
        const engEntities = engGroup.coreEntities ? [...engGroup.coreEntities] : [];
        const newEntities = (newFile.contentSummary && newFile.contentSummary.entities) || [];
        const sharedEnt = newEntities.filter(e => engEntities.map(e => e.toLowerCase()).includes(e.toLowerCase()));

        if (sharedEnt.length > 0) {
          // 创建新的持久 Group
          const newGroup = createGroup({
            files: [filePath, ...(engGroup.files || [])],
            name: engGroup.groupName || '未命名',
            entities: engEntities,
            confidence: engGroup.cohesion || 0,
          });
          result.created.push({ groupId: newGroup.groupId, file: filePath });
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      result.added.push({ file: filePath, action: 'no_group' });
    }
  }

  if (result.updated.length > 0 || result.created.length > 0) {
    saveState(state);
  }

  return result;
}

/**
 * 清空 Relationship State。
 */
function clearState() {
  saveState({ version: 1, groups: [] });
}

/**
 * 获取 Relationship State 统计。
 *
 * @returns {object}
 */
function getStateStats() {
  const state = loadState();
  let totalFiles = 0;
  for (const g of state.groups) totalFiles += g.files.length;
  return {
    groups: state.groups.length,
    totalFiles,
    version: state.version,
  };
}

/**
 * 导出 Relationship State。
 */
function exportState() {
  return loadState();
}

/**
 * 获取所有 Group（用于 Plan 生成）。
 *
 * @returns {object[]}
 */
function getAllGroups() {
  const state = loadState();
  return state.groups.map(g => ({
    groupId: g.groupId,
    files: g.files,
    name: g.name,
    coreEntities: new Set(g.entities),
    confidence: g.confidence,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }));
}

module.exports = {
  createGroup,
  updateGroup,
  deleteGroup,
  getGroup,
  getGroupContaining,
  incrementalUpdate,
  clearState,
  getStateStats,
  exportState,
  getAllGroups,
  REL_STATE_FILE,
};