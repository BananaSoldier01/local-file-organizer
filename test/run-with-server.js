/**
 * run-with-server.js — 统一 Test Runner
 *
 * 职责：
 * - spawn server.js
 * - 等待 health / API ready
 * - 运行 test suite
 * - finally: terminate server
 * - 根据 test exit code 返回
 *
 * 用法：
 *   node test/run-with-server.js <test-script>
 *   NODE_ENV=test node test/run-with-server.js test/integration.js
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = parseInt(process.env.PORT) || 38211;
const HOST = '127.0.0.1';
const HEALTH_URL = `http://${HOST}:${PORT}/api/settings`;
const MAX_START_WAIT = 15000; // 15s
const POLL_INTERVAL = 200;

let serverProc = null;
let testProc = null;

function apiGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function waitForServer() {
  const start = Date.now();
  while (Date.now() - start < MAX_START_WAIT) {
    try {
      const res = await apiGet(HEALTH_URL);
      if (res.status === 200) return true;
    } catch (_) { /* retry */ }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  return false;
}

function killServer() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    // 等待进程退出
    const timer = setTimeout(() => {
      if (serverProc && serverProc.exitCode === null) {
        serverProc.kill('SIGKILL');
      }
    }, 3000);
    serverProc.on('exit', () => {
      clearTimeout(timer);
      serverProc = null;
    });
  }
}

async function main() {
  const testScript = process.argv[2];
  if (!testScript) {
    console.error('Usage: node test/run-with-server.js <test-script>');
    process.exit(2);
  }

  const testPath = path.resolve(testScript);
  const isE2E = testScript.includes('e2e');

  // 启动服务器
  const serverEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'test',
    PORT: String(PORT),
  };

  console.log(`[run-with-server] Starting server on ${HOST}:${PORT}...`);
  serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[server] ${text}`);
  });
  serverProc.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text && !text.includes('DeprecationWarning')) {
      console.error(`[server:stderr] ${text}`);
    }
  });

  serverProc.on('error', (err) => {
    console.error('[run-with-server] Server spawn error:', err.message);
    process.exit(1);
  });

  // 等待服务器就绪
  const ready = await waitForServer();
  if (!ready) {
    console.error('[run-with-server] Server failed to start within 15s');
    killServer();
    process.exit(1);
  }
  console.log('[run-with-server] Server ready.');

  // 运行测试
  const testEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
  };

  // E2E 测试需要 PLAYWRIGHT_BROWSERS_PATH
  if (isE2E) {
    testEnv.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '';
  }

  console.log(`[run-with-server] Running ${testScript}...`);

  testProc = spawn('node', [testPath], {
    env: testEnv,
    stdio: 'inherit',
  });

  let testExitCode = 0;
  testProc.on('exit', (code) => {
    testExitCode = code || 0;
  });

  testProc.on('error', (err) => {
    console.error('[run-with-server] Test spawn error:', err.message);
    testExitCode = 1;
  });

  // 等待测试完成
  await new Promise((resolve) => {
    testProc.on('exit', resolve);
    testProc.on('error', resolve);
  });

  // 清理服务器
  console.log('[run-with-server] Stopping server...');
  killServer();

  // 等待服务器完全退出
  await new Promise((resolve) => {
    const check = () => {
      if (!serverProc || serverProc.exitCode !== null) resolve();
      else setTimeout(check, 100);
    };
    check();
    setTimeout(resolve, 5000);
  });

  console.log(`[run-with-server] Done (test exit: ${testExitCode})`);
  process.exit(testExitCode);
}

// 处理未捕获的异常
process.on('uncaughtException', (err) => {
  console.error('[run-with-server] Uncaught exception:', err);
  killServer();
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.error('[run-with-server] Received SIGTERM');
  killServer();
  if (testProc) testProc.kill('SIGTERM');
  process.exit(1);
});

main().catch((err) => {
  console.error('[run-with-server] Fatal error:', err);
  killServer();
  process.exit(1);
});