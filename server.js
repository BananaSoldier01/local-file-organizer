/**
 * server.js — 本地 HTTP 服务器
 *
 * 提供 REST API 和静态文件服务。
 * 所有文件操作在服务器端执行（拥有完整 fs 权限）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');

// ── 引擎模块 ──────────────────────────────────────────────
const scanner = require('./engine/scanner');
const classifier = require('./engine/classifier');
const organizer = require('./engine/organizer');
const executor = require('./engine/executor');
const history = require('./engine/history');

// ── 配置 ──────────────────────────────────────────────────
const PORT = process.env.PORT || 38211;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_DIR = path.join(os.homedir(), '.file-organizer');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

function maskSettings(settings) {
  // 深拷贝，API Key 替换为配置状态标记
  const masked = JSON.parse(JSON.stringify(settings));
  if (masked.llm) {
    const key = masked.llm.apiKey;
    masked.llm.apiKeyConfigured = !!(key && key.length > 0);
    if (key && key.length > 8) {
      masked.llm.apiKeyPreview = key.slice(0, 4) + '••••••••••' + key.slice(-4);
    } else if (key && key.length > 0) {
      masked.llm.apiKeyPreview = '••••';
    } else {
      masked.llm.apiKeyPreview = '';
    }
    delete masked.llm.apiKey;
  }
  return masked;
}

function loadSettings() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      // 安全：确保 overwrite 不是默认值
      if (!raw.conflictStrategy || !raw.conflictStrategy.overwrite) {
        raw.conflictStrategy = { overwrite: 'skip' };
      }
      return raw;
    }
  } catch (err) {
    console.warn('[settings] 加载失败:', err.message);
  }
  return {
    llm: { enabled: false, endpoint: '', apiKey: '', model: 'deepseek-chat' },
    skipHidden: true,
    skipDirs: [],
    conflictStrategy: { overwrite: 'skip' },
  };
}

function saveSettings(settings) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[settings] 保存失败:', err.message);
  }
}

// ── MIME 类型 ─────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ── JSON 响应辅助 ─────────────────────────────────────────
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function ok(res, data) { json(res, 200, { success: true, data }); }
function fail(res, status, message) { json(res, status || 500, { success: false, error: message }); }

// ── 路由 ──────────────────────────────────────────────────
async function handleAPI(req, res, parsedUrl) {
  const { pathname } = parsedUrl;

  if (pathname === '/api/scan' && req.method === 'POST') {
    return await handleScan(req, res);
  }
  if (pathname === '/api/scan-progress' && req.method === 'GET') {
    return handleScanProgress(req, res);
  }
  if (pathname === '/api/scan-result' && req.method === 'GET') {
    return handleScanResult(req, res);
  }
  if (pathname === '/api/classify-progress' && req.method === 'GET') {
    return handleClassifyProgress(req, res);
  }
  if (pathname === '/api/classify-result' && req.method === 'GET') {
    return handleClassifyResult(req, res);
  }
  if (pathname === '/api/classify-cancel' && req.method === 'POST') {
    return handleClassifyCancel(req, res);
  }
  if (pathname === '/api/execute-progress' && req.method === 'GET') {
    return handleExecuteProgress(req, res);
  }
  if (pathname === '/api/execute-cancel' && req.method === 'POST') {
    return handleExecuteCancel(req, res);
  }
  if (pathname === '/api/job' && req.method === 'GET') {
    const type = parsedUrl.query.type;
    const id = parsedUrl.query.id;
    if (!type || !id) return fail(res, 400, '缺少 type 或 id');
    const result = pollJob(type, id);
    if (result.error) return fail(res, 404, result.error);
    return ok(res, result);
  }
  // 测试专用：安全检查端点（仅开发模式）
  if (pathname === '/api/test-security' && req.method === 'POST') {
    if (process.env.NODE_ENV !== 'test') {
      return fail(res, 404, 'Not found');
    }
    return handleTestSecurity(req, res);
  }
  if (pathname === '/api/classify' && req.method === 'POST') {
    return await handleClassify(req, res);
  }
  if (pathname === '/api/pick-folder' && req.method === 'POST') {
    return await handlePickFolder(req, res);
  }
  if (pathname === '/api/plan' && req.method === 'POST') {
    return await handlePlan(req, res);
  }
  if (pathname === '/api/execute' && req.method === 'POST') {
    return await handleExecute(req, res);
  }
  if (pathname === '/api/undo' && req.method === 'POST') {
    return await handleUndo(req, res);
  }
  if (pathname === '/api/history' && req.method === 'GET') {
    return await handleGetHistory(req, res, parsedUrl);
  }
  if (pathname === '/api/history/clear' && req.method === 'POST') {
    history.clearHistory();
    return ok(res, {});
  }
  if (pathname === '/api/history/stats' && req.method === 'GET') {
    return ok(res, history.getHistoryStats());
  }
  if (pathname === '/api/categories' && req.method === 'GET') {
    return ok(res, classifier.getCategories());
  }
  if (pathname === '/api/file-types' && req.method === 'GET') {
    return ok(res, classifier.getFileTypes());
  }
  if (pathname === '/api/settings' && req.method === 'GET') {
    return ok(res, maskSettings(loadSettings()));
  }
  if (pathname === '/api/settings' && req.method === 'POST') {
    return await handleSaveSettings(req, res);
  }
  if (pathname === '/api/relationship' && req.method === 'POST') {
    return await handleRelationship(req, res);
  }
  fail(res, 404, 'Not found');
}

// ── 请求处理 ──────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { resolve({ raw: data }); }
    });
    req.on('error', reject);
  });
}

// ── 异步 Job 基础设施 ──────────────────────────────────────
const jobMaps = {
  scan: new Map(),
  classify: new Map(),
  execute: new Map(),
};

// ── 受信任链路存储 ──────────────────────────────────────────
// scanId → { sourceRoot, createdAt }
const scanRootStore = new Map();
// planId → { scanId, sourceRoot, moves, targetRoot, createdAt }
const planStore = new Map();

function cleanupJob(map, id, delayMs = 30000) {
  setTimeout(() => map.delete(id), delayMs);
}

function cleanupStore(store, id, delayMs) {
  setTimeout(() => store.delete(id), delayMs);
}

// ── Session 生命周期（idle TTL + touch）───────────────────────
// 替代固定 120s 创建即过期的策略。
// 用户 Review 期间每次有效操作 touch()，超过 IDLE_TTL 无操作才清理。
const SESSION_IDLE_TTL = parseInt(process.env.SESSION_IDLE_TTL_MS) || (30 * 60 * 1000); // 30 分钟 idle（测试可覆盖）

function touchStore(store, id) {
  const entry = store.get(id);
  if (entry) {
    entry.lastTouch = Date.now();
    // 刷新自动清理定时器
    if (entry._cleanupTimer) {
      clearTimeout(entry._cleanupTimer);
    }
    entry._cleanupTimer = setTimeout(() => store.delete(id), SESSION_IDLE_TTL);
  }
}

function isStoreExpired(store, id) {
  const entry = store.get(id);
  if (!entry) return true;
  // 如果没有 lastTouch（旧数据），用 createdAt 兜底
  const lastActivity = entry.lastTouch || entry.createdAt;
  return (Date.now() - lastActivity) > SESSION_IDLE_TTL;
}

// ── 路径安全工具 ────────────────────────────────────────────
/**
 * 规范化路径：解析 `..` / `.` / 符号链接（仅对已存在路径）。
 * 对不存在的路径，只解析已存在的祖先目录。
 */
