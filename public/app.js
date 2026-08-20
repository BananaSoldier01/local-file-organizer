/**
 * app.js — 前端主逻辑
 *
 * 通过 fetch API 与本地服务器通信。
 * 状态机：empty → scanning → plan → executing → done
 */

// ── API 客户端 ────────────────────────────────────────────
const API = {
  base: '',

  async request(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    // 超时保护：10 秒
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    opts.signal = controller.signal;

    let res;
    try {
      res = await fetch(this.base + path, opts);
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        throw new Error('请求超时，请检查服务器是否运行');
      }
      throw new Error('网络错误：无法连接到服务器，请确认服务器已启动');
    }
    clearTimeout(timeoutId);

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  },

  async get(path) { return this.request('GET', path); },
  async post(path, body) { return this.request('POST', path, body); },

  // ── 选择文件夹（使用浏览器原生 directory input） ──────
  selectFolder() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.directory = true;
      input.addEventListener('change', () => {
        if (input.files && input.files.length > 0) {
          resolve(Array.from(input.files));
        } else {
          resolve(null);
        }
      });
      input.click();
    });
  },

  // ── 扫描 ──────────────────────────────────────────────
  scan(rootPath, options) { return this.post('/api/scan', { rootPath, options }); },
  pickFolder() { return this.post('/api/pick-folder', {}); },
  classify(files, config) { return this.post('/api/classify', { files, config }); },
  generatePlan(files, options) { return this.post('/api/plan', { files, options }); },
  executePlan(plan, conflictStrategy) { return this.post('/api/execute', { plan, conflictStrategy }); },
  undo(sessionId) { return this.post('/api/undo', { sessionId }); },
  getHistory(limit) { return this.get('/api/history?limit=' + (limit || 50)); },
  getHistoryStats() { return this.get('/api/history/stats'); },
  clearHistory() { return this.post('/api/history/clear'); },
  getCategories() { return this.get('/api/categories'); },
  getSettings() { return this.get('/api/settings'); },
  saveSettings(s) { return this.post('/api/settings', s); },
  checkExists(paths) { return this.post('/api/exists', { paths }); },
};

// ── 路径工具 ──────────────────────────────────────────────
const path = {
  basename: (p) => {
    if (!p) return '';
    const parts = p.split('/');
    return parts[parts.length - 1];
  },
  extname: (p) => {
    const parts = p.split('.');
    return parts.length > 1 ? '.' + parts[parts.length - 1] : '';
  },
};

// ── 工具函数 ──────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDate(ts) {
  if (!ts) return '未知';
  const date = new Date(ts);
  const now = new Date();
  const diff = now - date;
  const day = 86400000;
  if (diff < day) return '今天';
  if (diff < day * 2) return '昨天';
  if (diff < day * 7) return Math.floor(diff / day) + ' 天前';
  if (diff < day * 30) return Math.floor(diff / (day * 7)) + ' 周前';
  if (diff < day * 365) return Math.floor(diff / day) + ' 天前';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function truncatePath(p, maxLen) {
  maxLen = maxLen || 60;
  if (p.length <= maxLen) return p;
  const parts = p.split('/');
  if (parts.length <= 2) return p;
  return '\u2026/' + parts[parts.length - 2] + '/' + parts[parts.length - 1];
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── 状态 ──────────────────────────────────────────────────
const state = {
  currentFolder: null,
  files: [],
  classifiedFiles: [],
  plan: null,
  settings: null,
  currentSessionId: null,
  categories: null,
  excludedFiles: new Set(),    // 用户排除的文件路径
  customTargetRoot: null,      // 用户自定义目标根目录
};

// ── DOM 引用 ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
let states = null;

function initStates() {
  states = {
    empty: $('state-empty'),
    scanning: $('state-scanning'),
    results: $('state-results'),
    plan: $('state-plan'),
    executing: $('state-executing'),
    done: $('state-done'),
  };
}

function updateSidebarActive(stateName) {
  const items = document.querySelectorAll('.sidebar-item');
  items.forEach(item => item.classList.remove('active'));

  const catSection = $('sidebar-categories');
  const showCats = (stateName === 'results' || stateName === 'plan');
  if (catSection) catSection.style.display = showCats ? '' : 'none';

  if (stateName === 'empty') {
    const startItem = document.querySelector('.sidebar-item[data-state="empty"]');
    if (startItem) startItem.classList.add('active');
  }
}

function showState(name) {
  if (!states) return;
  for (const [key, el] of Object.entries(states)) {
    if (el) {
      el.classList.toggle('active', key === name);
    }
  }
  updateSidebarActive(name);
  const bb = $('bottombar');
  if (bb) {
    bb.style.display = (name === 'plan' || name === 'results') ? 'flex' : 'none';
  }
}

// ── Toast ─────────────────────────────────────────────────
function toast(message, type) {
  type = type || 'success';
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 2500);
}

