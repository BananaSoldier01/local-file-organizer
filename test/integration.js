/**
 * integration.js — 真实集成测试
 *
 * 每个测试必须定义正确行为，只有正确行为发生才 PASS。
 * 禁止 "200 或 403 都 PASS" / "total >= 0" 等面向通过率的写法。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = 38211;

let passed = 0;
let failed = 0;

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

async function fullPipeline(rootPath, targetRoot, detectProjects = false) {
  // V0.3.4: targetRoot 必须在 scan root 内（安全策略）
  // 如果 targetRoot 不在 rootPath 内，自动使用 rootPath 内的子目录
  let effectiveTargetRoot = targetRoot;
  if (targetRoot && !targetRoot.startsWith(rootPath)) {
    effectiveTargetRoot = path.join(rootPath, '整理结果');
  }

  const scanRes = await api('POST', '/api/scan', { rootPath });
  const scanId = scanRes.data.data.scanId;
  await pollJob('scan', scanId);
  const scanData = (await api('GET', `/api/scan-result?scanId=${scanId}`)).data.data;

  const clsRes = await api('POST', '/api/classify', {
    files: scanData.files,
    config: { llm: { enabled: false }, detectProjects, context: { dirs: [] } },
  });
  const clsId = clsRes.data.data.classifyId;
  await pollJob('classify', clsId);
  const clsData = (await api('GET', `/api/classify-result?classifyId=${clsId}`)).data.data;
  const classified = clsData.results || clsData;

  const planRes = await api('POST', '/api/plan', {
    files: classified,
    options: { targetRoot: effectiveTargetRoot },
    scanId,
  });
  const planId = planRes.data.data.planId;
  const plan = planRes.data.data;

  return { scanId, planId, plan, classified, effectiveTargetRoot };
}

function setupFiles(dir, count, prefix = 'file') {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, `${prefix}-${i}.txt`), `content-${i}`);
  }
}

async function main() {
  console.log('=== Integration Tests ===\n');

  try {
    const ping = await api('GET', '/api/settings');
    if (ping.status !== 200) throw new Error('Server not reachable');
    console.log('  Server: OK\n');
  } catch (e) {
    console.log('  Server: NOT REACHABLE');
    process.exit(1);
  }

  // ═══════════════════════════════════════════════
  // 1. Scan Job
  // ═══════════════════════════════════════════════
  console.log('1. Scan Job:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itest-'));
  setupFiles(path.join(dir, 'src'), 5);
  fs.mkdirSync(path.join(dir, 'src', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'sub', 'nested.txt'), 'nested');

  const scanCreate = await api('POST', '/api/scan', { rootPath: dir });
  check(scanCreate.status === 200, 'POST /api/scan 返回 200');
  const scanId = scanCreate.data.data.scanId;

  const scanResult = await pollJob('scan', scanId);
  check(scanResult.status === 'completed', 'Scan completed');
  check(scanResult.files >= 6, `files >= 6 (实际: ${scanResult.files})`);
  check(scanResult.totalDirs >= 2, `totalDirs >= 2 (实际: ${scanResult.totalDirs})`);

  const resultData = (await api('GET', `/api/scan-result?scanId=${scanId}`)).data.data;
  check(resultData.files.length >= 6, `文件数 >= 6 (实际: ${resultData.files.length})`);

  // ═══════════════════════════════════════════════
  // 2. Classify Job
  // ═══════════════════════════════════════════════
  console.log('\n2. Classify Job:');
  const classifyCreate = await api('POST', '/api/classify', {
    files: resultData.files,
    config: { llm: { enabled: false }, detectProjects: true, context: { dirs: [] } },
  });
  check(classifyCreate.status === 200, 'POST /api/classify 返回 200');
  const classifyId = classifyCreate.data.data.classifyId;

  const classifyResult = await pollJob('classify', classifyId);
  check(['completed', 'partial'].includes(classifyResult.status), `Classify 完成 (status: ${classifyResult.status})`);

  const classifyData = (await api('GET', `/api/classify-result?classifyId=${classifyId}`)).data.data;
  const classifiedFiles = classifyData.results || classifyData;
  check(Array.isArray(classifiedFiles), 'classify results 是数组');
  check(classifiedFiles.length >= 6, `分类结果 >= 6 (实际: ${classifiedFiles.length})`);
  check(!!classifiedFiles[0]?.path, '分类结果包含 path 字段');

  // ═══════════════════════════════════════════════
  // 3. Plan (使用 scanId)
  // ═══════════════════════════════════════════════
  console.log('\n3. Plan:');
  // V0.3.4: targetRoot 必须在 scan root 内
  const targetRoot = path.join(dir, '整理结果');
  const planResult = await api('POST', '/api/plan', {
    files: classifiedFiles,
    options: { targetRoot },
    scanId,
  });
  check(planResult.status === 200, 'POST /api/plan 返回 200');
  check(!!planResult.data?.data?.planId, '返回 planId');
  const planId = planResult.data.data.planId;
  check(Array.isArray(planResult.data.data.moves), 'moves 是数组');
  const planData = planResult.data.data;

  // ═══════════════════════════════════════════════
  // 4. Execute (只接受 planId)
  // ═══════════════════════════════════════════════
  console.log('\n4. Execute Job:');

  const noPlanId = await api('POST', '/api/execute', { conflictStrategy: { overwrite: 'skip' } });
  check(noPlanId.status === 400, `不带 planId 被拒绝 (实际: ${noPlanId.status})`);

  const badPlanId = await api('POST', '/api/execute', { planId: 'plan_nonexistent' });
  check(badPlanId.status === 404, `不存在 planId 被拒绝 (实际: ${badPlanId.status})`);

  const directPlan = await api('POST', '/api/execute', {
    plan: { moves: [{ from: '/etc/passwd', to: '/tmp/hacked' }], targetRoot: '/tmp' },
  });
  check(directPlan.status === 400, `body.plan 后门被拒绝 (实际: ${directPlan.status})`);

  const execCreate = await api('POST', '/api/execute', { planId });
  check(execCreate.status === 200, 'POST /api/execute 返回 200');
  const execId = execCreate.data.data.execId;

  const execResult = await pollJob('execute', execId);
  check(['completed', 'partial'].includes(execResult.status), `Execute 完成 (status: ${execResult.status})`);

  if (planData.moves.length > 0) {
    const firstMove = planData.moves[0];
    check(!fs.existsSync(firstMove.from), `源文件已移动: ${firstMove.from}`);
    check(fs.existsSync(firstMove.to), `目标文件存在: ${firstMove.to}`);
  }

  // ═══════════════════════════════════════════════
  // 5. Execute Cancel (真实中断)
  // ═══════════════════════════════════════════════
  console.log('\n5. Execute Cancel:');

  const cancelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-'));
  fs.mkdirSync(path.join(cancelDir, 'src'), { recursive: true });
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(path.join(cancelDir, 'src', `cfile-${i}.txt`), `content-${i}`);
  }
  const cancelTarget = path.join(os.tmpdir(), 'cancel-target-' + Date.now());

  const cancelPipeline = await fullPipeline(cancelDir, cancelTarget, false);
  const cancelPlanId = cancelPipeline.planId;
  const cancelPlan = cancelPipeline.plan;
  check(cancelPlan.moves.length > 0, `cancel plan moves > 0 (实际: ${cancelPlan.moves.length})`);

  const cancelExec = await api('POST', '/api/execute', { planId: cancelPlanId });
  const cancelExecId = cancelExec.data.data.execId;
  check(!!cancelExecId, 'cancel execute 返回 execId');

  // 快速轮询，一旦有进度就取消
  let cancelled = false;
  for (let i = 0; i < 1000; i++) {
    const r = await api('GET', `/api/job?type=execute&id=${cancelExecId}`);
    const state = r.data?.data;
    if (!state) break;
    // 在 running 或 queued 状态时尝试取消
    if ((state.status === 'running' || state.status === 'queued') && state.completed > 0 && state.completed < state.total && !cancelled) {
      const cancelRes = await api('POST', '/api/execute-cancel', { id: cancelExecId });
      check(cancelRes.status === 200, `execute-cancel 返回 200 (实际: ${cancelRes.status})`);
      cancelled = true;
    }
    if (state.done) break;
    await sleep(5);
  }

  const finalState = await pollJob('execute', cancelExecId, 10000);
  check(finalState.status === 'cancelled_partial', `取消后状态 (实际: ${finalState.status})`);
  check(finalState.completed > 0, `已完成 move > 0 (实际: ${finalState.completed})`);
  check(finalState.completed < finalState.total, `未完成 move > 0 (${finalState.completed} < ${finalState.total})`);

  // ═══════════════════════════════════════════════
  // 6. Security (通过 test-security 端点)
  // ═══════════════════════════════════════════════
  console.log('\n6. Security:');

  // 6a. 合法：root 内整理
  {
    const secDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
    setupFiles(secDir, 3, 'sec');
    const secTarget = path.join(secDir, '整理结果');
    const { planId: secPlanId } = await fullPipeline(secDir, secTarget, false);
    const secExec = await api('POST', '/api/execute', { planId: secPlanId });
    check(secExec.status === 200, `合法 root 内整理: execute 成功 (实际: ${secExec.status})`);
    await pollJob('execute', secExec.data.data.execId, 10000);
    fs.rmSync(secDir, { recursive: true, force: true });
  }

  // 6b. traversal: ../ 逃逸（通过 test-security 端点）
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trav-'));
    setupFiles(root, 1, 'trav');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    const secRes = await api('POST', '/api/test-security', {
      moves: [{ from: path.join(root, 'trav-0.txt'), to: path.join(root, '..', 'outside', 'trav-0.txt') }],
      sourceRoot: root,
    });
    check(secRes.status === 200, 'test-security 端点可达');
    check(secRes.data.data.allSafe === false, `traversal 逃逸被拒绝 (allSafe=${secRes.data.data.allSafe})`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  // 6c. source outside root
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside2-'));
    setupFiles(outside, 1, 'secret');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inside-'));
    const secRes = await api('POST', '/api/test-security', {
      moves: [{ from: path.join(outside, 'secret-0.txt'), to: path.join(root, 'secret-0.txt') }],
      sourceRoot: root,
    });
    check(secRes.data.data.allSafe === false, `source outside root 被拒绝 (allSafe=${secRes.data.data.allSafe})`);
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 6d. prefix collision
  {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-'));
    const rootA = path.join(prefix, 'a');
    setupFiles(rootA, 1, 'afile');
    const rootAbc = path.join(prefix, 'abc');
    setupFiles(rootAbc, 1, 'bcfile');
    const secRes = await api('POST', '/api/test-security', {
      moves: [{ from: path.join(rootAbc, 'bcfile-0.txt'), to: path.join(prefix, 'target', 'bcfile-0.txt') }],
      sourceRoot: rootA,
    });
    check(secRes.data.data.allSafe === false, `prefix collision 被拒绝 (allSafe=${secRes.data.data.allSafe})`);
    fs.rmSync(prefix, { recursive: true, force: true });
  }

  // 6e. symlink escape
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-'));
    setupFiles(root, 1, 'sym');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outsidesym-'));
    fs.symlinkSync(outside, path.join(root, 'escape-link'));
    const secRes = await api('POST', '/api/test-security', {
      moves: [{ from: path.join(root, 'sym-0.txt'), to: path.join(root, 'escape-link', 'sym-0.txt') }],
      sourceRoot: root,
    });
    check(secRes.data.data.allSafe === false, `symlink escape 被拒绝 (allSafe=${secRes.data.data.allSafe})`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════
  // 7. Undo (真实验证)
  // ═══════════════════════════════════════════════
  console.log('\n7. Undo:');
  // 使用主 execute 的 sessionId
  const mainSessionId = execResult.sessionId;
  const undoResult = await api('POST', '/api/undo', { sessionId: mainSessionId });
  check(undoResult.status === 200, 'POST /api/undo 返回 200');
  check(!!undoResult.data?.data, 'undo 返回结果');

  if (planData.moves.length > 0) {
    const firstMove = planData.moves[0];
    check(fs.existsSync(firstMove.from), `撤销后源文件恢复: ${firstMove.from}`);
    check(!fs.existsSync(firstMove.to), `撤销后目标文件清除: ${firstMove.to}`);
  }

  // ═══════════════════════════════════════════════
  // 8. Settings
  // ═══════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════
  // 9. History
  // ═══════════════════════════════════════════════
  console.log('\n9. History:');
  const historyResult = await api('GET', '/api/history?limit=10');
  check(historyResult.status === 200, 'GET /api/history 返回 200');
  check(Array.isArray(historyResult.data?.data), 'history 是数组');

  // ═══════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════
  fs.rmSync(dir, { recursive: true, force: true });

  // V0.4 新增测试
  await mainV04();

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

// V0.4 新增测试入口
async function mainV04() {
  await securityTests();
  await apiContractTests();
}

// ═══════════════════════════════════════════════
// V0.4 Security Regression Tests
// ═══════════════════════════════════════════════

async function securityTests() {
  console.log('\n=== Security Regression Tests ===\n');

  // ── Target Root 边界测试 ──
  console.log('1. Target Root 边界:');

  // 创建测试目录
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'sub', 'nested.txt'), 'nested');

  // 扫描
  const scanRes = await api('POST', '/api/scan', { rootPath: root });
  const scanId = scanRes.data.data.scanId;

  // 等待扫描完成
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/api/job?type=scan&id=${scanId}`);
    if (r.data?.data?.done) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const scanResult = await api('GET', `/api/scan-result?scanId=${scanId}`);
  const files = scanResult.data.data.files;

  // 分类
  const clsRes = await api('POST', '/api/classify', {
    files,
    config: { llm: { enabled: false }, context: { dirs: [] } },
  });
  const classifyId = clsRes.data.data.classifyId;

  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/api/job?type=classify&id=${classifyId}`);
    if (r.data?.data?.done) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const clsResult = await api('GET', `/api/classify-result?classifyId=${classifyId}`);
  const classified = clsResult.data.data.results || clsResult.data.data;

  // ── 测试 1: ../ 越界 ──
  console.log('  ../ 越界:');
  {
    const planRes = await api('POST', '/api/plan', {
      files: classified,
      options: { targetRoot: '../outside' },
      scanId,
    });
    // 服务器应拒绝（403）
    check(planRes.status === 403, `../outside 被拒绝 (status: ${planRes.status})`);
  }

  // ── 测试 2: 绝对路径 ──
  console.log('  绝对路径:');
  {
    const planRes = await api('POST', '/api/plan', {
      files: classified,
      options: { targetRoot: '/etc' },
      scanId,
    });
    // 服务器应拒绝（403）或解析到安全路径
    const rejected = planRes.status === 403;
    const targetRoot = planRes.data.data?.targetRoot;
    check(rejected, `/etc 绝对路径被拒绝 (status: ${planRes.status})`);
  }

  // ── 测试 3: 符号链接逃逸 ──
  console.log('  符号链接逃逸:');
  {
    // 在 scan root 外创建一个文件
    const outsideFile = path.join(os.tmpdir(), 'sec-outside-' + Date.now() + '.txt');
    fs.writeFileSync(outsideFile, 'outside');

    // 尝试将外部文件注入 plan
    const injectedFile = {
      name: 'outside.txt',
      path: outsideFile,
      dir: os.tmpdir(),
      size: fs.statSync(outsideFile).size,
      extension: '.txt',
    };

    const planRes = await api('POST', '/api/plan', {
      files: [injectedFile],
      options: {},
      scanId,
    });
    // 服务器应拒绝外部文件（403）
    const rejected = planRes.status === 403;
    check(rejected, `外部文件注入被拒绝 (status: ${planRes.status})`);

    fs.unlinkSync(outsideFile);
  }

  // ── 测试 4: 正常 targetRoot 在范围内 ──
  console.log('  正常 targetRoot:');
  {
    const planRes = await api('POST', '/api/plan', {
      files: classified,
      options: { targetRoot: path.join(root, '整理结果') },
      scanId,
    });
    const targetRoot = planRes.data.data?.targetRoot;
    check(planRes.status === 200 && targetRoot, `正常 targetRoot 在范围内 (status: ${planRes.status}, targetRoot: ${targetRoot})`);
  }

  // ── 测试 5: 相对 targetRoot 在范围内 ──
  console.log('  相对 targetRoot:');
  {
    const planRes = await api('POST', '/api/plan', {
      files: classified,
      options: { targetRoot: '整理结果' },
      scanId,
    });
    const targetRoot = planRes.data.data?.targetRoot;
    check(planRes.status === 200 && targetRoot, `相对 targetRoot 解析到范围内 (status: ${planRes.status}, targetRoot: ${targetRoot})`);
  }

  // 清理
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════
// V0.4 API Contract Regression Tests
// ═══════════════════════════════════════════════

async function apiContractTests() {
  console.log('\n=== API Contract Regression Tests ===\n');

  // 创建测试目录
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'report.pdf'), 'pdf-content');
  fs.writeFileSync(path.join(root, 'docs', 'data.csv'), 'a,b,c\n1,2,3');

  // 1. Scan
  console.log('1. Scan → Classify → Plan → Execute → History 字段连续性:');
  const scanRes = await api('POST', '/api/scan', { rootPath: root });
  const scanId = scanRes.data.data.scanId;
  check(scanId && scanId.startsWith('scan_'), `scanId 格式正确: ${scanId}`);

  // 等待扫描
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/api/job?type=scan&id=${scanId}`);
    if (r.data?.data?.done) break;
    await new Promise(r => setTimeout(r, 200));
  }

  // 2. Classify
  const scanResult = await api('GET', `/api/scan-result?scanId=${scanId}`);
  const files = scanResult.data.data.files;
  check(files && files.length > 0, `Scan 返回文件列表 (${files?.length} 个文件)`);

  const clsRes = await api('POST', '/api/classify', {
    files,
    config: { llm: { enabled: false }, context: { dirs: [] } },
  });
  const classifyId = clsRes.data.data.classifyId;
  check(classifyId && classifyId.startsWith('cls_'), `classifyId 格式正确: ${classifyId}`);

  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/api/job?type=classify&id=${classifyId}`);
    if (r.data?.data?.done) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const clsResult = await api('GET', `/api/classify-result?classifyId=${classifyId}`);
  const classified = clsResult.data.data.results || clsResult.data.data;
  check(classified && classified.length > 0, `Classify 返回结果 (${classified?.length} 个文件)`);

  // 验证 classify 结果中的关键字段
  const firstResult = classified[0];
  check(firstResult.fileType !== undefined, `fileType 字段存在: ${firstResult.fileType}`);
  check(firstResult.contentTheme !== undefined, `contentTheme 字段存在: ${firstResult.contentTheme}`);
  check(firstResult.suggestedTarget !== undefined, `suggestedTarget 字段存在: ${firstResult.suggestedTarget}`);
  check(firstResult.confidence !== undefined, `confidence 字段存在: ${firstResult.confidence}`);

  // 3. Plan
  const planRes = await api('POST', '/api/plan', {
    files: classified,
    options: {},
    scanId,
  });
  const planId = planRes.data.data.planId;
  check(planId && planId.startsWith('plan_'), `planId 格式正确: ${planId}`);

  const moves = planRes.data.data.moves;
  check(Array.isArray(moves), `moves 是数组 (${moves.length} 条移动)`);

  // 验证 move 中的 from/to 字段
  if (moves.length > 0) {
    const firstMove = moves[0];
    check(firstMove.from !== undefined, `move.from 字段存在`);
    check(firstMove.to !== undefined, `move.to 字段存在`);
    check(firstMove.category !== undefined, `move.category 字段存在: ${firstMove.category}`);
  }

  // 4. Execute
  const execRes = await api('POST', '/api/execute', { planId });
  const execId = execRes.data.data.execId;
  check(execId && execId.startsWith('exec_'), `execId 格式正确: ${execId}`);

  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/api/job?type=execute&id=${execId}`);
    if (r.data?.data?.done) break;
    await new Promise(r => setTimeout(r, 200));
  }

  // 5. History
  const histRes = await api('GET', '/api/history');
  const history = histRes.data.data;
  check(Array.isArray(history), `history 是数组`);

  if (history && history.length > 0) {
    const lastSession = history[0];
    check(lastSession.id !== undefined, `session.id 字段存在: ${lastSession.id}`);
    check(lastSession.sourceDir !== undefined, `session.sourceDir 字段存在`);
    check(lastSession.targetRoot !== undefined, `session.targetRoot 字段存在`);
    check(Array.isArray(lastSession.moves), `session.moves 是数组`);
  }

  // 清理
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});