function canonicalizeExistingPath(p) {
  const resolved = path.resolve(p);
  // 尝试 realpath，失败则返回 resolve 结果
  try {
    return fs.realpathSync(resolved);
  } catch (_) {
    return resolved;
  }
}

/**
 * 规范化路径（允许目标不存在）：逐级向上找到已存在祖先，realpath 该祖先，
 * 再拼接剩余部分。
 */
function canonicalizePathAllowMissing(p) {
  const resolved = path.resolve(p);
  // 逐级向上找已存在祖先
  let ancestor = resolved;
  const parts = [];
  while (ancestor) {
    try {
      if (fs.existsSync(ancestor)) {
        const realAncestor = fs.realpathSync(ancestor);
        return path.join(realAncestor, ...parts);
      }
    } catch (_) { /* continue */ }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    parts.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return resolved;
}

/**
 * 判断 canonical 路径是否在 root 内部（含 root 本身）。
 * 使用 path.relative 防止前缀碰撞。
 */
function isPathWithinRoot(canonicalPath, canonicalRoot) {
  if (canonicalPath === canonicalRoot) return true;
  const rel = path.relative(canonicalRoot, canonicalPath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 检查 move 的 source / target 是否安全。
 *
 * Source: 必须在 canonicalRoot 内（使用 realpath + path.relative 防前缀碰撞）。
 * Target: 必须在 canonicalRoot 内（受控分类子目录）。
 *   阻止：../ 逃逸、符号链接逃逸、前缀碰撞、source/target 相同/子目录。
 *
 * @param {object} move  {from, to}
 * @param {string} canonicalRoot  规范化后的 scan root
 * @returns {{safe: boolean, reason?: string}}
 */
function checkMoveSafety(move, canonicalRoot) {
  const { from, to } = move;

  // ── Source 验证 ──
  let realFrom;
  try {
    realFrom = fs.realpathSync(from);
  } catch (e) {
    return { safe: false, reason: '源文件不存在: ' + from };
  }
  if (!isPathWithinRoot(realFrom, canonicalRoot)) {
    return { safe: false, reason: '源文件不在扫描根目录内: ' + from };
  }

  // ── Target 验证 ──
  // 使用 canonicalizePathAllowMissing 以正确处理 /var/folders 等 symlink
  const canonicalTo = canonicalizePathAllowMissing(to);

  // 阻止 target 是 source 的子目录或相同
  if (canonicalTo === realFrom) {
    return { safe: false, reason: '源文件与目标路径相同' };
  }
  if (canonicalTo.startsWith(realFrom + path.sep)) {
    return { safe: false, reason: '目标路径是源文件的子目录' };
  }

  // 阻止 target 文件名包含非法字符
  if (/[<>:"|?*]/.test(path.basename(to))) {
    return { safe: false, reason: '目标文件名包含非法字符' };
  }

  // 检查 target 的每个祖先目录是否有 symlink 逃逸
  // 从 target 的父目录向上遍历到 root
  let checkDir = path.dirname(canonicalTo);
  while (checkDir && checkDir !== path.dirname(checkDir)) {
    // 只检查 root 内的路径
    if (isPathWithinRoot(canonicalizeExistingPath(checkDir), canonicalRoot)) {
      try {
        if (fs.lstatSync(checkDir).isSymbolicLink()) {
          const linkTarget = fs.realpathSync(checkDir);
          if (!isPathWithinRoot(linkTarget, canonicalRoot)) {
            return { safe: false, reason: '检测到符号链接逃逸: ' + checkDir };
          }
        }
      } catch (_) { /* 路径不存在，继续 */ }
    }
    checkDir = path.dirname(checkDir);
  }

  // Target 必须在 canonicalRoot 内（防 ../ 逃逸 + 前缀碰撞）
  if (!isPathWithinRoot(canonicalTo, canonicalRoot)) {
    return { safe: false, reason: '目标路径不在扫描根目录内: ' + to };
  }

  return { safe: true };
}

/**
 * 统一轮询入口。
 * 前端只传 type + id，不直接访问各 Job 的内部字段。
 */
function pollJob(type, id) {
  const map = jobMaps[type];
  if (!map) return { error: '未知 Job 类型: ' + type };
  const job = map.get(id);
  if (!job) return { error: 'Job 不存在: ' + id };

  const base = {
    id: job.scanId || job.classifyId || job.execId,
    type,
    status: job.status,
    done: false,
  };

  if (type === 'scan') {
    base.percent = job.percent;
    base.files = job.files;
    base.dirs = job.dirs;
    base.scannedDirs = job.scannedDirs;
    base.totalDirs = job.totalDirs;
    base.error = job.error;
    base.done = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
  } else if (type === 'classify') {
    base.totalFiles = job.totalFiles;
    base.processedFiles = job.processedFiles;
    base.totalBatches = job.totalBatches;
    base.completedBatches = job.completedBatches;
    base.failedBatches = job.failedBatches;
    base.error = job.error;
    base.done = job.status === 'completed' || job.status === 'partial' || job.status === 'failed' || job.status === 'cancelled';
  } else if (type === 'execute') {
    base.total = job.total;
    base.completed = job.completed;
    base.failed = job.failedCount;
    base.skipped = job.skippedCount;
    base.currentFile = job.currentFile;
    base.successCount = job.success.length;
    base.sessionId = job.sessionId;
    base.error = job.error;
    base.done = job.status === 'completed' || job.status === 'partial' || job.status === 'failed' || job.status === 'cancelled_partial';
  }

  return base;
}

// ── 扫描 Job ──────────────────────────────────────────────
function createScanJob(rootPath, options) {
  const scanId = 'scan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // 存储可信 sourceRoot + 文件路径集合（用于 Plan 文件归属验证）
  const canonicalRoot = canonicalizeExistingPath(rootPath);
  const entry = {
    sourceRoot: canonicalRoot,
    createdAt: Date.now(),
    lastTouch: Date.now(),
  };
  scanRootStore.set(scanId, entry);
  entry._cleanupTimer = setTimeout(() => scanRootStore.delete(scanId), SESSION_IDLE_TTL);

  const job = {
    scanId,
    status: 'queued',       // queued → preparing → scanning → completed | failed | cancelled
    percent: 0,
    files: 0,
    dirs: 0,
    scannedDirs: 0,
    totalDirs: 0,
    error: null,
    result: null,
    createdAt: Date.now(),
  };

  jobMaps.scan.set(scanId, job);

  // 后台执行扫描
  (async () => {
    try {
      job.status = 'preparing';

      const onProgress = (p) => {
        job.files = p.files || 0;
        job.dirs = p.dirs || 0;
        job.scannedDirs = p.scanned || 0;
        job.totalDirs = p.total || 0;
        if (job.totalDirs > 0) {
          job.percent = Math.min(95, Math.round((job.scannedDirs / job.totalDirs) * 95));
        }
      };

      job.status = 'scanning';
      const result = await scanner.scanDirectory(rootPath, { ...options, onProgress });

      job.status = 'completed';
      job.percent = 100;
      job.result = result;
      job.files = result.files.length;
      job.dirs = result.stats?.totalDirs || 0;

      // 将扫描到的文件路径集合存入 scanRootStore，用于 Plan 文件归属验证
      const scanEntry = scanRootStore.get(scanId);
      if (scanEntry) {
        scanEntry.fileSet = new Set(result.files.map(f => {
          try { return fs.realpathSync(f.path); }
          catch (_) { return f.path; }
        }));
      }

      cleanupJob(jobMaps.scan, scanId);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      cleanupJob(jobMaps.scan, scanId);
    }
  })();

  return scanId;
}

async function handleScan(req, res) {
  try {
    const body = await readBody(req);
    const { rootPath, options } = body;
    if (!rootPath) return fail(res, 400, '缺少 rootPath');

    // 基本路径验证
    if (typeof rootPath !== 'string' || rootPath.length > 1024) {
      return fail(res, 400, '无效的路径');
    }

    // 检查路径是否存在且是目录
    try {
      const stat = fs.statSync(rootPath);
      if (!stat.isDirectory()) {
        return fail(res, 400, '路径不是目录');
      }
    } catch (e) {
      return fail(res, 400, '目录不存在或无法访问: ' + rootPath);
    }

    // 立即创建异步 job 并返回 scanId
    const scanId = createScanJob(rootPath, options);
    ok(res, { scanId, status: 'preparing' });
  } catch (err) { fail(res, 500, err.message); }
}

function handleScanProgress(req, res) {
  const scanId = url.parse(req.url, true).query.scanId;
  const job = jobMaps.scan.get(scanId);
  if (!job) return fail(res, 404, '扫描任务不存在');
  ok(res, {
    scanId: job.scanId,
    status: job.status,
    percent: job.percent,
    done: job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled',
    files: job.files,
    dirs: job.dirs,
    scannedDirs: job.scannedDirs,
    totalDirs: job.totalDirs,
    error: job.error,
  });
}

function handleScanResult(req, res) {
  const scanId = url.parse(req.url, true).query.scanId;
  const job = jobMaps.scan.get(scanId);
  if (!job) return fail(res, 404, '扫描任务不存在');
  if (job.status !== 'completed') {
    return fail(res, 400, '扫描未完成，当前状态: ' + job.status);
  }
  ok(res, job.result);
}

async function handlePickFolder(req, res) {
  try {
    const { execFile } = require('child_process');
    // 用 POSIX path 形式直接返回 POSIX 路径，避免 alias 格式解析
    const osascript = 'POSIX path of (choose folder "选择要整理的文件夹")';

    execFile('osascript', ['-e', osascript], (err, stdout, stderr) => {
      if (err) {
        if (stderr && stderr.includes('用户取消')) {
          return ok(res, { canceled: true });
        }
        return fail(res, 500, stderr || err.message);
      }
      const folderPath = stdout.trim();
      if (!folderPath) return ok(res, { canceled: true });
      ok(res, { path: folderPath });
    });
  } catch (err) { fail(res, 500, err.message); }
}

// ── 请求处理 ──────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { resolve({ raw: data }); }
    });
    req.on('error', reject);
  });
}