// ── 确认弹窗 ──────────────────────────────────────────────
function showConfirm(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog">' +
      '<div class="confirm-title">' + title + '</div>' +
      '<div class="confirm-message">' + message + '</div>' +
      '<div class="confirm-actions">' +
      '<button class="btn-secondary" id="confirm-cancel">取消</button>' +
      '<button class="btn-primary" id="confirm-ok">确定</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const cleanup = () => {
      document.body.removeChild(overlay);
      document.body.style.overflow = '';
      document.removeEventListener('keydown', escHandler);
    };

    const escHandler = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve(false); }
    };

    $('confirm-ok').addEventListener('click', () => { cleanup(); resolve(true); });
    $('confirm-cancel').addEventListener('click', () => { cleanup(); resolve(false); });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve(false); }
    });
    document.addEventListener('keydown', escHandler);
  });
}

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  // 初始化 DOM 引用（确保 DOM 已就绪）
  initStates();

  try {
    const result = await API.getSettings();
    if (result.success) state.settings = result.data;
  } catch (err) {
    console.warn('[init] 加载设置失败:', err);
  }

  // 预加载分类信息
  try {
    const catResult = await API.getCategories();
    if (catResult.success) state.categories = catResult.data;
  } catch (err) {
    console.warn('[init] 加载分类失败:', err);
  }

  $('btn-select-folder').addEventListener('click', selectFolder);
  $('folder-path-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') selectFolder();
  });
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-execute').addEventListener('click', executePlan);
  $('btn-undo-last').addEventListener('click', undoLast);
  $('btn-new-scan').addEventListener('click', newScan);
  $('btn-close-history').addEventListener('click', closeHistory);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-clear-history').addEventListener('click', clearHistory);

  // 侧边栏操作
  $('sidebar-history').addEventListener('click', openHistory);

  // 全局 Escape 关闭面板
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const hp = $('history-panel');
    const sp = $('settings-panel');
    if (hp && hp.style.display === 'flex') { closeHistory(); return; }
    if (sp && sp.style.display === 'flex') { closeSettings(); return; }
  });

  // 点击遮罩关闭面板
  const backdrop = $('backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      closeHistory();
      closeSettings();
    });
  }
  $('sidebar-settings').addEventListener('click', openSettings);

  // 底部栏返回
  $('btn-back').addEventListener('click', () => {
    if (state.plan && state.plan.moves.length > 0) {
      showState('plan');
    } else {
      showState('results');
    }
  });

  // 扫描结果 → 方案
  $('btn-view-plan').addEventListener('click', () => {
    if (state.plan && state.plan.moves.length > 0) {
      renderPlan();
      showState('plan');
    } else {
      toast('正在生成方案…', 'warning');
    }
  });

  // 自定义目标根目录
  const targetInput = $('custom-target-input');
  if (targetInput) {
    targetInput.addEventListener('change', () => {
      setCustomTargetRoot(targetInput.value.trim() || null);
    });
  }

  // 扫描结果页重新扫描
  ['btn-rescan-results', 'btn-rescan-results2'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => {
      if (state.currentFolder) startScan(state.currentFolder);
    });
  });

  bindSettingsUI();
  showState('empty');
}

