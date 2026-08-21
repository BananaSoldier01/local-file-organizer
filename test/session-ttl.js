/**
 * session-ttl.js — Session Idle TTL 测试
 *
 * 验证：
 * - Test A: touch 延长生命周期（wait < TTL → touch → wait → 仍有效）
 * - Test B: idle 后过期（不 touch → wait > TTL → expired）
 *
 * 使用短 TTL（500ms）避免真实等待 30 分钟。
 * 此测试启动独立服务器实例。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SHORT_TTL_MS = 500;
const TEST_PORT = 38212; // 使用不同端口避免冲突

let passed = 0;
let failed = 0;
let server;

function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function api(method, pathStr, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      method, hostname: '127.0.0.1', port: TEST_PORT, path: pathStr,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(chunks) }); }
        catch (e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== Session Idle TTL Tests ===\n');

  // 启动使用短 TTL 的测试服务器
  console.log('1. Starting test server (TTL=' + SHORT_TTL_MS + 'ms)...');
  server = spawn('node', ['server.js'], {
    env: { ...process.env, NODE_ENV: 'test', SESSION_IDLE_TTL_MS: String(SHORT_TTL_MS), PORT: String(TEST_PORT) },
    cwd: __dirname + '/..',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverReady = false;
  const stdoutLines = [];
  const stderrLines = [];

  server.stdout.on('data', (data) => {
    const text = data.toString();
    stdoutLines.push(text);
    if (text.includes('已启动')) serverReady = true;
  });
  server.stderr.on('data', (data) => {
    stderrLines.push(data.toString());
  });

  // 等待服务器启动
  for (let i = 0; i < 30; i++) {
    if (serverReady) break;
    await sleep(200);
  }

  if (!serverReady) {
    console.log('  Server stderr:', stderrLines.join('').slice(0, 500));
    console.log('  Server stdout:', stdoutLines.join('').slice(0, 500));
    console.log('  ❌ 服务器启动失败');
    server.kill();
    process.exit(1);
  }

  console.log('  Server: OK\n');

  // ── Test A: touch 延长生命周期 ──
  console.log('2. Test A — Touch extends session:');
  {
    // 创建 scan session
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttl-a-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'test');

    const scanRes = await api('POST', '/api/scan', { rootPath: root });
    const scanId = scanRes.data.data.scanId;
    check(scanRes.status === 200, `Scan 创建成功 (scanId: ${scanId})`);

    // 等待 < TTL（400ms < 500ms）
    await sleep(400);

    // 验证 scanId 仍然有效（通过 /api/plan 请求 touch）
    const planRes = await api('POST', '/api/plan', {
      files: [{ path: path.join(root, 'a.txt'), name: 'a.txt', dir: root, size: 4, modified: Date.now() }],
      options: { targetRoot: path.join(root, 'out') },
      scanId,
    });
    check(planRes.status === 200, `Touch 后 Plan 请求成功 (实际: ${planRes.status})`);

    // 再等 < TTL（400ms < 500ms），验证仍然有效
    await sleep(400);
    const planRes2 = await api('POST', '/api/plan', {
      files: [{ path: path.join(root, 'a.txt'), name: 'a.txt', dir: root, size: 4, modified: Date.now() }],
      options: { targetRoot: path.join(root, 'out2') },
      scanId,
    });
    check(planRes2.status === 200, `Touch 后再次 Plan 请求成功 (实际: ${planRes2.status})`);

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── Test B: idle 后过期 ──
  console.log('\n3. Test B — Idle expiration:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttl-b-'));
    fs.writeFileSync(path.join(root, 'b.txt'), 'test');

    const scanRes = await api('POST', '/api/scan', { rootPath: root });
    const scanId = scanRes.data.data.scanId;
    check(scanRes.status === 200, `Scan 创建成功`);

    // 等待 > TTL（600ms > 500ms），不 touch
    await sleep(600);

    // 验证 scanId 已过期
    const planRes = await api('POST', '/api/plan', {
      files: [{ path: path.join(root, 'b.txt'), name: 'b.txt', dir: root, size: 4, modified: Date.now() }],
      options: { targetRoot: path.join(root, 'out') },
      scanId,
    });
    check(planRes.status === 404 || planRes.status === 400,
      `Idle 后 Scan 已过期 (实际: ${planRes.status})`);

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── Cleanup ──
  server.kill();
  await sleep(500);

  console.log('\n=== Session TTL Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\n  ❌ 存在失败项。');
    process.exit(1);
  } else {
    console.log('\n  ✅ 所有 Session TTL 测试通过。');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Session TTL Test error:', err);
  if (server) server.kill();
  process.exit(1);
});