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
  if (pathname === '/api/pick-folder' && req.method === 'POST') {
    return await handlePickFolder(req, res);
  }
  if (pathname === '/api/classify' && req.method === 'POST') {
    return await handleClassify(req, res);
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

// 受信任的 Plan 存储：planId → { sourceRoot, moves, targetRoot, createdAt }
const planStore = new Map();

function cleanupJob(map, id, delayMs = 30000) {
  setTimeout(() => map.delete(id), delayMs);
}

function cleanupPlan(id, delayMs = 120000) {
  setTimeout(() => planStore.delete(id), delayMs);
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
          const batchResults = await classifier.classifyBatch(batch, { llm: llmConfig, context, detectProjects });
          allResults.push(...batchResults);
          job.completedBatches++;
        } catch (batchErr) {
          console.warn('[classify] batch ' + bi + ' failed:', batchErr.message);
          job.failedBatches++;
          // 单批失败不影响其他批次，继续
        }
        job.processedFiles = Math.min(files.length, (bi + 1) * BATCH_SIZE);
      }

      if (job.status !== 'cancelled') {
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
  ok(res, job.results);
}

function handleClassifyCancel(req, res) {
  const classifyId = url.parse(req.url, true).query.classifyId;
  const job = jobMaps.classify.get(classifyId);
  if (!job) return fail(res, 404, '分类任务不存在');
  if (job.status === 'running') {
    job.cancelRequested = true;
    ok(res, { cancelled: true });
  } else {
    fail(res, 400, '任务当前状态不可取消: ' + job.status);
  }
}

async function handlePlan(req, res) {
  try {
    const body = await readBody(req);
    const { files, options, sourceRoot } = body;
    if (!files) return fail(res, 400, '缺少 files');
    const plan = organizer.generatePlan(files, options);
    const validation = organizer.validatePlan(plan);

    // 存储受信任的 plan，供 execute 使用
    const planId = 'plan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    planStore.set(planId, {
      planId,
      sourceRoot: sourceRoot || null,
      moves: plan.moves,
      targetRoot: plan.targetRoot,
      createdAt: Date.now(),
    });
    cleanupPlan(planId);

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
          } else {
            job.failedCount++;
            job.failed.push({ ...move, error: result.error });
            job.completed++;
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

    // 优先使用 planId 从服务器受信任存储中获取 plan
    let plan = null;
    let sourceRoot = null;

    if (planId) {
      const stored = planStore.get(planId);
      if (!stored) return fail(res, 404, 'planId 不存在或已过期');
      plan = { moves: stored.moves, targetRoot: stored.targetRoot };
      sourceRoot = stored.sourceRoot;
    } else if (body.plan) {
      // 兼容旧版直接提交 plan（已标记为不安全，仅用于测试）
      plan = body.plan;
      sourceRoot = body.sourceRoot || null;
      console.warn('[security] 客户端直接提交 plan 而非 planId');
    } else {
      return fail(res, 400, '缺少 planId 或 plan');
    }

    // 执行前服务端路径验证
    if (sourceRoot) {
      const realRoot = fs.realpathSync(sourceRoot);
      for (const move of plan.moves) {
        const realFrom = fs.realpathSync(move.from);
        if (!realFrom.startsWith(realRoot + path.sep) && realFrom !== realRoot) {
          return fail(res, 403, '源文件路径越界: ' + move.from);
        }
        // target 不需要限制在 sourceRoot 内，但需要检查 target parent 不是 source 的子目录
        const realToParent = path.dirname(fs.realpathSync(move.to));
        if (realToParent === realRoot || realToParent.startsWith(realRoot + path.sep)) {
          // target 在 source 树内 —— 仅当 target 是分类目录时允许
          // 简单策略：target 必须在 sourceRoot 之外
          return fail(res, 403, '目标路径不能在源目录树内: ' + move.to);
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
    const { execId } = body;
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