// ── 选择文件夹 ────────────────────────────────────────────
async function selectFolder() {
  const btn = $('btn-select-folder');
  const input = $('folder-path-input');
  if (!btn) return;

  let folderPath = (input ? input.value.trim() : '');

  // 如果输入框为空，尝试调用系统原生文件夹选择
  if (!folderPath) {
    btn.disabled = true;
    const originalText = btn.innerHTML;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.21-8.79"/><path d="M21 3v5h-5"/></svg> 选择中…';
    try {
      const result = await API.pickFolder();
      if (result.success && result.data.path) {
        folderPath = result.data.path;
        if (input) input.value = folderPath;
      } else if (result.success && result.data.canceled) {
        return; // 用户取消
      } else {
        toast('无法调用系统文件夹选择器，请手动输入路径', 'error');
        return;
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }

  if (!folderPath) {
    toast('请输入文件夹路径', 'error');
    return;
  }

  // 开始扫描
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.21-8.79"/><path d="M21 3v5h-5"/></svg> 扫描中…';

  try {
    state.currentFolder = folderPath;
    await startScan(folderPath);
  } catch (err) {
    toast('启动扫描失败: ' + err.message, 'error');
    showState('empty');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

async function newScan() {
  state.currentFolder = null;
  state.files = [];
  state.classifiedFiles = [];
  state.plan = null;
  showState('empty');
}

async function rescan() {
  if (!state.currentFolder) return;
  startScan(state.currentFolder);
}

// ── 扫描 ──────────────────────────────────────────────────
async function startScan(folder) {
  showState('scanning');
  updateScanProgress(0, '正在扫描\u2026', '已发现 0 个文件');

  // 启动扫描进度模拟（在 API 调用期间让进度动起来）
    let scanProgress = 0;
    const scanInterval = setInterval(() => {
      try {
        scanProgress += 2;
        if (scanProgress > 88) scanProgress = 88;
        updateScanProgress(scanProgress, '正在扫描\u2026', '扫描中…');
      } catch (e) {
        console.error('[scanInterval]', e.message);
      }
    }, 80);

  // 超时保护：15 秒无响应则报错
  const scanTimeout = setTimeout(() => {
    clearInterval(scanInterval);
    toast('扫描超时，请检查路径和网络', 'error');
    showState('empty');
  }, 15000);

  try {
    const options = {
      skipHidden: state.settings && state.settings.skipHidden !== undefined
        ? state.settings.skipHidden : true,
      skipDirs: (state.settings && state.settings.skipDirs) || [],
    };

    const result = await API.scan(folder, options);
    clearInterval(scanInterval);
    clearTimeout(scanTimeout);

    if (!result.success) {
      toast('扫描失败: ' + result.error, 'error');
      showState('empty');
      return;
    }

    state.files = result.data.files;
    updateScanProgress(100, '扫描完成', '已发现 ' + state.files.length + ' 个文件');

    const tp = $('topbar-path');
    if (tp) tp.innerHTML = '<span class="path-label">' + truncatePath(folder) + '</span>';
    const bp = $('bottombar-path');
    if (bp) bp.textContent = truncatePath(folder);

    setTimeout(() => classifyAndPlan(), 400);
  } catch (err) {
    clearInterval(scanInterval);
    clearTimeout(scanTimeout);
    toast('扫描出错: ' + err.message, 'error');
    showState('empty');
  }
}

function updateScanProgress(percent, text, detail) {
  const fill = $('scan-percent');
  const ring = $('scan-progress-fill');
  const textEl = $('scan-text');
  const detailEl = $('scan-detail');

  if (fill) fill.textContent = Math.round(percent) + '%';
  if (ring) {
    const circumference = 2 * Math.PI * 28;
    ring.style.strokeDasharray = circumference;
    ring.style.strokeDashoffset = circumference * (1 - percent / 100);
  }
  if (textEl) textEl.textContent = text;
  if (detailEl) detailEl.textContent = detail;
}

// ── 分类与方案 ────────────────────────────────────────────
async function classifyAndPlan() {
  try {
    const classifyResult = await API.classify(state.files, { llm: state.settings && state.settings.llm });
    if (!classifyResult.success) {
      toast('分类失败: ' + classifyResult.error, 'error');
      showState('empty');
      return;
    }
    state.classifiedFiles = classifyResult.data;
    state.excludedFiles.clear();

    // 先展示扫描结果总览
    populateSidebarCategories();
    renderScanResults();
    showState('results');

    // 同时生成方案（后台）
    const planResult = await API.generatePlan(state.classifiedFiles, {
      targetRoot: state.customTargetRoot || null,
      flatten: true,
    });
    if (planResult.success) {
      state.plan = { ...planResult.data, validation: planResult.data.validation };
    }
  } catch (err) {
    toast('处理出错: ' + err.message, 'error');
    showState('empty');
  }
}

// ── 渲染扫描结果总览 ──────────────────────────────────────
function populateSidebarCategories() {
  const list = $('sidebar-category-list');
  if (!list || !state.categories) return;
  list.innerHTML = '';

  // 统计每个分类的文件数
  const counts = {};
  for (const f of state.files) {
    const c = f.category || 'other';
    counts[c] = (counts[c] || 0) + 1;
  }

  for (const cat of state.categories) {
    const count = counts[cat.key] || 0;
    const item = document.createElement('div');
    item.className = 'sidebar-item';
    item.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:' + cat.color + '">' +
      (cat.icon ? '' : '<path d="M4 5a1 1 0 0 1 1-1h6l2 3h7a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5z"/>') +
      '</svg>' +
      '<span>' + escapeHtml(cat.label) + '</span>' +
      '<span class="count">' + count + '</span>';
    list.appendChild(item);
  }
}

function renderScanResults() {
  const table = $('scan-results-list');
  if (!table) return;

  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (state.files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-secondary);">未发现文件</td></tr>';
    return;
  }

  // 按分类分组统计
  const categoryInfo = {};
  if (state.categories) {
    for (const cat of state.categories) categoryInfo[cat.key] = cat;
  }

  let totalSize = 0;
  for (const f of state.files) totalSize += f.size || 0;

  // 统计行
  const statRow = document.createElement('tr');
  statRow.className = 'results-stat-row';
  statRow.innerHTML =
    '<td colspan="5">' +
    '<span class="results-stat">' + state.files.length + ' 个文件</span>' +
    '<span class="results-stat">·</span>' +
    '<span class="results-stat">' + formatSize(totalSize) + '</span>' +
    '<span class="results-stat">·</span>' +
    '<span class="results-stat">' + Object.keys(categoryInfo).length + ' 个分类</span>' +
    '</td>';
  tbody.appendChild(statRow);

  // 按分类分组
  const groups = {};
  for (const file of state.classifiedFiles) {
    const cat = file.category || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(file);
  }

  const sortedCats = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

  for (const [catKey, files] of sortedCats) {
    const info = categoryInfo[catKey] || { key: catKey, label: catKey, color: '#8E8E93' };
    // 分类头
    const groupRow = document.createElement('tr');
    groupRow.className = 'results-group-row';
    groupRow.style.background = info.color + '12';
    groupRow.innerHTML =
      '<td colspan="5" class="results-group-header">' +
      '<span class="results-dot" style="background:' + info.color + '"></span>' +
      '<span class="results-group-label">' + escapeHtml(info.label) + '</span>' +
      '<span class="results-group-count">' + files.length + ' 个文件</span>' +
      '</td>';
    tbody.appendChild(groupRow);

    // 文件行（最多显示 8 个，其余折叠）
    const showCount = Math.min(files.length, 8);
    for (let i = 0; i < showCount; i++) {
      tbody.appendChild(renderScanResultRow(files[i], info.color));
    }
    if (files.length > 8) {
      const moreRow = document.createElement('tr');
      moreRow.innerHTML = '<td colspan="5" class="results-more">还有 ' + (files.length - 8) + ' 个文件…</td>';
      tbody.appendChild(moreRow);
    }
  }
}

function renderScanResultRow(file, categoryColor) {
  const tr = document.createElement('tr');
  tr.className = 'results-file-row';

  const iconHtml = getFileIcon(file.name, categoryColor);

  tr.innerHTML =
    '<td class="results-icon">' + iconHtml + '</td>' +
    '<td class="results-name" title="' + escapeHtml(file.path) + '">' + escapeHtml(file.name) + '</td>' +
    '<td class="results-meta">' + formatSize(file.size) + '</td>' +
    '<td class="results-meta">' + formatDate(file.modified) + '</td>' +
    '<td class="results-dir" title="' + escapeHtml(file.dir) + '">' + escapeHtml(truncatePath(file.dir, 40)) + '</td>';

  return tr;
}

// ── 渲染方案 ──────────────────────────────────────────────
function renderPlan() {
  const plan = state.plan;
  const list = $('category-list');
  if (!list) return;

  if (!plan || plan.moves.length === 0) {
    const pe = $('plan-empty');
    if (pe) pe.style.display = 'block';
    list.innerHTML = '';
    $('btn-execute').disabled = true;
    return;
  }

  const pe2 = $('plan-empty');
  if (pe2) pe2.style.display = 'none';

  const st = $('stat-total'); if (st) st.textContent = state.files.length;
  const sc = $('stat-categories'); if (sc) sc.textContent = Object.keys(plan.summary).length;
  const sm = $('stat-moves'); if (sm) sm.textContent = plan.moves.length;

  // 目标根目录显示
  const targetRoot = state.customTargetRoot || plan.targetRoot || state.currentFolder;
  const ti = $('plan-target-info');
  if (ti) ti.textContent = '→ ' + truncatePath(targetRoot, 60);

  const groups = {};
  for (const move of plan.moves) {
    if (!groups[move.category]) groups[move.category] = [];
    groups[move.category].push(move);
  }

  // 构建分类信息映射
  const categoryInfo = {};
  if (state.categories) {
    for (const cat of state.categories) categoryInfo[cat.key] = cat;
  }

  list.innerHTML = '';
  renderCategoryGroups(groups, categoryInfo);

  $('btn-execute').disabled = false;
}

function renderCategoryGroups(groups, categoryInfo) {
  const list = $('category-list');
  if (!list) return;
  list.innerHTML = '';

  const sortedCategories = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [catKey, moves] of sortedCategories) {
    const info = categoryInfo[catKey] || { key: catKey, label: catKey, color: '#8E8E93', icon: '\ud83d\udcc4' };
    const group = renderCategoryGroup(catKey, info, moves);
    list.appendChild(group);
  }
}

function renderCategoryGroup(catKey, info, moves) {
  const group = document.createElement('div');
  group.className = 'cat-group';

  const header = document.createElement('div');
  header.className = 'cat-header';
  header.innerHTML =
    '<span class="cat-dot" style="background:' + info.color + '"></span>' +
    '<span class="cat-label">' + escapeHtml(info.label) + '</span>' +
    '<span class="cat-count">' + moves.length + ' \u4e2a\u6587\u4ef6</span>' +
    '<svg class="cat-toggle" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  header.addEventListener('click', () => {
    group.classList.toggle('collapsed');
  });
  group.appendChild(header);

  const filesContainer = document.createElement('div');
  filesContainer.className = 'cat-files';
  for (const move of moves) {
    filesContainer.appendChild(renderFileRow(move, info.color));
  }
  group.appendChild(filesContainer);

  return group;
}

