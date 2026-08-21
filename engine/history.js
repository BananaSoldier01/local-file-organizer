/**
 * history.js — 操作历史管理
 *
 * 记录所有文件操作，支持撤销。
 * 持久化到用户数据目录。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 历史文件存储路径
const HISTORY_DIR = path.join(os.homedir(), '.file-organizer');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');
const MAX_HISTORY_ENTRIES = 1000;

let historyCache = null;

/**
 * 确保历史目录存在。
 */
function ensureDir() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

/**
 * 加载历史记录。
 */
function loadHistory() {
  if (historyCache) return historyCache;

  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      historyCache = JSON.parse(data);
    } else {
      historyCache = { sessions: [] };
    }
  } catch (err) {
    console.warn('[history] 加载历史失败，使用空记录:', err.message);
    historyCache = { sessions: [] };
  }

  return historyCache;
}

/**
 * 保存历史记录到磁盘。
 */
function saveHistory() {
  if (!historyCache) return;

  try {
    ensureDir();
    // 限制历史条目数
    let totalEntries = 0;
    for (const session of historyCache.sessions) {
      totalEntries += session.moves.length;
    }

    if (totalEntries > MAX_HISTORY_ENTRIES) {
      // 数组按最新在前排列（unshift），移除末尾即最旧会话
      while (totalEntries > MAX_HISTORY_ENTRIES && historyCache.sessions.length > 0) {
        const removed = historyCache.sessions.pop();
        totalEntries -= removed.moves.length;
      }
    }

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyCache, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[history] 保存历史失败:', err.message);
  }
}

/**
 * 记录一次整理操作。
 *
 * @param {object} session  会话信息
 * @param {string} session.sourceDir  源目录
 * @param {Array} session.moves  移动操作列表
 * @param {object} session.summary  统计信息
 * @returns {string} 会话 ID
 */
function recordSession(session) {
  const history = loadHistory();

  const entry = {
    id: generateId(),
    timestamp: Date.now(),
    sourceDir: session.sourceDir,
    targetRoot: session.targetRoot || null,
    moves: session.moves.map(m => ({
      from: m.from,
      to: m.actualTarget || m.to,
      category: m.category,
      conflictResolution: m.conflictResolution,
    })),
    summary: session.summary || {},
    success: session.success || [],
    failed: session.failed || [],
    skipped: session.skipped || [],
  };

  history.sessions.unshift(entry);
  saveHistory();

  return entry.id;
}

/**
 * 获取最近的操作历史。
 *
 * @param {number} [limit]  返回条目数限制
 * @returns {Array}
 */
function getRecentHistory(limit = 20) {
  const history = loadHistory();
  return history.sessions.slice(0, limit);
}

/**
 * 根据 ID 获取会话。
 */
function getSession(sessionId) {
  const history = loadHistory();
  return history.sessions.find(s => s.id === sessionId) || null;
}

/**
 * 撤销最近一次操作。
 *
 * @param {string} [sessionId]  指定会话 ID，默认撤销最近一次
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
async function undoLastSession(sessionId) {
  const { undoMoves } = require('./executor');

  let session;
  if (sessionId) {
    session = getSession(sessionId);
  } else {
    const recent = getRecentHistory(1);
    session = recent[0] || null;
  }

  if (!session) {
    return { success: 0, failed: 0, errors: [{ error: '没有可撤销的操作' }] };
  }

  const result = await undoMoves(session.moves);

  // 保存完整撤销语义到 History
  const history = loadHistory();
  const idx = history.sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    history.sessions[idx].undoStatus = result.status;           // fully_reverted | partially_reverted | partial | failed
    history.sessions[idx].undoConflictCount = result.conflictCount || 0;
    history.sessions[idx].undoneAt = Date.now();
    // 仅 fully_reverted 等价于"完全撤销"
    history.sessions[idx].undone = result.status === 'fully_reverted';
    saveHistory();
  }

  return result;
}

/**
 * 清空历史记录。
 */
function clearHistory() {
  historyCache = { sessions: [] };
  try {
    ensureDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyCache, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[history] 清空历史失败:', err.message);
  }
}

/**
 * 生成唯一 ID。
 */
function generateId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 获取历史统计。
 */
function getHistoryStats() {
  const history = loadHistory();
  let totalMoves = 0;
  let totalSessions = history.sessions.length;
  let undoneSessions = 0;

  for (const session of history.sessions) {
    totalMoves += session.moves.length;
    if (session.undone) undoneSessions++;
  }

  return {
    totalSessions,
    totalMoves,
    undoneSessions,
    activeSessions: totalSessions - undoneSessions,
  };
}

module.exports = {
  recordSession,
  getRecentHistory,
  getSession,
  undoLastSession,
  clearHistory,
  getHistoryStats,
  HISTORY_FILE,
};