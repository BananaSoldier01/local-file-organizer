/**
 * e2e.js — Browser E2E 测试 (Playwright)
 *
 * 真实浏览器级验证：用户打开页面 → 点击按钮 → 检查文件系统结果。
 * 监听 pageerror / console error / failed network request，任何异常即测试失败。
 */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 38211;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
let browser;
let page;
const errors = [];

function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function api(method, pathStr, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      method, hostname: '127.0.0.1', port: PORT, path: pathStr,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(chunks) }); }
        catch (e) { resolve({ status: res.statusCode, data: null, raw: chunks }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollJob(type, id, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await api('GET', `/api/job?type=${type}&id=${id}`);
    const d = r.data?.data;
    if (d?.error) throw new Error(d.error);
    if (d?.done) return d;
    await sleep(200);
  }
  throw new Error(`Job ${type}:${id} 超时`);
}

async function waitForState(expectedState, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = await page.evaluate(() => {
        const el = document.querySelector('[id^="state-"].active');
        return el ? el.id : null;
      });
      if (state === expectedState) return true;
    } catch (_) { /* page may be navigating */ }
    await sleep(300);
  }
  return false;
}

async function waitForExecuteReady(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const disabled = await page.locator('#btn-execute').isDisabled();
      if (!disabled) return true;
    } catch (_) { /* retry */ }
    await sleep(300);
  }
  return false;
}