function renderFileRow(move, categoryColor) {
  const template = $('template-file-row');
  const fragment = template.content.cloneNode(true);

  const icon = fragment.querySelector('.file-icon');
  icon.innerHTML = getFileIcon(move.to, categoryColor);

  const file = state.files.find(f => f.path === move.from);
  fragment.querySelector('.file-name').textContent = path.basename(move.from);

  const metaParts = [];
  if (file) {
    metaParts.push(formatSize(file.size));
    metaParts.push(formatDate(file.modified));
  }
  fragment.querySelector('.file-meta').textContent = metaParts.join(' \u00b7 ');

  // 分类选择器
  const select = fragment.querySelector('.file-category-select');
  if (state.categories) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '\u2014 \u9009\u62e9\u5206\u7c7b \u2014';
    select.appendChild(emptyOpt);

    for (const cat of state.categories) {
      const opt = document.createElement('option');
      opt.value = cat.key;
      opt.textContent = cat.label;
      if (cat.key === move.category) opt.selected = true;
      select.appendChild(opt);
    }
  }

  select.addEventListener('change', () => {
    onCategoryChange(move.from, select.value);
  });

  // 排除复选框
  const checkbox = fragment.querySelector('.file-check input');
  checkbox.checked = state.excludedFiles.has(move.from);
  checkbox.addEventListener('change', () => {
    toggleExclude(move.from);
  });

  // 分类理由
  const reasonEl = fragment.querySelector('.file-reason');
  if (move.reason) {
    reasonEl.textContent = '\ud83d\udca1 ' + move.reason;
    reasonEl.style.display = '';
  } else {
    reasonEl.style.display = 'none';
  }

  return fragment;
}

