/**
 * smoke.js — 基础冒烟测试
 *
 * 防止"JS 升级了但 HTML 没同步"这类发布阻断问题。
 * 检查 app.js 引用的所有 DOM ID 在 HTML 中存在。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_JS = path.join(PUBLIC_DIR, 'app.js');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function main() {
  console.log('=== Smoke Test ===\n');

  // 1. 文件存在
  console.log('1. 文件存在性:');
  check(fs.existsSync(APP_JS), 'app.js 存在');
  check(fs.existsSync(INDEX_HTML), 'index.html 存在');
  const cssPath = path.join(PUBLIC_DIR, 'styles.css');
  check(fs.existsSync(cssPath), 'styles.css 存在');

  // 2. DOM ID 交叉检查
  console.log('\n2. DOM ID 交叉检查:');
  const appContent = fs.readFileSync(APP_JS, 'utf-8');
  const htmlContent = fs.readFileSync(INDEX_HTML, 'utf-8');

  const jsIds = new Set();
  const regex = /\$\('([^']+)'\)/g;
  let m;
  while ((m = regex.exec(appContent)) !== null) {
    jsIds.add(m[1]);
  }

  const htmlIds = new Set();
  const idRegex = /id="([^"]+)"/g;
  while ((m = idRegex.exec(htmlContent)) !== null) {
    htmlIds.add(m[1]);
  }

  const missing = [...jsIds].filter(id => !htmlIds.has(id));
  check(missing.length === 0, `app.js 引用的 ${jsIds.size} 个 DOM ID 在 HTML 中都存在`);
  if (missing.length > 0) {
    console.log('    缺失:');
    missing.forEach(id => console.log(`      - ${id}`));
  }

  // 3. 关键 DOM ID 存在
  console.log('\n3. 关键 DOM ID:');
  const criticalIds = [
    'state-empty', 'state-scanning', 'state-workspace', 'state-executing', 'state-done',
    'folder-path-input', 'btn-select-folder',
    'search-input', 'btn-select-all', 'btn-exclude-selected', 'custom-target-input',
    'workspace-tbody', 'review-queue',
    'footer-count', 'footer-moves', 'footer-size',
    'btn-execute', 'btn-execute-bottom', 'btn-rescan',
    'execute-progress-fill', 'execute-text', 'execute-detail',
    'done-title', 'done-detail', 'btn-undo-last', 'btn-new-scan',
    'sidebar-stats', 'sidebar-filters',
    'sidebar-history', 'sidebar-settings',
    'history-panel', 'settings-panel', 'backdrop',
    'confirm-overlay', 'confirm-title', 'confirm-message', 'confirm-ok', 'confirm-cancel',
    'toast-container',
    'topbar-path', 'btn-settings',
    'filter-review-only', 'filter-show-excluded',
    'rq-high-count', 'rq-medium-count', 'rq-low-count',
    'stat-files', 'stat-size', 'stat-dirs', 'stat-risk',
    'setting-llm-enabled', 'setting-llm-endpoint', 'setting-llm-apikey', 'setting-llm-model',
    'setting-skip-hidden', 'setting-conflict',
    'btn-save-settings',
  ];
  let missingCritical = 0;
  for (const id of criticalIds) {
    if (!htmlIds.has(id)) {
      check(false, `关键 ID 缺失: ${id}`);
      missingCritical++;
    }
  }
  if (missingCritical === 0) {
    check(true, `所有 ${criticalIds.length} 个关键 DOM ID 存在`);
  }

  // 4. 无旧 Wizard DOM 残留
  console.log('\n4. 旧 Wizard DOM 残留检查:');
  const oldIds = ['state-results', 'state-plan', 'results-tbody', 'plan-tbody'];
  let foundOld = 0;
  for (const id of oldIds) {
    if (htmlIds.has(id)) {
      check(false, `旧 Wizard DOM 仍存在: ${id}`);
      foundOld++;
    }
  }
  if (foundOld === 0) {
    check(true, '无旧 Wizard DOM 残留');
  }

  // 5. JS 基础语法
  console.log('\n5. JS 基础语法:');
  try {
    const balancedBraces = (appContent.match(/\{/g) || []).length === (appContent.match(/\}/g) || []).length;
    const balancedParens = (appContent.match(/\(/g) || []).length === (appContent.match(/\)/g) || []).length;
    check(balancedBraces, '花括号平衡');
    check(balancedParens, '圆括号平衡');
  } catch (e) {
    check(false, '语法检查异常: ' + e.message);
  }

  // 6. 异步函数检查
  console.log('\n6. 异步函数检查:');
  const asyncFuncs = appContent.match(/async\s+function/g) || [];
  const awaitCount = (appContent.match(/await/g) || []).length;
  check(asyncFuncs.length > 0, `存在 ${asyncFuncs.length} 个 async 函数（await ${awaitCount} 处）`);

  // 7. 关键函数存在
  console.log('\n7. 关键函数存在:');
  const criticalFuncs = [
    'function startScan', 'function renderWorkspace', 'function executePlan',
    'function toggleSelectAll', 'function excludeSelected', 'function newScan',
    'function loadSettingsUI', 'function saveSettings', 'function updateReviewQueue',
    'function showConfirm', 'function toast', 'function showState',
    'function toggleFilter', 'function setFilter',
  ];
  let missingFuncs = 0;
  for (const fn of criticalFuncs) {
    if (!appContent.includes(fn)) {
      check(false, `关键函数缺失: ${fn}`);
      missingFuncs++;
    }
  }
  if (missingFuncs === 0) {
    check(true, `所有 ${criticalFuncs.length} 个关键函数存在`);
  }

  // 8. 服务器可达性
  console.log('\n8. 服务器可达性:');
  const serverCheck = new Promise(resolve => {
    const req = http.get('http://127.0.0.1:38211/api/file-types', (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
  serverCheck.then(ok => {
    check(ok, '服务器在 127.0.0.1:38211 可达');
    printSummary();
  });
}

function printSummary() {
  console.log('\n=== Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\n  ⚠️  存在问题，请修复后重新运行。');
    process.exit(1);
  } else {
    console.log('\n  ✅ 所有检查通过。');
    process.exit(0);
  }
}

main();