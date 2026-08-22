/**
 * scheduler.js — Background Scheduler Foundation (V0.5.1)
 *
 * 基础调度能力：支持定时触发增量扫描。
 * 第一版不做自动执行，只生成 pending plan。
 *
 * 存储：~/.local-file-organizer/scheduler.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 存储路径 ──────────────────────────────────────────────
const STATE_DIR = path.join(os.homedir(), '.local-file-organizer');
const SCHEDULER_FILE = path.join(STATE_DIR, 'scheduler.json');

let schedulerCache = null;

// 默认配置
const DEFAULT_CONFIG = {
  enabled: false,
  intervalMs: 24 * 60 * 60 * 1000, // 24 小时
  lastRunAt: null,
  nextRunAt: null,
  pendingPlans: [],
};

/**
 * 确保存储目录存在。
 */
function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

/**
 * 加载 Scheduler 状态（带缓存）。
 */
function loadScheduler() {
  if (schedulerCache) return schedulerCache;
  try {
    if (fs.existsSync(SCHEDULER_FILE)) {
      const raw = fs.readFileSync(SCHEDULER_FILE, 'utf-8');
      schedulerCache = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } else {
      schedulerCache = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error('[scheduler] 加载失败，使用默认配置:', err.message);
    schedulerCache = { ...DEFAULT_CONFIG };
  }
  return schedulerCache;
}

/**
 * 保存 Scheduler 状态到磁盘。
 */
function saveScheduler(data) {
  ensureDir();
  fs.writeFileSync(SCHEDULER_FILE, JSON.stringify(data, null, 2), 'utf-8');
  schedulerCache = data;
}

/**
 * 配置 Scheduler。
 *
 * @param {object} config - { enabled, intervalMs }
 * @returns {object} 更新后的配置
 */
function configure(config = {}) {
  const current = loadScheduler();
  const updated = {
    ...current,
    ...config,
    updatedAt: new Date().toISOString(),
  };

  // 计算下次运行时间
  if (updated.enabled && updated.intervalMs) {
    updated.nextRunAt = new Date(Date.now() + updated.intervalMs).toISOString();
  } else {
    updated.nextRunAt = null;
  }

  saveScheduler(updated);
  return updated;
}

/**
 * 获取 Scheduler 配置。
 *
 * @returns {object}
 */
function getConfig() {
  return loadScheduler();
}

/**
 * 触发一次调度运行（手动触发）。
 *
 * @param {object} [result] - 扫描结果
 * @returns {object} 运行结果
 */
function triggerRun(result = null) {
  const config = loadScheduler();
  config.lastRunAt = new Date().toISOString();

  if (config.enabled && config.intervalMs) {
    config.nextRunAt = new Date(Date.now() + config.intervalMs).toISOString();
  } else {
    config.nextRunAt = null;
  }

  saveScheduler(config);
  return {
    triggered: true,
    lastRunAt: config.lastRunAt,
    nextRunAt: config.nextRunAt,
    result,
  };
}

/**
 * 添加 pending plan。
 *
 * @param {object} plan - Plan 数据
 */
function addPendingPlan(plan) {
  const config = loadScheduler();
  config.pendingPlans = config.pendingPlans || [];
  config.pendingPlans.push({
    id: 'pp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    ...plan,
    createdAt: new Date().toISOString(),
    status: 'pending',
  });
  // 限制 pending plan 数量
  if (config.pendingPlans.length > 100) {
    config.pendingPlans = config.pendingPlans.slice(-100);
  }
  saveScheduler(config);
}

/**
 * 获取 pending plans。
 *
 * @returns {object[]}
 */
function getPendingPlans() {
  const config = loadScheduler();
  return config.pendingPlans || [];
}

/**
 * 清除 pending plan。
 *
 * @param {string} planId
 */
function clearPendingPlan(planId) {
  const config = loadScheduler();
  config.pendingPlans = (config.pendingPlans || []).filter(p => p.id !== planId);
  saveScheduler(config);
}

/**
 * 清空所有 pending plans。
 */
function clearAllPendingPlans() {
  const config = loadScheduler();
  config.pendingPlans = [];
  saveScheduler(config);
}

/**
 * 重置 Scheduler。
 */
function reset() {
  saveScheduler({ ...DEFAULT_CONFIG });
}

/**
 * 检查是否需要运行（基于时间）。
 *
 * @returns {boolean}
 */
function shouldRun() {
  const config = loadScheduler();
  if (!config.enabled) return false;
  if (!config.nextRunAt) return false;
  return new Date(config.nextRunAt) <= new Date();
}

module.exports = {
  configure,
  getConfig,
  triggerRun,
  addPendingPlan,
  getPendingPlans,
  clearPendingPlan,
  clearAllPendingPlans,
  reset,
  shouldRun,
  SCHEDULER_FILE,
  DEFAULT_CONFIG,
};