function getFileIcon(targetPath, color) {
  const ext = targetPath.split('.').pop().toLowerCase();
  const iconMap = {
    // 文档
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    docx: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    txt: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 13h6 M9 17h4',
    md: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 19l3-5 3 5 M9 9h6',
    // 图片
    jpg: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z M17 11a1 1 0 1 1-1-1 1 1 0 0 1 1 1z',
    png: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z M17 11a1 1 0 1 1-1-1 1 1 0 0 1 1 1z',
    gif: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z M17 11a1 1 0 1 1-1-1 1 1 0 0 1 1 1z',
    svg: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z M17 11a1 1 0 1 1-1-1 1 1 0 0 1 1 1z',
    // 视频
    mp4: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M10 14l4 3v-6z',
    mov: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M10 14l4 3v-6z',
    avi: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M10 14l4 3v-6z',
    mkv: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M10 14l4 3v-6z',
    // 音频
    mp3: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 19V7l10 6-10 6z',
    wav: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 19V7l10 6-10 6z',
    flac: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 19V7l10 6-10 6z',
    // 压缩文件
    zip: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    rar: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    '7z': 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    tar: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    gz: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    // 安装包
    exe: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    msi: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    dmg: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    apk: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
    // 开发资料
    js: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 13l3 3 3-3 M9 17l6 0',
    ts: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 13l3 3 3-3 M9 17l6 0',
    py: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 13l3 3 3-3 M9 17l6 0',
    html: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 15l3-3 3 3 M12 9v6',
    css: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 13c2 0 3 1 3 2s-1 2-3 2 M9 17h6',
    json: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 13h2v4H9z M13 13h2v4h-2z',
    // 临时文件
    tmp: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 9h6 M9 13h6 M9 17h4',
    bak: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 9h6 M9 13h6 M9 17h4',
    log: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M9 9h6 M9 13h6 M9 17h4',
    // 默认
    default: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4',
  };
  const d = iconMap[ext] || iconMap.default;
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="' + color +
    '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
}

