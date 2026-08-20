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
const zlib = require('zlib');

// ── 引擎模块 ──────────────────────────────────────────────
const scanner = require('./engine/scanner');
const classifier = require('./engine/classifier');
const organizer = require('./engine/organizer');
const executor = require('./engine/executor');
const history = require('./engine/history');

// ── 配置 ──────────────────────────────────────────────────
const PORT = process.env.PORT || 38211;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
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
  if (pathname === '/api/scan-files' && req.method === 'POST') {
    return await handleScanFiles(req, res);
  }
  if (pathname === '/api/pick-folder' && req.method === 'POST') {
    return await handlePickFolder(req, res);
  }
  if (pathname === '/api/upload' && req.method === 'POST') {
    return await handleUpload(req, res);
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
  if (pathname === '/api/settings' && req.method === 'GET') {
    return ok(res, loadSettings());
  }
  if (pathname === '/api/settings' && req.method === 'POST') {
    return await handleSaveSettings(req, res);
  }
  if (pathname === '/api/exists' && req.method === 'POST') {
    return await handleExists(req, res);
  }
  if (pathname === '/api/formatSize' && req.method === 'GET') {
    const bytes = parseInt(parsedUrl.query.bytes, 10);
    return ok(res, scanner.formatSize(bytes));
  }
  if (pathname === '/api/formatDate' && req.method === 'GET') {
    const ts = parseInt(parsedUrl.query.timestamp, 10);
    return ok(res, scanner.formatDate(ts));
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

    const result = await scanner.scanDirectory(rootPath, options);
    ok(res, result);
  } catch (err) { fail(res, 500, err.message); }
}

async function handleScanFiles(req, res) {
  try {
    const body = await readBody(req);
    const { fileList } = body;
    if (!fileList || !Array.isArray(fileList) || fileList.length === 0) {
      return fail(res, 400, '缺少文件列表');
    }
    if (fileList.length > 5000) {
      return fail(res, 400, '文件数量过多（最多 5000 个）');
    }

    // 提取源标签（从第一个文件的相对路径推断文件夹名）
    let sourceLabel = '浏览器选择的文件夹';
    if (fileList.length > 0 && fileList[0].relativePath) {
      const parts = fileList[0].relativePath.split('/');
      if (parts.length > 1) sourceLabel = parts[0];
    }

    const result = scanner.scanFileList(fileList);
    result.sourceLabel = sourceLabel;
    ok(res, result);
  } catch (err) { fail(res, 500, err.message); }
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

async function handleClassify(req, res) {
  try {
    const body = await readBody(req);
    const { files, config } = body;
    if (!files) return fail(res, 400, '缺少 files');
    const settings = loadSettings();
    const llmConfig = (config && config.llm) || settings.llm;
    const results = await classifier.classifyFiles(files, { llm: llmConfig });
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

async function handleExists(req, res) {
  try {
    const body = await readBody(req);
    const { paths: pathList } = body;
    const result = {};
    for (const p of pathList) { result[p] = fs.existsSync(p); }
    ok(res, result);
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
  res.setHeader('Access-Control-Allow-Origin', '*');
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

server.listen(PORT, () => {
  console.log('');
  console.log('  本地文件智能整理器 已启动');
  console.log('  访问地址: http://localhost:' + PORT);
  console.log('  按 Ctrl+C 停止');
  console.log('');
});