// ── 分类 Job ──────────────────────────────────────────────
function createClassifyJob(files, config) {
  const classifyId = 'cls_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const settings = loadSettings();
  const llmConfig = (config && config.llm) || settings.llm;
  const context = (config && config.context) || {};
  const detectProjects = (config && config.detectProjects) || false;

  const job = {
    classifyId,
    status: 'queued',       // queued → preparing → running → completed | partial | failed | cancelled
    totalFiles: files.length,
    processedFiles: 0,
    totalBatches: 0,
    completedBatches: 0,
    failedBatches: 0,
    results: null,
    error: null,
    cancelRequested: false,
    createdAt: Date.now(),
  };

  // V0.4: 内容感知分类开关（默认开启）
  const contentAware = (config && config.contentAware !== false);

  jobMaps.classify.set(classifyId, job);

  (async () => {
    try {
      job.status = 'preparing';

      const BATCH_SIZE = 20;
      const batches = [];
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        batches.push(files.slice(i, i + BATCH_SIZE));
      }
      job.totalBatches = batches.length;

      job.status = 'running';
      const allResults = [];

      for (let bi = 0; bi < batches.length; bi++) {
        if (job.cancelRequested) {
          job.status = 'cancelled';
          break;
        }

        const batch = batches[bi];
        try {
          const batchResults = await classifier.classifyBatch(batch, { llm: llmConfig, context, detectProjects: false, contentAware });
          allResults.push(...batchResults);
          job.completedBatches++;
        } catch (batchErr) {
          console.warn('[classify] batch ' + bi + ' failed:', batchErr.message);
          job.failedBatches++;
        }
        job.processedFiles = Math.min(files.length, (bi + 1) * BATCH_SIZE);
        // 小延迟使取消操作有时间生效
        if (bi < batches.length - 1) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      if (job.status !== 'cancelled') {
        // Project Group 阶段
        if (detectProjects && llmConfig && llmConfig.enabled && llmConfig.apiKey) {
          job.status = 'grouping';
          try {
            const groups = await classifier.detectProjectGroups(allResults, llmConfig);
            job.projectGroups = groups;
          } catch (groupErr) {
            console.warn('[classify] project grouping failed:', groupErr.message);
            job.projectGroups = [];
          }
        }

        // V0.4.3: Relationship Analysis 阶段
        job.status = 'relationship';
        try {
          const relationship = require('./engine/relationship');
          const relResult = relationship.buildRelationshipGraph(allResults);
          job.relationshipGroups = relResult.groups;
          job.relationshipStats = relResult.stats;
        } catch (relErr) {
          console.warn('[classify] relationship analysis failed:', relErr.message);
          job.relationshipGroups = [];
        }

        job.status = job.failedBatches > 0 ? 'partial' : 'completed';
      }
      job.results = allResults;

      cleanupJob(jobMaps.classify, classifyId);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      cleanupJob(jobMaps.classify, classifyId);
    }
  })();

  return classifyId;
}

