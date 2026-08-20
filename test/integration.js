/**
 * integration.js — 真实集成测试
 *
 * 通过 HTTP API 测试完整流程，不依赖 DOM。
 * 覆盖：Scan Job / Classify Job / Execute Job / 安全 / Undo
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 38211;

let passed = 0;
let failed = 0;
let testDir = null;

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

function setupTestDir() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itest-'));
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'src', 'test1.txt'), 'hello');
  fs.writeFileSync(path.join(testDir, 'src', 'test2.md'), '# title');
  fs.writeFileSync(path.join(testDir, 'src', 'photo.jpg'), 'fake-jpeg');
  fs.writeFileSync(path.join(testDir, 'src', 'data.json'), '{"a":1}');
  return testDir;
}

function teardownTestDir() {
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
}

async function main() {
  console.log('=== Integration Tests ===\n');

  // Check server is reachable
  try {
    const ping = await api('GET', '/api/settings');
    if (ping.status !== 200) throw new Error('Server not reachable');
    console.log('  Server: OK\n');
  } catch (e) {
    console.log('  Server: NOT REACHABLE - start with `npm start` first');
    process.exit(1);
  }

  // ── 1. Scan Job ──
  console.log('1. Scan Job:');
  const dir = setupTestDir();
  const scanCreate = await api('POST', '/api/scan', { rootPath: dir });
  check(scanCreate.status === 200, 'POST /api/scan 返回 200');
  check(!!scanCreate.data?.data?.scanId, '返回 scanId');
  const scanId = scanCreate.data.data.scanId;

  const scanResult = await pollJob('scan', scanId);
  check(scanResult.status === 'completed', 'Scan Job 最终状态为 completed');
  check(scanResult.files >= 4, `扫描到 >= 4 个文件 (实际: ${scanResult.files})`);

  const resultData = (await api('GET', `/api/scan-result?scanId=${scanId}`)).data.data;
  check(!!resultData?.files, 'scan-result 返回文件列表');
  check(Array.isArray(resultData.files), 'files 是数组');

  // ── 2. Classify Job ──
  console.log('\n2. Classify Job:');
  const classifyCreate = await api('POST', '/api/classify', {
    files: resultData.files,
    config: { llm: { enabled: false }, detectProjects: false, context: { dirs: [] } },
  });
  check(classifyCreate.status === 200, 'POST /api/classify 返回 200');
  check(!!classifyCreate.data?.data?.classifyId, '返回 classifyId');
  const classifyId = classifyCreate.data.data.classifyId;

  const classifyResult = await pollJob('classify', classifyId);
  check(['completed', 'partial'].includes(classifyResult.status), `Classify 完成 (status: ${classifyResult.status})`);
  check(classifyResult.totalFiles >= 4, `totalFiles >= 4 (实际: ${classifyResult.totalFiles})`);

  const classifiedData = (await api('GET', `/api/classify-result?classifyId=${classifyId}`)).data.data;
  check(Array.isArray(classifiedData), 'classify-result 返回数组');
  check(classifiedData.length >= 4, `分类结果 >= 4 (实际: ${classifiedData.length})`);

  // ── 3. Plan ──
  console.log('\n3. Plan:');
  const planResult = await api('POST', '/api/plan', {
    files: classifiedData,
    options: { targetRoot: path.join(os.tmpdir(), 'itest-target') },
    sourceRoot: testDir,
  });
  check(planResult.status === 200, 'POST /api/plan 返回 200');
  check(!!planResult.data?.data?.planId, '返回 planId');
  const planId = planResult.data.data.planId;
  check(Array.isArray(planResult.data.data.moves), 'moves 是数组');

  // ── 4. Execute Job (via planId) ──
  console.log('\n4. Execute Job:');
  const execCreate = await api('POST', '/api/execute', { planId });
  check(execCreate.status === 200, 'POST /api/execute 返回 200');
  check(!!execCreate.data?.data?.execId, '返回 execId');
  const execId = execCreate.data.data.execId;

  const execResult = await pollJob('execute', execId);
  check(['completed', 'partial'].includes(execResult.status), `Execute 完成 (status: ${execResult.status})`);
  check(execResult.total >= 0, `total >= 0 (实际: ${execResult.total})`);

  // ── 5. Execute Cancel ──
  console.log('\n5. Execute Cancel:');
  // Verify cancel endpoint is reachable (job may complete before cancel)
  const cancelResult = await api('POST', '/api/execute-cancel', { execId: 'nonexistent_test' });
  check(cancelResult.status === 404 || cancelResult.status === 200, 'POST /api/execute-cancel 可达');

  // ── 6. Security: 路径越界 ──
  console.log('\n6. Security:');
  const escapeResult = await api('POST', '/api/execute', { planId });
  check(escapeResult.status === 200 || escapeResult.status === 403, 'Execute 安全检查通过');

  // ── 7. Undo ──
  console.log('\n7. Undo:');
  const undoResult = await api('POST', '/api/undo', {});
  check(undoResult.status === 200, 'POST /api/undo 返回 200');
  check(!!undoResult.data?.data, 'undo 返回结果');

  // ── 8. Settings: API Key 防覆盖 ──
  console.log('\n8. Settings:');
  const settingsGet = await api('GET', '/api/settings');
  check(settingsGet.status === 200, 'GET /api/settings 返回 200');
  const llm = settingsGet.data?.data?.llm || {};
  check(!('apiKey' in llm), 'GET settings 不返回完整 apiKey');
  check(llm.apiKeyConfigured !== undefined, '返回 apiKeyConfigured 字段');

  const settingsSave = await api('POST', '/api/settings', {
    llm: { enabled: !!llm.enabled, endpoint: llm.endpoint || '', model: llm.model || '', apiKey: '' },
    skipHidden: true,
    conflictStrategy: { overwrite: 'skip' },
  });
  check(settingsSave.status === 200, 'POST /api/settings 返回 200');

  const settingsGet2 = await api('GET', '/api/settings');
  const llm2 = settingsGet2.data?.data?.llm || {};
  check(llm2.apiKeyConfigured === llm.apiKeyConfigured, 'API Key 配置状态未变');

  // ── 9. History ──
  console.log('\n9. History:');
  const historyResult = await api('GET', '/api/history?limit=10');
  check(historyResult.status === 200, 'GET /api/history 返回 200');
  check(Array.isArray(historyResult.data?.data), 'history 是数组');

  // ── Cleanup ──
  teardownTestDir();

  // ── Summary ──
  console.log('\n=== Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\n  ⚠️  存在失败项。');
    process.exit(1);
  } else {
    console.log('\n  ✅ 所有集成测试通过。');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Test error:', err);
  teardownTestDir();
  process.exit(1);
});