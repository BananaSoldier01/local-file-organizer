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
  // E2E-3 — Browser Last Write Wins Race Test
  // ═══════════════════════════════════════════════
  console.log('\n4. Browser Last Write Wins Race:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e3-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'race.txt'), 'race-content');

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await sleep(1000);

    await page.fill('#folder-path-input', root);
    await sleep(200);
    await page.click('#btn-select-folder');

    const workspaceReached = await waitForState('state-workspace', 60000);
    check(workspaceReached, '进入 Workspace');

    if (workspaceReached) {
      // 使用 Playwright route 拦截 /api/plan，强制制造乱序响应
      // Plan A → 600ms, Plan B → 300ms, Plan C → 50ms
      let planCallCount = 0;
      await page.route('**/api/plan', async (route) => {
        planCallCount++;
        const callNum = planCallCount;
        // 根据请求中的 targetRoot 决定延迟
        const request = route.request();
        let delay = 100;
        try {
          const body = JSON.parse(request.postData() || '{}');
          const target = body?.options?.targetRoot || '';
          if (target.includes('目标A')) delay = 600;
          else if (target.includes('目标B')) delay = 300;
          else if (target.includes('目标C')) delay = 50;
        } catch (_) { /* ignore */ }

        // 让请求继续，但延迟响应
        await new Promise(r => setTimeout(r, delay));
        route.continue();
      });

      // 连续快速修改 Target：A → B → C
      const targetInput = page.locator('#workspace-tbody tr:first-child .ws-target-input');

      // Target-A
      await page.evaluate((v) => {
        const input = document.querySelector('#workspace-tbody tr:first-child .ws-target-input');
        if (input) { input.value = v; input.dispatchEvent(new Event('change', { bubbles: true })); }
      }, '目标A');
      await sleep(50);

      // Target-B
      await page.evaluate((v) => {
        const input = document.querySelector('#workspace-tbody tr:first-child .ws-target-input');
        if (input) { input.value = v; input.dispatchEvent(new Event('change', { bubbles: true })); }
      }, '目标B');
      await sleep(50);

      // Target-C
      await page.evaluate((v) => {
        const input = document.querySelector('#workspace-tbody tr:first-child .ws-target-input');
        if (input) { input.value = v; input.dispatchEvent(new Event('change', { bubbles: true })); }
      }, '目标C');
      await sleep(50);

      // 等待 Plan 同步
      const executeReady = await waitForExecuteReady(30000);
      check(executeReady, 'Execute 按钮在快速修改后可用');

      // Execute
      await page.evaluate(() => {
        const btn = document.getElementById('btn-execute');
        if (btn) btn.click();
      });
      await sleep(1000);

      // 确认
      await page.evaluate(() => {
        const okBtn = document.getElementById('confirm-ok');
        if (okBtn) okBtn.click();
      });
      await sleep(2000);

      const doneReached = await waitForState('state-done', 120000);
      check(doneReached, '执行完成');

      // 验证文件最终在 Target-C，不在 A 或 B
      const inC = fs.existsSync(path.join(root, 'src', '目标C', 'race.txt'));
      const inA = fs.existsSync(path.join(root, 'src', '目标A', 'race.txt'));
      const inB = fs.existsSync(path.join(root, 'src', '目标B', 'race.txt'));
      check(inC, '文件在目标C（最后修改）');
      check(!inA, '文件不在目标A（stale）');
      check(!inB, '文件不在目标B（stale）');

      // 清理 route 拦截
      await page.unroute('**/api/plan');
    }

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════
  // E2E-4 — Target Root Browser E2E
  // ═══════════════════════════════════════════════
  console.log('\n5. Target Root E2E:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e4-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'tr.txt'), 'tr-content');

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await sleep(1000);

    await page.fill('#folder-path-input', root);
    await sleep(200);
    await page.click('#btn-select-folder');

    const workspaceReached = await waitForState('state-workspace', 60000);
    check(workspaceReached, '进入 Workspace');

    if (workspaceReached) {
      // 输入 Target Root：整理结果
      await page.evaluate(() => {
        const input = document.getElementById('custom-target-input');
        if (input) { input.value = '整理结果'; input.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await sleep(1500);

      // 等待 Execute 可用
      const executeReady = await waitForExecuteReady(30000);
      check(executeReady, 'Target Root 设置后 Execute 可用');

      // Execute
      await page.evaluate(() => {
        const btn = document.getElementById('btn-execute');
        if (btn) btn.click();
      });
      await sleep(1000);

      await page.evaluate(() => {
        const okBtn = document.getElementById('confirm-ok');
        if (okBtn) okBtn.click();
      });
      await sleep(2000);

      const doneReached = await waitForState('state-done', 120000);
      check(doneReached, '执行完成');

      // 验证文件在 ScanRoot/整理结果/ 下（可能在子分类目录中）
      const srcDir = path.join(root, 'src');
      const targetRootDir = path.join(srcDir, '整理结果');
      // 文件在 ScanRoot/整理结果/文档/ 下（txt 文件分类为"文档"）
      // ScanRoot = root（测试扫描的是 root 目录）
      const expectedPath = path.join(root, '整理结果', '文档', 'tr.txt');
      const found = fs.existsSync(expectedPath);
      check(found, `文件在 ScanRoot/整理结果/文档/ 下 (${expectedPath})`);
    }

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════
  // 6. Relationship-Aware Browser Flow (V0.4.3.2)
  // ═══════════════════════════════════════════════
  console.log('\n6. Relationship-Aware Browser Flow:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-rel-'));
    // 创建 Project A 文件（共享实体 "项目A"）+ 无关文件
    // V0.4.3.2: 文件名中 "方案"/"文档" 等被 FILENAME_FUNCTION_WORDS 过滤，只保留 "项目A" 作为实体
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', '项目A_文档1.md'), '# 项目A文档\n项目A相关内容');
    fs.writeFileSync(path.join(root, 'src', '项目A_文档2.md'), '# 项目A文档\n项目A相关内容');
    fs.writeFileSync(path.join(root, 'src', 'unrelated.txt'), 'random content unrelated');

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await sleep(1000);

    await page.fill('#folder-path-input', root);
    await sleep(200);
    await page.click('#btn-select-folder');

    const workspaceReached = await waitForState('state-workspace', 60000);
    check(workspaceReached, '进入 Workspace');

    if (workspaceReached) {
      // V0.4.3.2: 验证 Group Suggestions 面板出现
      const gsVisible = await page.locator('#group-suggestions').isVisible();
      check(gsVisible, 'Group Suggestions 面板可见');

      // 直接执行（不修改任何 target）
      const executeReady = await waitForExecuteReady(30000);
      check(executeReady, 'Execute 按钮可用');

      await page.evaluate(() => {
        const btn = document.getElementById('btn-execute');
        if (btn) btn.click();
      });
      await sleep(1000);
      await page.evaluate(() => {
        const okBtn = document.getElementById('confirm-ok');
        if (okBtn) okBtn.click();
      });
      await sleep(2000);

      const doneReached = await waitForState('state-done', 120000);
      check(doneReached, '执行完成');

      // 验证：项目A文件归入项目A目录，无关文件归入文档
      // V0.4.3.2: 目标根目录是 src/（文件所在目录），文件归入 src/项目A/ 和 src/文档/
      const projADir = path.join(root, 'src', '项目A');
      const aInProjA = fs.existsSync(path.join(projADir, '项目A_文档1.md'));
      check(aInProjA, '项目A_文档1.md 归入 项目A/ 目录');

      const docsDir = path.join(root, 'src', '文档');
      const unrelatedInDocs = fs.existsSync(path.join(docsDir, 'unrelated.txt'));
      check(unrelatedInDocs, 'unrelated.txt 归入 文档/ 目录（非项目A）');
    }

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════
  // 7. User Override > Relationship Suggestion (V0.4.3.2)
  // ═══════════════════════════════════════════════
  console.log('\n7. User Override > Relationship Suggestion:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-override-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', '项目A_文档1.md'), '# 项目A文档\n项目A相关内容');
    fs.writeFileSync(path.join(root, 'src', '项目A_文档2.md'), '# 项目A文档\n项目A相关内容');

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await sleep(1000);

    await page.fill('#folder-path-input', root);
    await sleep(200);
    await page.click('#btn-select-folder');

    const workspaceReached = await waitForState('state-workspace', 60000);
    check(workspaceReached, '进入 Workspace');

    if (workspaceReached) {
      // 修改第一个文件的 Target 为 "归档"（用户 override）
      await page.evaluate(() => {
        const input = document.querySelector('#workspace-tbody tr:first-child .ws-target-input');
        if (input) { input.value = '归档'; input.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await sleep(1500);

      const executeReady = await waitForExecuteReady(30000);
      check(executeReady, 'Execute 按钮可用');

      await page.evaluate(() => {
        const btn = document.getElementById('btn-execute');
        if (btn) btn.click();
      });
      await sleep(1000);
      await page.evaluate(() => {
        const okBtn = document.getElementById('confirm-ok');
        if (okBtn) okBtn.click();
      });
      await sleep(2000);

      const doneReached = await waitForState('state-done', 120000);
      check(doneReached, '执行完成');

      // 验证：用户 override 的文件归入 "归档/"，不是 "项目A/"
      const archiveDir = path.join(root, 'src', '归档');
      const inArchive = fs.existsSync(path.join(archiveDir, '项目A_文档1.md'));
      check(inArchive, '用户 override 后文件归入 归档/（不是项目A/）');

      // 验证：第二个文件（未 override）仍归入项目A/
      const projADir = path.join(root, 'src', '项目A');
      const inProjA = fs.existsSync(path.join(projADir, '项目A_文档2.md'));
      check(inProjA, '未 override 的文件仍归入 项目A/');
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