async function handleClassify(req, res) {
  try {
    const body = await readBody(req);
    const { files, config } = body;
    if (!files) return fail(res, 400, '缺少 files');

    const classifyId = createClassifyJob(files, config);
    ok(res, { classifyId, status: 'queued', totalFiles: files.length });
  } catch (err) { fail(res, 500, err.message); }
}

function handleClassifyProgress(req, res) {
  const classifyId = url.parse(req.url, true).query.classifyId;
  const job = jobMaps.classify.get(classifyId);
  if (!job) return fail(res, 404, '分类任务不存在');
  ok(res, {
    classifyId: job.classifyId,
    status: job.status,
    totalFiles: job.totalFiles,
    processedFiles: job.processedFiles,
    totalBatches: job.totalBatches,
    completedBatches: job.completedBatches,
    failedBatches: job.failedBatches,
    hasProjectGroups: !!job.projectGroups,
    projectGroupCount: job.projectGroups ? job.projectGroups.length : 0,
    error: job.error,
    done: job.status === 'completed' || job.status === 'partial' || job.status === 'failed' || job.status === 'cancelled',
  });
}

function handleClassifyResult(req, res) {
  const classifyId = url.parse(req.url, true).query.classifyId;
  const job = jobMaps.classify.get(classifyId);
  if (!job) return fail(res, 404, '分类任务不存在');
  if (job.status !== 'completed' && job.status !== 'partial') {
    return fail(res, 400, '分类未完成，当前状态: ' + job.status);
  }
  const result = { results: job.results };
  if (job.projectGroups) {
    result.projectGroups = job.projectGroups;
  }
  if (job.relationshipGroups) {
    result.relationshipGroups = job.relationshipGroups;
    result.relationshipStats = job.relationshipStats;
  }
  ok(res, result);
}