// ── 执行方案 ──────────────────────────────────────────────
async function executePlan() {
  if (!state.plan || state.plan.moves.length === 0) return;

  // 执行前确认
  const confirmed = await showConfirm(
    '确认整理？',
    '将移动 <strong>' + state.plan.moves.length + '</strong> 个文件到分类目录中。\n\n' +
    '此操作可以撤销。点击「确定」开始执行，点击「取消」返回方案。'
  );
  if (!confirmed) return;

  const strategy = (state.settings && state.settings.conflictStrategy) || { overwrite: 'skip' };
  const total = state.plan.moves.length;

  showState('executing');
  const et = $('execute-text'); if (et) et.textContent = '正在整理文件\u2026';
  const ed = $('execute-detail'); if (ed) ed.textContent = '0 / ' + total;
  const pf = $('execute-progress-fill'); if (pf) pf.style.width = '0%';

  // 启动模拟进度（在 API 调用之前，让用户看到进度在动）
    let progress = 0;
    const progressInterval = setInterval(() => {
      try {
        progress += 8;
        if (progress > 85) progress = 85;
        if (ed) ed.textContent = Math.round(progress / 100 * total) + ' / ' + total;
        if (pf) pf.style.width = progress + '%';
      } catch (e) { console.error('[progressInterval]', e.message); }
    }, 25);

  try {
    const result = await API.executePlan(state.plan, strategy);
    clearInterval(progressInterval);

    if (!result.success) {
      toast('执行失败: ' + result.error, 'error');
      showState('plan');
      return;
    }

    const data = result.data;
    const doneTotal = data.success.length + data.failed.length + data.skipped.length;

    if (ed) ed.textContent = data.success.length + ' / ' + doneTotal;
    if (pf) pf.style.width = '100%';

    setTimeout(() => {
      let message = '已移动 ' + data.success.length + ' 个文件';
      if (data.skipped.length > 0) message += '\uff0c\u8df3\u8fc7 ' + data.skipped.length + ' \u4e2a';
      if (data.failed.length > 0) message += '\uff0c\u5931\u8d25 ' + data.failed.length + ' \u4e2a';

      const dt = $('done-title'); if (dt) dt.textContent = data.failed.length > 0 ? '部分完成' : '\u6574\u7406\u5b8c\u6210';
      const dd = $('done-detail'); if (dd) dd.textContent = message;
      state.currentSessionId = data.sessionId || null;
      showState('done');
    }, 600);
  } catch (err) {
    toast('执行出错: ' + err.message, 'error');
    showState('plan');
  }
}