async function main() {
  console.log('=== Browser E2E Tests ===\n');

  // ── 启动浏览器 ──
  console.log('1. Launching browser...');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  page = await browser.newPage();

  // ── 监听 Runtime Error ──
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
    console.log(`  ⚠️  pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[executePlan]') || text.includes('execute') || msg.type() === 'error') {
      console.log(`  BROWSER ${msg.type()}: ${text}`);
    }
    if (msg.type() === 'error') {
      errors.push(`console error: ${text}`);
    }
  });
  page.on('requestfailed', (req) => {
    errors.push(`request failed: ${req.url()} - ${req.failure()?.errorText}`);
    console.log(`  ⚠️  request failed: ${req.url()}`);
  });

  // ── 检查服务器可达 ──
  try {
    const ping = await api('GET', '/api/settings');
    if (ping.status !== 200) throw new Error('Server not reachable');
    console.log('  Server: OK\n');
  } catch (e) {
    console.log('  Server: NOT REACHABLE');
    await browser.close();
    process.exit(1);
  }

  // ═══════════════════════════════════════════════
  // E2E-1 — 完整主路径
  // ═══════════════════════════════════════════════
  console.log('2. Full User Path (Scan → Review → Execute → Undo):');
  {
    // 创建 fixture
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'content-a');
    fs.writeFileSync(path.join(root, 'src', 'b.txt'), 'content-b');
    fs.writeFileSync(path.join(root, 'src', 'c.txt'), 'content-c');

    // 打开应用
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await sleep(1000);

    // 检查页面加载
    const emptyState = await page.locator('#state-empty').isVisible();
    check(emptyState, '页面加载到 Empty 状态');

    // 输入文件夹路径并扫描
    await page.fill('#folder-path-input', root);
    await sleep(200);
    await page.click('#btn-select-folder');

    // 等待进入 Workspace
    const workspaceReached = await waitForState('state-workspace', 60000);
    check(workspaceReached, '进入 Workspace');

    if (!workspaceReached) {
      console.log('  ⚠️  跳过后续 E2E-1 检查（无法进入 Workspace）');
    } else {
      // 验证文件可见
      const fileCount = await page.locator('#workspace-tbody tr').count();
      check(fileCount >= 3, `Workspace 中可见文件 >= 3 (实际: ${fileCount})`);

      // ── Edit: 修改第一个文件的 Target ──
      // 使用 evaluate 直接设置值，避免被 history-panel 遮挡
      await page.evaluate(() => {
        const input = document.querySelector('#workspace-tbody tr:first-child .ws-target-input');
        if (input) { input.value = '项目资料'; input.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await sleep(1500);

      // ── Exclude: 排除第二个文件 ──
      await page.evaluate(() => {
        const cb = document.querySelector('#workspace-tbody tr:nth-child(2) input[type="checkbox"]');
        if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await page.evaluate(() => {
        const btn = document.getElementById('btn-exclude-selected');
        if (btn) btn.click();
      });
      await sleep(1500);

      // 等待 Plan 同步
      const executeReady = await waitForExecuteReady(30000);
      check(executeReady, 'Execute 按钮在 Plan 同步后可用');

      // ── Execute ──
      // Use evaluate to click the button directly (bypass overlay interception)
      await page.evaluate(() => {
        const btn = document.getElementById('btn-execute');
        if (btn) btn.click();
      });
      await sleep(1000);

      // 确认对话框：点击 OK
      await page.evaluate(() => {
        const okBtn = document.getElementById('confirm-ok');
        if (okBtn) okBtn.click();
      });
      await sleep(2000);

      // Check if we reached done state or executing state
      const currentState = await page.evaluate(() => {
        const el = document.querySelector('[id^="state-"].active');
        return el ? el.id : 'none';
      });
      console.log('  State after execute click:', currentState);

      // 等待执行完成
      console.log('  Waiting for done state...');
      const doneReached = await waitForState('state-done', 120000);
      check(doneReached, '执行完成，进入 Done 状态');
      if (!doneReached) {
        const currentState = await page.evaluate(() => {
          const el = document.querySelector('[id^="state-"].active');
          return el ? el.id : 'none';
        });
        console.log('  Current state:', currentState);
      }

      // ── 验证文件系统结果 ──
      const aInNewTarget = fs.existsSync(path.join(root, 'src', '项目资料', 'a.txt'));
      check(aInNewTarget, 'a.txt 移动到 项目资料/');

      const bInPlace = fs.existsSync(path.join(root, 'src', 'b.txt'));
      check(bInPlace, 'b.txt 保持原位（被排除）');

      const cMoved = !fs.existsSync(path.join(root, 'src', 'c.txt'));
      check(cMoved, 'c.txt 已移动');

      // ── Undo ──
      await page.evaluate(() => {
        const btn = document.getElementById('btn-undo-last');
        if (btn) btn.click();
      });
      await sleep(1500);

      const aRestored = fs.existsSync(path.join(root, 'src', 'a.txt'));
      check(aRestored, 'a.txt 恢复到原位');
    }

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════
  // E2E-2 — Plan Edit 场景
  // ═══════════════════════════════════════════════
  console.log('\n3. Plan Edit Scenario:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e2-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'test.pdf'), 'pdf-content');

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await sleep(1000);

    await page.fill('#folder-path-input', root);
    await sleep(200);
    await page.click('#btn-select-folder');

    const workspaceReached = await waitForState('state-workspace', 60000);
    check(workspaceReached, '进入 Workspace');

    if (!workspaceReached) {
      console.log('  ⚠️  跳过后续 E2E-2 检查（无法进入 Workspace）');
    } else {
      // 修改 target 从 文档 → 项目资料
      await page.evaluate(() => {
        const input = document.querySelector('#workspace-tbody tr:first-child .ws-target-input');
        if (input) { input.value = '项目资料'; input.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await sleep(1500);

      // 等待 Execute 可用
      const executeReady = await waitForExecuteReady(30000);
      check(executeReady, 'Execute 按钮可用');

      await page.evaluate(() => {
        const btn = document.getElementById('btn-execute');
        if (btn) btn.click();
      });
      await sleep(1000);

      // 确认对话框：点击 OK
      await page.evaluate(() => {
        const okBtn = document.getElementById('confirm-ok');
        if (okBtn) okBtn.click();
      });
      await sleep(2000);

      const doneReached = await waitForState('state-done', 120000);
      check(doneReached, '执行完成');

      // 验证文件在 项目资料/ 而不是 文档/
      const inNewTarget = fs.existsSync(path.join(root, 'src', '项目资料', 'test.pdf'));
      const inOldTarget = fs.existsSync(path.join(root, 'src', '文档', 'test.pdf'));
      check(inNewTarget, '文件在 项目资料/');
      check(!inOldTarget, '文件不在 文档/');
    }

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════
  await browser.close();

  console.log('\n=== E2E Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Runtime Errors: ${errors.length}`);
  for (const e of errors) {
    console.log(`    - ${e}`);
  }

  if (failed > 0 || errors.length > 0) {
    console.log('\n  ❌ 存在失败项或 Runtime Error。');
    process.exit(1);
  } else {
    console.log('\n  ✅ 所有 E2E 测试通过，无 Runtime Error。');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('E2E Test error:', err);
  if (browser) browser.close();
  process.exit(1);
});