async function handleClassifyCancel(req, res) {
  // 统一协议：POST /api/classify-cancel body: { id }
  const body = await readBody(req);
  const classifyId = body.id;
  if (!classifyId) return fail(res, 400, '缺少 classifyId');
  const job = jobMaps.classify.get(classifyId);
  if (!job) return fail(res, 404, '分类任务不存在');
  if (job.status === 'running' || job.status === 'grouping') {
    job.cancelRequested = true;
    ok(res, { cancelled: true });
  } else {
    fail(res, 400, '任务当前状态不可取消: ' + job.status);
  }
}

async function handlePlan(req, res) {
  try {
    const body = await readBody(req);
    const { files, options, scanId } = body;
    if (!files) return fail(res, 400, '缺少 files');

    // 必须携带有效 scanId，否则拒绝生成可执行 Plan
    if (!scanId) {
      return fail(res, 400, '缺少 scanId：生成整理方案必须关联一次扫描');
    }

    const scanEntry = scanRootStore.get(scanId);
    if (!scanEntry) {
      return fail(res, 404, 'scanId 不存在或已过期');
    }
    if (isStoreExpired(scanRootStore, scanId)) {
      scanRootStore.delete(scanId);
      return fail(res, 404, 'scanId 已过期，请重新扫描');
    }

    // 验证所有请求文件属于本次 Scan Session
    if (scanEntry.fileSet) {
      const foreignFiles = [];
      for (const f of files) {
        let canonical;
        try {
          canonical = fs.realpathSync(f.path);
        } catch (_) { canonical = f.path; }
        if (!scanEntry.fileSet.has(canonical)) {
          foreignFiles.push(f.path);
        }
      }
      if (foreignFiles.length > 0) {
        return fail(res, 403, `以下文件不属于本次扫描结果，拒绝注入: ${foreignFiles.slice(0, 3).join(', ')}`);
      }
    }

    const sourceRoot = scanEntry.sourceRoot;

    // touch scan session
    touchStore(scanRootStore, scanId);

    // 解析 targetRoot：如果它是相对路径，相对于 sourceRoot 解析
    if (options && options.targetRoot) {
      const tr = options.targetRoot;
      if (!path.isAbsolute(tr)) {
        options.targetRoot = path.resolve(sourceRoot, tr);
      }
      // 验证解析后的 targetRoot 是否在 sourceRoot 内（防止 ../ 逃逸）
      // sourceRoot 是 canonicalRoot（已 realpath），targetRoot 可能是 /var 而非 /private/var
      // 需要将 targetRoot 也 canonicalize 后再比较
      const resolvedTarget = path.resolve(options.targetRoot);
      // 尝试 realpath targetRoot（目标目录可能尚不存在，先试本身再试父目录）
      let canonicalTarget;
      try {
        canonicalTarget = fs.realpathSync(resolvedTarget);
      } catch (_) {
        // 目标目录不存在，尝试解析父目录
        try {
          const parent = path.dirname(resolvedTarget);
          const parentReal = fs.realpathSync(parent);
          canonicalTarget = path.join(parentReal, path.basename(resolvedTarget));
        } catch (_) {
          // 父目录也不存在，回退到 resolve 结果
          canonicalTarget = resolvedTarget;
        }
      }
      const rel = path.relative(sourceRoot, canonicalTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return fail(res, 403, `整理目标必须在扫描根目录内: ${options.targetRoot}`);
      }
    }

    // V0.4.3: 接收 Relationship Groups 作为 Plan 生成输入
    const relationshipGroups = (options && options.relationshipGroups) || null;

    const plan = organizer.generatePlan(files, { ...options, relationshipGroups });
    const validation = organizer.validatePlan(plan);

    // 存储受信任的 plan
    const planId = 'plan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const planEntry = {
      planId,
      scanId,
      sourceRoot,
      moves: plan.moves,
      targetRoot: plan.targetRoot,
      createdAt: Date.now(),
      lastTouch: Date.now(),
    };
    planStore.set(planId, planEntry);
    planEntry._cleanupTimer = setTimeout(() => planStore.delete(planId), SESSION_IDLE_TTL);

    ok(res, { ...plan, validation, planId });
  } catch (err) { fail(res, 500, err.message); }
}

