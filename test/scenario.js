/**
 * scenario.js — V0.3.4 场景测试
 *
 * 覆盖用户真实操作路径：Edit → Exclude → Restore → Execute → Undo
 * 以及安全边界：ScanId 必须、文件归属、Session 生命周期、Classify Cancel、Undo Conflict。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

function setupFiles(dir, count, prefix = 'file') {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, `${prefix}-${i}.txt`), `content-${i}`);
  }
}

function safeRm(dir) {
  // 强制递归删除，容忍 ENOTEMPTY（macOS 文件锁）
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    try { require('child_process').execSync(`rm -rf "${dir}"`); }
    catch (_) { /* ignore */ }
  }
}

async function scanAndWait(rootPath) {
  const scanRes = await api('POST', '/api/scan', { rootPath });
  const scanId = scanRes.data.data.scanId;
  const scanResult = await pollJob('scan', scanId);
  const scanData = (await api('GET', `/api/scan-result?scanId=${scanId}`)).data.data;
  return { scanId, scanData };
}

async function classifyAndWait(files, detectProjects = false) {
  const clsRes = await api('POST', '/api/classify', {
    files,
    config: { llm: { enabled: false }, detectProjects, context: { dirs: [] } },
  });
  const clsId = clsRes.data.data.classifyId;
  await pollJob('classify', clsId);
  const clsData = (await api('GET', `/api/classify-result?classifyId=${clsId}`)).data.data;
  return clsData.results || clsData;
}

async function planAndWait(files, scanId, targetRoot) {
  const planRes = await api('POST', '/api/plan', {
    files,
    options: { targetRoot },
    scanId,
  });
  if (planRes.status !== 200) throw new Error(`plan failed: ${JSON.stringify(planRes.data)}`);
  const planId = planRes.data.data.planId;
  return { planId, plan: planRes.data.data };
}

async function executeAndWait(planId) {
  const execRes = await api('POST', '/api/execute', { planId });
  if (execRes.status !== 200) throw new Error(`execute failed: ${JSON.stringify(execRes.data)}`);
  const execId = execRes.data.data.execId;
  const result = await pollJob('execute', execId);
  return { execId, result };
}

