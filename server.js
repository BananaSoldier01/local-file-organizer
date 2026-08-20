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
  // 深拷贝并遮盖 API Key
  const masked = JSON.parse(JSON.stringify(settings));
  if (masked.llm && masked.llm.apiKey) {
    const key = masked.llm.apiKey;
    if (key.length > 8) {
      masked.llm.apiKey = key.slice(0, 4) + '••••••••••' + key.slice(-4);
    } else {
      masked.llm.apiKey = '••••';
    }
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
  if (pathname === '/api/pick-folder' && req.method === 'POST') {
    return await handlePickFolder(req, res);
  }
  if (pathname === '/api/classify' && req.method === 'POST') {
    return await handleClassify(req, res);
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

// ── 异步扫描 Job ──────────────────────────────────────────
const scanJobMap = new Map();

function createScanJob(rootPath, options) {
  const scanId = 'scan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const job = {
    scanId,
    status: 'preparing',       // preparing → scanning → analyzing → completed | failed | cancelled
    percent: 0,
    files: 0,
    dirs: 0,
    scannedDirs: 0,
    totalDirs: 0,
    error: null,
    result: null,
    createdAt: Date.now(),
  };

  scanJobMap.set(scanId, job);

  // 后台执行扫描
  (async () => {
    try {
      job.status = 'scanning';

      const onProgress = (p) => {
        job.files = p.files || 0;
        job.dirs = p.dirs || 0;
        job.scannedDirs = p.scanned || 0;
        job.totalDirs = p.total || 0;
        if (p.percent !== undefined) job.percent = p.percent;
        // 根据文件数估算进度（目录数可能为0时的回退方案）
        if (job.totalDirs > 0) {
          job.percent = Math.min(90, Math.round((job.scannedDirs / job.totalDirs) * 90));
        } else if (job.files > 0) {
          job.percent = Math.min(85, Math.min(85, job.files));
        }
      };

      const result = await scanner.scanDirectory(rootPath, { ...options, onProgress });

      job.status = 'analyzing';
      job.percent = 92;

      // 简单分析阶段标记
      await new Promise(r => setTimeout(r, 50));

      job.status = 'completed';
      job.percent = 100;
      job.result = result;
      job.files = result.files.length;
      job.dirs = result.stats?.totalDirs || 0;

      // 30 秒后清理
      setTimeout(() => scanJobMap.delete(scanId), 30000);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      setTimeout(() => scanJobMap.delete(scanId), 30000);
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
  const job = scanJobMap.get(scanId);
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
  const job = scanJobMap.get(scanId);
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

async function handleClassify(req, res) {
  try {
    const body = await readBody(req);
    const { files, config } = body;
    if (!files) return fail(res, 400, '缺少 files');
    const settings = loadSettings();
    const llmConfig = (config && config.llm) || settings.llm;
    const context = (config && config.context) || {};
    const detectProjects = (config && config.detectProjects) || false;
    const results = await classifier.classifyFiles(files, { llm: llmConfig, context, detectProjects });
    ok(res, results);
  } catch (err) { fail(res, 500, err.message); }
}

async function handlePlan(req, res) {
  try {
    const body = await readBody(req);
    const { files, options } = body;
    if (!files) return fail(res, 400, '缺少 files');
    const plan = organizer.generatePlan(files, options);
    const validation = organizer.validatePlan(plan);
    ok(res, { ...plan, validation });
  } catch (err) { fail(res, 500, err.message); }
}

async function handleExecute(req, res) {
  try {
    const body = await readBody(req);
    const { plan, conflictStrategy } = body;
    if (!plan) return fail(res, 400, '缺少 plan');
    const settings = loadSettings();
    const strategy = conflictStrategy || settings.conflictStrategy || { overwrite: 'skip' };
    const result = await executor.executePlan(plan, { conflictStrategy: strategy });
    let sessionId = null;
    if (result.success.length > 0) {
      sessionId = history.recordSession({
        sourceDir: plan.sourceRoot || plan.moves[0]?.from,
        targetRoot: plan.targetRoot,
        moves: result.success,
        summary: plan.summary,
        success: result.success,
        failed: result.failed,
        skipped: result.skipped,
      });
    }
    ok(res, { ...result, sessionId });
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