// ── 执行 Job ──────────────────────────────────────────────
function createExecuteJob(plan, conflictStrategy, sourceRoot) {
  const execId = 'exec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const job = {
    execId,
    status: 'queued',       // queued → running → completed | partial | failed | cancelled_partial
    total: plan.moves.length,
    completed: 0,
    failedCount: 0,
    skippedCount: 0,
    currentFile: null,
    success: [],
    failed: [],
    skipped: [],
    sessionId: null,
    error: null,
    cancelRequested: false,
    createdAt: Date.now(),
  };

  jobMaps.execute.set(execId, job);

  (async () => {
    try {
      job.status = 'running';
      const strategy = conflictStrategy || { overwrite: 'skip' };

      // 逐个执行移动，每完成一个更新进度
      for (let i = 0; i < plan.moves.length; i++) {
        if (job.cancelRequested) {
          job.status = 'cancelled_partial';
          break;
        }

        const move = plan.moves[i];
        job.currentFile = move.from;

        try {
          // 执行前安全检查
          const safety = executor.checkMoveSafety(move, sourceRoot);
          if (!safety.safe) {
            job.skippedCount++;
            job.skipped.push({ ...move, reason: safety.reason });
            job.completed++;
            continue;
          }

          const result = await executor.executeSingleMove(move, strategy);
          if (result.success) {
            job.success.push(result);
            job.completed++;
          } else if (result.skipped) {
            job.skippedCount++;
            job.skipped.push({ ...move, reason: result.error });
            job.completed++;
          } else {
            job.failedCount++;
            job.failed.push({ ...move, error: result.error });
            job.completed++;
          }
          // 小延迟使取消操作有时间生效
          if (job.completed < job.total) {
            await new Promise(r => setTimeout(r, 500));
          }
        } catch (err) {
          job.failedCount++;
          job.failed.push({ ...move, error: err.message });
          job.completed++;
        }

        // 更新进度
        job.total = plan.moves.length;
      }

      if (job.status !== 'cancelled_partial') {
        job.status = job.failed.length > 0 ? 'partial' : 'completed';
      }

      // 记录历史
      if (job.success.length > 0) {
        job.sessionId = history.recordSession({
          sourceDir: sourceRoot,
          targetRoot: plan.targetRoot,
          moves: plan.moves,
          summary: { total: plan.moves.length },
          success: job.success,
          failed: job.failed,
          skipped: job.skipped,
        });
      }

      cleanupJob(jobMaps.execute, execId, 60000);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      cleanupJob(jobMaps.execute, execId);
    }
  })();

  return execId;
}