async function main() {
  console.log('=== V0.3.4 Scenario Tests ===\n');

  try {
    const ping = await api('GET', '/api/settings');
    if (ping.status !== 200) throw new Error('Server not reachable');
    console.log('  Server: OK\n');
  } catch (e) {
    console.log('  Server: NOT REACHABLE');
    process.exit(1);
  }

  // ═══════════════════════════════════════════════
  // Scenario A — Edit → Execute
  // ═══════════════════════════════════════════════
  console.log('A. Edit → Execute:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnA-'));
    setupFiles(root, 3, 'afile');
    const { scanId, scanData } = await scanAndWait(root);
    const classified = await classifyAndWait(scanData.files);

    // Plan A
    const targetA = path.join(root, '目标A');
    const { planId: planIdA, plan: planA } = await planAndWait(classified, scanId, targetA);
    check(!!planIdA, 'Plan A generated');
    check(planA.moves.length === 3, `Plan A moves = 3 (实际: ${planA.moves.length})`);

    // Modify target → Plan B
    const targetB = path.join(root, '目标B');
    const { planId: planIdB, plan: planB } = await planAndWait(classified, scanId, targetB);
    check(planIdB !== planIdA, `Plan B != Plan A (${planIdA} → ${planIdB})`);

    // Execute Plan B
    const { result } = await executeAndWait(planIdB);
    check(result.status === 'completed' || result.status === 'partial', `Execute B 完成 (status: ${result.status})`);
    check(result.successCount === 3, `Execute B 移动 3 个文件 (实际: ${result.successCount})`);

    // Verify files moved to target B, NOT target A
    const firstMove = planB.moves[0];
    check(fs.existsSync(firstMove.to), `文件在目标B: ${firstMove.to}`);
    check(firstMove.to.includes('目标B'), `目标路径包含目标B: ${firstMove.to}`);
    check(!fs.existsSync(firstMove.from), `源文件已移动: ${firstMove.from}`);

    safeRm(root);
  }

  // ═══════════════════════════════════════════════
  // Scenario B — Exclude → Execute
  // ═══════════════════════════════════════════════
  console.log('\nB. Exclude → Execute:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnB-'));
    setupFiles(root, 3, 'bfile');
    const { scanId, scanData } = await scanAndWait(root);
    const classified = await classifyAndWait(scanData.files);

    // 排除第二个文件
    const excludedPath = classified[1].path;
    const effectiveFiles = classified.filter(f => f.path !== excludedPath);
    check(effectiveFiles.length === 2, `排除后有效文件 = 2 (实际: ${effectiveFiles.length})`);

    const target = path.join(root, '目标');
    const { planId, plan } = await planAndWait(effectiveFiles, scanId, target);
    check(plan.moves.length === 2, `排除后 Plan moves = 2 (实际: ${plan.moves.length})`);

    // 验证被排除文件不在 plan 中
    const excludedInPlan = plan.moves.some(m => m.from === excludedPath);
    check(!excludedInPlan, `被排除文件不在 Plan 中`);

    const { result } = await executeAndWait(planId);
    check(result.successCount === 2, `执行移动 2 个文件 (实际: ${result.successCount})`);
    check(fs.existsSync(excludedPath), `被排除文件未移动: ${excludedPath}`);

    safeRm(root);
  }

  // ═══════════════════════════════════════════════
  // Scenario C — Restore Excluded → Execute
  // ═══════════════════════════════════════════════
  console.log('\nC. Restore Excluded → Execute:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnC-'));
    setupFiles(root, 3, 'cfile');
    const { scanId, scanData } = await scanAndWait(root);
    const classified = await classifyAndWait(scanData.files);

    // 排除第二个文件
    const excludedPath = classified[1].path;
    const effectiveFiles = classified.filter(f => f.path !== excludedPath);
    const target = path.join(root, '目标');
    const { planId: planIdExcluded } = await planAndWait(effectiveFiles, scanId, target);

    // 恢复：重新用全部文件生成 Plan
    const { planId: planIdRestored, plan: planRestored } = await planAndWait(classified, scanId, target);
    check(planIdRestored !== planIdExcluded, `恢复后 Plan ID 变化`);
    check(planRestored.moves.length === 3, `恢复后 Plan moves = 3 (实际: ${planRestored.moves.length})`);
    const restoredInPlan = planRestored.moves.some(m => m.from === excludedPath);
    check(restoredInPlan, `恢复后文件重新进入 Plan`);

    const { result } = await executeAndWait(planIdRestored);
    check(result.successCount === 3, `恢复后执行移动 3 个文件 (实际: ${result.successCount})`);
    check(!fs.existsSync(excludedPath), `恢复后文件已移动: ${excludedPath}`);

    safeRm(root);
  }

  // ═══════════════════════════════════════════════
  // Scenario D — Plan Without ScanId
  // ═══════════════════════════════════════════════
  console.log('\nD. Plan Without ScanId:');
  {
    const res = await api('POST', '/api/plan', {
      files: [{ path: '/tmp/test.txt', name: 'test.txt', dir: '/tmp', size: 0, modified: Date.now() }],
      options: { targetRoot: '/tmp' },
      // 不传 scanId
    });
    check(res.status === 400, `无 scanId 被拒绝 (实际: ${res.status})`);
  }

  // ═══════════════════════════════════════════════
  // Scenario E — Foreign File Injection
  // ═══════════════════════════════════════════════
  console.log('\nE. Foreign File Injection:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnE-'));
    setupFiles(root, 1, 'efile');
    const { scanId, scanData } = await scanAndWait(root);

    // 尝试注入一个不在扫描结果中的文件
    const foreignFile = {
      path: '/tmp/foreign-secret.txt',
      name: 'foreign-secret.txt',
      dir: '/tmp',
      size: 0,
      modified: Date.now(),
    };
    fs.writeFileSync(foreignFile.path, 'secret');

    const res = await api('POST', '/api/plan', {
      files: [...scanData.files, foreignFile],
      options: { targetRoot: path.join(root, '目标') },
      scanId,
    });
    check(res.status === 403, `外部文件注入被拒绝 (实际: ${res.status})`);

    safeRm(root);
    safeRm(foreignFile.path);
  }

  // ═══════════════════════════════════════════════
  // Scenario F — Session Lifecycle
  // ═══════════════════════════════════════════════
  console.log('\nF. Session Lifecycle:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnF-'));
    setupFiles(root, 2, 'ffile');
    const { scanId, scanData } = await scanAndWait(root);
    const classified = await classifyAndWait(scanData.files);

    // 生成 Plan
    const target = path.join(root, '目标');
    const { planId } = await planAndWait(classified, scanId, target);

    // 验证 planId 仍然有效（未过期）
    const planCheck = await api('POST', '/api/execute', { planId });
    check(planCheck.status === 200, `Plan 在有效期内可执行 (实际: ${planCheck.status})`);

    safeRm(root);
  }

  // ═══════════════════════════════════════════════
  // Scenario G — Classify Cancel
  // ═══════════════════════════════════════════════
  console.log('\nG. Classify Cancel:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnG-'));
    // 创建较多文件以确保分类有足够时间运行（每批 20 文件 + 200ms 延迟）
    setupFiles(root, 100, 'gfile');
    const { scanData } = await scanAndWait(root);

    const clsRes = await api('POST', '/api/classify', {
      files: scanData.files,
      config: { llm: { enabled: false }, detectProjects: false, context: { dirs: [] } },
    });
    const clsId = clsRes.data.data.classifyId;

    // 快速轮询，一旦 running 就取消
    let cancelled = false;
    for (let i = 0; i < 2000; i++) {
      const r = await api('GET', `/api/job?type=classify&id=${clsId}`);
      const d = r.data?.data;
      if (!d) break;
      if (d.status === 'running' && !cancelled) {
        const cancelRes = await api('POST', '/api/classify-cancel', { id: clsId });
        check(cancelRes.status === 200, `classify-cancel 返回 200 (实际: ${cancelRes.status})`);
        cancelled = true;
      }
      if (d.done) break;
      await sleep(5);
    }

    check(cancelled, '分类取消请求已发送');

    // 等待最终状态
    const finalState = await pollJob('classify', clsId, 10000);
    check(finalState.status === 'cancelled', `分类取消后状态 (实际: ${finalState.status})`);
    check(finalState.processedFiles < finalState.totalFiles,
      `未完成全部文件 (${finalState.processedFiles} < ${finalState.totalFiles})`);

    safeRm(root);
  }

  // ═══════════════════════════════════════════════
  // Scenario H — Undo Conflict
  // ═══════════════════════════════════════════════
  console.log('\nH. Undo Conflict:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnH-'));
    setupFiles(root, 2, 'hfile');
    const { scanId, scanData } = await scanAndWait(root);
    const classified = await classifyAndWait(scanData.files);

    const target = path.join(root, '目标');
    const { planId } = await planAndWait(classified, scanId, target);
    const { result } = await executeAndWait(planId);
    check(result.successCount === 2, `执行移动 2 个文件 (实际: ${result.successCount})`);

    // 在原位置创建新文件，制造 undo 冲突
    const firstMove = result.moves ? null : null; // moves 不在 result 中，需要从 plan 获取
    // 从 plan 中获取第一个 move 的源路径
    // 需要重新获取 plan 信息
    // 实际上 result 中有 success 数组，但不含路径。我们从 scanData 中取第一个文件
    const originalPath = scanData.files[0].path;
    fs.writeFileSync(originalPath, 'conflict');

    // 执行撤销
    const undoRes = await api('POST', '/api/undo', { sessionId: result.sessionId });
    check(undoRes.status === 200, `undo 返回 200 (实际: ${undoRes.status})`);
    const undoData = undoRes.data.data;
    check(undoData.status !== 'fully_reverted',
      `Undo 状态不是 fully_reverted (实际: ${undoData.status})`);
    check(undoData.conflictCount > 0 || undoData.failed > 0,
      `Undo 存在冲突或失败 (conflictCount: ${undoData.conflictCount}, failed: ${undoData.failed})`);

    safeRm(root);
  }

  // ═══════════════════════════════════════════════
  // Scenario I — Rapid Target Edit (Last Write Wins)
  // ═══════════════════════════════════════════════
  console.log('\nI. Rapid Target Edit (Last Write Wins):');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnI-'));
    setupFiles(root, 2, 'ifile');
    const { scanId, scanData } = await scanAndWait(root);
    const classified = await classifyAndWait(scanData.files);

    // 连续发送 3 个不同 target 的 plan 请求（模拟用户快速修改）
    const target1 = path.join(root, '目标1');
    const target2 = path.join(root, '目标2');
    const target3 = path.join(root, '目标3');

    // 并发发送三个请求，最后一个（target3）应该最终胜出
    const [r1, r2, r3] = await Promise.all([
      api('POST', '/api/plan', { files: classified, options: { targetRoot: target1 }, scanId }),
      api('POST', '/api/plan', { files: classified, options: { targetRoot: target2 }, scanId }),
      api('POST', '/api/plan', { files: classified, options: { targetRoot: target3 }, scanId }),
    ]);

    // 三个请求都应该成功
    check(r1.status === 200 && r2.status === 200 && r3.status === 200,
      `三个 plan 请求均成功 (${r1.status}/${r2.status}/${r3.status})`);

    // 执行最后一个 plan（target3）
    const lastPlanId = r3.data.data.planId;
    const { result } = await executeAndWait(lastPlanId);
    check(result.successCount === 2, `执行移动 2 个文件 (实际: ${result.successCount})`);

    // 验证文件最终在 target3，不在 target1 或 target2
    const firstFile = scanData.files[0];
    const inTarget3 = fs.existsSync(path.join(target3, '文档', firstFile.name));
    const inTarget1 = fs.existsSync(path.join(target1, '文档', firstFile.name));
    const inTarget2 = fs.existsSync(path.join(target2, '文档', firstFile.name));
    check(inTarget3, `文件在目标3: ${target3}`);
    check(!inTarget1, `文件不在目标1: ${target1}`);
    check(!inTarget2, `文件不在目标2: ${target2}`);

    safeRm(root);
  }

  // ═══════════════════════════════════════════════
  // Scenario J — Edit + Exclude Race
  // ═══════════════════════════════════════════════
  console.log('\nJ. Edit + Exclude Race:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnJ-'));
    setupFiles(root, 3, 'jfile');
    const { scanId, scanData } = await scanAndWait(root);
    const classified = await classifyAndWait(scanData.files);

    // 同时发起：修改 target + 排除一个文件
    const newTarget = path.join(root, '新目标');
    const excludedFile = classified[1].path;

    const [editRes, excludeRes] = await Promise.all([
      api('POST', '/api/plan', {
        files: classified,
        options: { targetRoot: newTarget },
        scanId,
      }),
      api('POST', '/api/plan', {
        files: classified.filter(f => f.path !== excludedFile),
        options: { targetRoot: newTarget },
        scanId,
      }),
    ]);

    check(editRes.status === 200 && excludeRes.status === 200,
      `编辑和排除请求均成功 (${editRes.status}/${excludeRes.status})`);

    // 执行排除版本的 plan（排除请求后发，应该胜出）
    const excludePlanId = excludeRes.data.data.planId;
    const { result } = await executeAndWait(excludePlanId);
    check(result.successCount === 2, `排除后执行 2 个文件 (实际: ${result.successCount})`);
    check(fs.existsSync(excludedFile), `被排除文件未移动: ${excludedFile}`);

    safeRm(root);
  }

  // ═══════════════════════════════════════════════
  // Scenario K — Exclude → Restore Rapidly
  // ═══════════════════════════════════════════════
  console.log('\nK. Exclude → Restore Rapidly:');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scnK-'));
    setupFiles(root, 3, 'kfile');
    const { scanId, scanData } = await scanAndWait(root);
    const classified = await classifyAndWait(scanData.files);

    const excludedFile = classified[1].path;
    const target = path.join(root, '目标');

    // 先发送排除请求
    const excludeRes = await api('POST', '/api/plan', {
      files: classified.filter(f => f.path !== excludedFile),
      options: { targetRoot: target },
      scanId,
    });
    check(excludeRes.status === 200, `排除请求成功`);

    // 立即发送恢复请求（全部文件）
    const restoreRes = await api('POST', '/api/plan', {
      files: classified,
      options: { targetRoot: target },
      scanId,
    });
    check(restoreRes.status === 200, `恢复请求成功`);

    // 执行恢复版本的 plan
    const restorePlanId = restoreRes.data.data.planId;
    const { result } = await executeAndWait(restorePlanId);
    check(result.successCount === 3, `恢复后执行 3 个文件 (实际: ${result.successCount})`);
    check(!fs.existsSync(excludedFile), `恢复后文件已移动: ${excludedFile}`);

    safeRm(root);
  }

  // ═══════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════

  console.log('\n=== Scenario Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\n  ⚠️  存在失败项。');
    process.exit(1);
  } else {
    console.log('\n  ✅ 所有场景测试通过。');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});