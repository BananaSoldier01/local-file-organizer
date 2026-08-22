/**
 * agent-history.js — Agent Activity History (V0.5.1)
 *
 * 记录 Agent 生命周期事件。
 *
 * 与 Memory / File State 的区别：
 * - Memory：用户偏好
 * - File State：当前文件世界状态
 * - Agent History：Agent 做过什么
 *
 * 存储：~/.local-file-organizer/agent-history.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 存储路径 ──────────────────────────────────────────────
const STATE_DIR = path.join(os.homedir(), '.local-file-organizer');
const HISTORY_FILE = path.join(STATE_DIR, 'agent-history.json');
const MAX_HISTORY_ENTRIES = 1000;

let historyCache = null;

/**
 * 确保存储目录存在。
 */
function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

/**
 * 加载 Agent History（带缓存）。
 */
function loadHistory() {
  if (historyCache) return historyCache;
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      historyCache = JSON.parse(raw);
    } else {
      historyCache = { version: 1, events: [] };
    }
  } catch (err) {
    console.error('[agent-history] 加载失败，使用空历史:', err.message);
    historyCache = { version: 1, events: [] };
  }
  return historyCache;
}

/**
 * 保存 Agent History 到磁盘。
 */
function saveHistory(data) {
  ensureDir();
  data.version = 1;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  historyCache = data;
}

/**
 * 记录一个 Agent 事件。
 *
 * @param {string} event - 事件类型
 * @param {object} [result] - 事件结果
 * @param {object} [context] - 上下文信息
 * @returns {object} 记录的事件
 */
function recordEvent(event, result = {}, context = {}) {
  const history = loadHistory();
  const entry = {
    id: 'ah_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    event,
    result,
    context,
  };
  history.events.push(entry);

  // 限制条目数
  if (history.events.length > MAX_HISTORY_ENTRIES) {
    history.events = history.events.slice(-MAX_HISTORY_ENTRIES);
  }

  saveHistory(history);
  return entry;
}

/**
 * 记录增量扫描事件。
 *
 * @param {object} result - 扫描结果
 */
function recordIncrementalScan(result) {
  return recordEvent('incremental_scan', {
    newFiles: result.addedCount || 0,
    modifiedFiles: result.modifiedCount || 0,
    unchangedFiles: result.unchangedCount || 0,
    deletedFiles: result.deletedCount || 0,
    movedFiles: result.movedCount || 0,
  });
}

/**
 * 记录 Plan 生成事件。
 *
 * @param {object} result - Plan 结果
 */
function recordPlanGenerated(result) {
  return recordEvent('plan_generated', {
    moves: result.moves ? result.moves.length : 0,
    incremental: result.incremental || false,
    memoryHits: result.memoryStats ? result.memoryStats.hits : 0,
  });
}

/**
 * 记录用户反馈事件。
 *
 * @param {object} result - 反馈结果
 */
function recordUserFeedback(result) {
  return recordEvent('user_feedback', {
    overrides: result.targetOverrides ? result.targetOverrides.length : 0,
    excludes: result.excludedFiles ? result.excludedFiles.length : 0,
  });
}

/**
 * 记录 Execute 事件。
 *
 * @param {object} result - 执行结果
 */
function recordExecute(result) {
  return recordEvent('execute', {
    moved: result.moved || 0,
    failed: result.failed || 0,
    status: result.status || 'unknown',
  });
}

/**
 * 记录 Undo 事件。
 *
 * @param {object} result - 撤销结果
 */
function recordUndo(result) {
  return recordEvent('undo', {
    reverted: result.reverted || 0,
    status: result.status || 'unknown',
  });
}

/**
 * 查询 Agent History。
 *
 * @param {object} query - 查询条件
 * @returns {object[]} 匹配的事件
 */
function queryHistory(query = {}) {
  const history = loadHistory();
  let events = history.events;

  if (query.event) {
    events = events.filter(e => e.event === query.event);
  }
  if (query.since) {
    const sinceTime = new Date(query.since).getTime();
    events = events.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
  }
  if (query.limit) {
    events = events.slice(-query.limit);
  }

  return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * 获取 Agent History 统计。
 *
 * @returns {object}
 */
function getHistoryStats() {
  const history = loadHistory();
  const byEvent = {};
  for (const e of history.events) {
    byEvent[e.event] = (byEvent[e.event] || 0) + 1;
  }
  return {
    total: history.events.length,
    byEvent,
    oldest: history.events.length > 0 ? history.events[0].timestamp : null,
    newest: history.events.length > 0 ? history.events[history.events.length - 1].timestamp : null,
  };
}

/**
 * 清空 Agent History。
 */
function clearHistory() {
  saveHistory({ version: 1, events: [] });
}

/**
 * 导出 Agent History。
 */
function exportHistory() {
  return loadHistory();
}

module.exports = {
  recordEvent,
  recordIncrementalScan,
  recordPlanGenerated,
  recordUserFeedback,
  recordExecute,
  recordUndo,
  queryHistory,
  getHistoryStats,
  clearHistory,
  exportHistory,
  HISTORY_FILE,
};