async function handleExecute(req, res) {
  try {
    const body = await readBody(req);
    const { planId, conflictStrategy } = body;

    if (!planId) {
      return fail(res, 400, '缺少 planId');
    }

    const stored = planStore.get(planId);
    if (!stored) {
      return fail(res, 404, 'planId 不存在或已过期');
    }
    if (isStoreExpired(planStore, planId)) {
      planStore.delete(planId);
      return fail(res, 404, 'planId 已过期，请重新生成方案');
    }

    // touch plan session
    touchStore(planStore, planId);

    const plan = { moves: stored.moves, targetRoot: stored.targetRoot };
    const sourceRoot = stored.sourceRoot;

    // 执行前服务端路径安全验证
    if (sourceRoot) {
      const canonicalRoot = canonicalizeExistingPath(sourceRoot);
      for (const move of plan.moves) {
        const safety = checkMoveSafety(move, canonicalRoot);
        if (!safety.safe) {
          return fail(res, 403, safety.reason);
        }
      }
    }

    const execId = createExecuteJob(plan, conflictStrategy, sourceRoot);
    ok(res, { execId, status: 'queued', total: plan.moves.length });
  } catch (err) { fail(res, 500, err.message); }
}

function handleExecuteProgress(req, res) {
  const execId = url.parse(req.url, true).query.execId;
  const job = jobMaps.execute.get(execId);
  if (!job) return fail(res, 404, '执行任务不存在');
  ok(res, {
    execId: job.execId,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failedCount,
    skipped: job.skippedCount,
    currentFile: job.currentFile,
    successCount: job.success.length,
    sessionId: job.sessionId,
    error: job.error,
    done: job.status === 'completed' || job.status === 'partial' || job.status === 'failed' || job.status === 'cancelled_partial',
  });
}