// ── 撤销 ──────────────────────────────────────────────────
async function undoLast() {
  try {
    const result = await API.undo(state.currentSessionId);
    if (!result.success) {
      toast('撤销失败: ' + result.error, 'error');
      return;
    }
    const data = result.data;
    if (data.success > 0) toast('已撤销 ' + data.success + ' \u4e2a\u6587\u4ef6\u79fb\u52a8', 'success');
    if (data.failed > 0) toast('撤销部分失败: ' + data.failed + ' \u4e2a', 'error');
  } catch (err) {
    toast('撤销出错: ' + err.message, 'error');
  }
}

// ── 历史面板 ──────────────────────────────────────────────
async function openHistory() {
  closeSettings();
  const panel = $('history-panel');
  const backdrop = $('backdrop');
  if (panel && backdrop) {
    panel.style.display = 'flex';
    backdrop.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  await loadHistory();
}

function closeHistory() {
  const panel = $('history-panel');
  const backdrop = $('backdrop');
  if (panel) panel.style.display = 'none';
  if (backdrop) backdrop.classList.remove('active');
  document.body.style.overflow = '';
}

async function loadHistory() {
  try {
    const result = await API.getHistory(50);
    if (!result.success) return;

    const list = $('history-list');
    list.innerHTML = '';

    if (result.data.length === 0) {
      list.innerHTML = '<p style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;">\u6682\u65e0\u64cd\u4f5c\u5386\u53f2</p>';
      return;
    }

    for (const session of result.data) {
      list.appendChild(renderHistoryItem(session));
    }
  } catch (err) {
    console.warn('[history] 加载失败:', err);
  }
}

function renderHistoryItem(session) {
  const template = $('template-history-item');
  const item = template.content.cloneNode(true);

  item.querySelector('.history-item-date').textContent =
    new Date(session.timestamp).toLocaleString('zh-CN', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

  item.querySelector('.history-item-count').textContent =
    session.moves.length + ' \u4e2a\u79fb\u52a8';

  const pathEl = item.querySelector('.history-item-path');
  pathEl.textContent = session.sourceDir ? truncatePath(session.sourceDir) : '\u672a\u77e5\u4f4d\u7f6e';

  if (session.undone) {
    item.classList.add('undone');
    item.querySelector('.history-item-count').textContent += '\uff08\u5df2\u64a4\u9500\uff09';
  }

  const undoBtn = item.querySelector('.history-undo');
  if (session.undone) {
    undoBtn.textContent = '\u5df2\u64a4\u9500';
    undoBtn.disabled = true;
  } else {
    undoBtn.addEventListener('click', async () => {
      await API.undo(session.id);
      toast('\u5df2\u64a4\u9500\u8be5\u6b21\u64cd\u4f5c', 'success');
      await loadHistory();
    });
  }

  return item;
}

async function clearHistory() {
  if (!confirm('\u786e\u5b9a\u8981\u6e05\u7a7a\u6240\u6709\u64cd\u4f5c\u5386\u53f2\u5417\uff1f')) return;
  try {
    await API.clearHistory();
    toast('\u5386\u53f2\u5df2\u6e05\u7a7a', 'success');
    await loadHistory();
  } catch (err) {
    toast('清空失败: ' + err.message, 'error');
  }
}

// ── 设置面板 ──────────────────────────────────────────────
function bindSettingsUI() {
  if (state.settings) {
    $('setting-llm-enabled').checked = state.settings.llm && state.settings.llm.enabled;
    $('setting-llm-endpoint').value = (state.settings.llm && state.settings.llm.endpoint) || '';
    $('setting-llm-apikey').value = (state.settings.llm && state.settings.llm.apiKey) || '';
    $('setting-llm-model').value = (state.settings.llm && state.settings.llm.model) || 'deepseek-chat';
    $('setting-skip-hidden').checked = state.settings.skipHidden !== undefined
      ? state.settings.skipHidden : true;
    $('setting-conflict').value = (state.settings.conflictStrategy && state.settings.conflictStrategy.overwrite) || 'skip';
  }

  const llmEnabled = $('setting-llm-enabled');
  const toggleLLMFields = () => {
    const enabled = llmEnabled.checked;
    ['setting-llm-endpoint', 'setting-llm-apikey', 'setting-llm-model'].forEach(id => {
      $(id).parentElement.style.opacity = enabled ? '1' : '0.4';
      $(id).parentElement.style.pointerEvents = enabled ? 'auto' : 'none';
    });
  };
  llmEnabled.addEventListener('change', toggleLLMFields);
  toggleLLMFields();
}

function openSettings() {
  closeHistory();
  const panel = $('settings-panel');
  const backdrop = $('backdrop');
  if (panel && backdrop) {
    panel.style.display = 'flex';
    backdrop.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
}

function closeSettings() {
  const panel = $('settings-panel');
  const backdrop = $('backdrop');
  if (panel) panel.style.display = 'none';
  if (backdrop) backdrop.classList.remove('active');
  document.body.style.overflow = '';
}

async function saveSettings() {
  const newSettings = {
    llm: {
      enabled: $('setting-llm-enabled').checked,
      endpoint: $('setting-llm-endpoint').value.trim(),
      apiKey: $('setting-llm-apikey').value.trim(),
      model: $('setting-llm-model').value.trim() || 'deepseek-chat',
    },
    skipHidden: $('setting-skip-hidden').checked,
    skipDirs: (state.settings && state.settings.skipDirs) || [],
    conflictStrategy: {
      overwrite: $('setting-conflict').value,
    },
  };

  try {
    await API.saveSettings(newSettings);
    state.settings = newSettings;
    toast('设置已保存', 'success');
    closeSettings();
  } catch (err) {
    toast('保存失败: ' + err.message, 'error');
  }
}

// ── 分类变更 ──────────────────────────────────────────────
async function onCategoryChange(filePath, newCategory) {
  // 更新分类文件数据
  for (const file of state.classifiedFiles) {
    if (file.path === filePath) {
      file.category = newCategory || 'other';
      break;
    }
  }

  // 重新生成方案（调用服务端 organizer 确保 to 路径正确更新）
  try {
    const result = await API.generatePlan(state.classifiedFiles, {
      targetRoot: state.customTargetRoot || null,
      flatten: true,
    });
    if (result.success) {
      state.plan = { ...result.data, validation: result.data.validation };
      renderPlan();
    }
  } catch (err) {
    toast('重新生成方案失败: ' + err.message, 'error');
  }
}

// ── 切换文件排除 ──────────────────────────────────────────
function toggleExclude(filePath) {
  if (state.excludedFiles.has(filePath)) {
    state.excludedFiles.delete(filePath);
  } else {
    state.excludedFiles.add(filePath);
  }
  // 重新生成方案
  regeneratePlan();
}

// ── 设置自定义目标根目录 ──────────────────────────────────
async function setCustomTargetRoot(rootPath) {
  state.customTargetRoot = rootPath || null;
  await regeneratePlan();
}

// ── 重新生成方案（排除已标记文件） ────────────────────────
async function regeneratePlan() {
  if (!state.classifiedFiles.length) return;
  try {
    // 过滤掉排除的文件
    const activeFiles = state.classifiedFiles.filter(
      f => !state.excludedFiles.has(f.path)
    );
    if (activeFiles.length === 0) {
      state.plan = { moves: [], conflicts: [], summary: {}, targetRoot: null };
      renderPlan();
      return;
    }
    const result = await API.generatePlan(activeFiles, {
      targetRoot: state.customTargetRoot || null,
      flatten: true,
    });
    if (result.success) {
      state.plan = { ...result.data, validation: result.data.validation };
      renderPlan();
    }
  } catch (err) {
    toast('重新生成方案失败: ' + err.message, 'error');
  }
}

// ── 全局错误处理 ──────────────────────────────────────────
window.addEventListener('error', (e) => {
  console.error('[JS Error]', e.message, e.filename, e.lineno);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Unhandled Promise]', e.reason);
});

// ── 启动 ──────────────────────────────────────────────────
// 确保 init 在 DOM 就绪后执行，同时兼容已就绪的情况
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}