async function handleExecuteCancel(req, res) {
  try {
    const body = await readBody(req);
    const execId = body.id || body.execId;
    const job = jobMaps.execute.get(execId);
    if (!job) return fail(res, 404, '执行任务不存在');
    if (job.status === 'running') {
      job.cancelRequested = true;
      ok(res, { cancelled: true, completed: job.completed, total: job.total });
    } else {
      fail(res, 400, '任务当前状态不可取消: ' + job.status);
    }
  } catch (err) { fail(res, 500, err.message); }
}

async function handleUndo(req, res) {
  try {
    const body = await readBody(req);
    const { sessionId } = body;
    const result = await history.undoLastSession(sessionId);
    ok(res, result);
  } catch (err) { fail(res, 500, err.message); }
}

async function handleGetHistory(req, res, parsedUrl) {
  try {
    const limit = parseInt(parsedUrl.query.limit, 10) || 50;
    const data = history.getRecentHistory(limit);
    ok(res, data);
  } catch (err) { fail(res, 500, err.message); }
}

async function handleSaveSettings(req, res) {
  try {
    const body = await readBody(req);
    const current = loadSettings();

    // 如果客户端没有提供新的 apiKey，保留原有 key
    if (body.llm && body.llm.apiKey) {
      // 用户提供了新 key，使用新值
    } else if (current.llm && current.llm.apiKey) {
      // 保留原有 key
      if (!body.llm) body.llm = {};
      body.llm.apiKey = current.llm.apiKey;
    }

    saveSettings(body);
    ok(res, {});
  } catch (err) { fail(res, 500, err.message); }
}

// ── 文件关系分析 ──────────────────────────────────────────
async function handleRelationship(req, res) {
  try {
    const body = await readBody(req);
    const { files, config } = body;
    if (!files || !Array.isArray(files)) {
      return fail(res, 400, '缺少 files 数组');
    }

    const relationship = require('./engine/relationship');
    const result = relationship.buildRelationshipGraph(files, {
      minScore: (config && config.minScore) || 0.3,
      maxPairs: (config && config.maxPairs) || 5000,
    });
    const report = relationship.generateReport(result);
    ok(res, report);
  } catch (err) { fail(res, 500, err.message); }
}

// ── 测试专用安全检查 ──────────────────────────────────────
async function handleTestSecurity(req, res) {
  try {
    const body = await readBody(req);
    const { moves, sourceRoot } = body;
    if (!moves || !sourceRoot) return fail(res, 400, '缺少 moves 或 sourceRoot');

    const canonicalRoot = canonicalizeExistingPath(sourceRoot);
    const results = moves.map(move => {
      const safety = checkMoveSafety(move, canonicalRoot);
      return { from: move.from, to: move.to, ...safety };
    });

    const allSafe = results.every(r => r.safe);
    ok(res, { allSafe, results });
  } catch (err) { fail(res, 500, err.message); }
}

// ── 静态文件服务 ──────────────────────────────────────────
function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    fail(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
          if (err2) { fail(res, 404, 'Not found'); }
          else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data2); }
        });
      } else { fail(res, 500, err.message); }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── 主服务器 ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS: 仅允许本地来源
  const origin = req.headers.origin || '';
  const allowedOrigins = ['http://localhost:' + PORT, 'http://127.0.0.1:' + PORT, 'null'];
  if (allowedOrigins.includes(origin) || origin === '') {
    res.setHeader('Access-Control-Allow-Origin', origin || ('http://localhost:' + PORT));
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname.startsWith('/api/')) {
    handleAPI(req, res, parsedUrl).catch(err => fail(res, 500, err.message));
  } else {
    serveStatic(req, res, parsedUrl.pathname);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  本地文件智能整理器 已启动');
  console.log('  访问地址: http://localhost:' + PORT);
  console.log('  绑定: 127.0.0.1 仅本地访问');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});