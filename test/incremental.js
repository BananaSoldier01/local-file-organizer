/**
 * incremental.js — Incremental Organization 测试 (V0.5.0)
 *
 * 测试增量整理能力：
 * 1. File State Store 基本操作
 * 2. 变化检测（新增/修改/删除/移动）
 * 3. 增量 Plan 生成
 * 4. 与 Memory 集成
 * 5. 与 Relationship 集成
 */

const fileState = require('../engine/file-state');
const organizer = require('../engine/organizer');
const memory = require('../engine/memory');
const path = require('path');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

// ── 测试 1: File State Store ──
console.log('\n测试 1: File State Store 基本操作\n');
{
  fileState.clearState();

  const file = {
    name: 'test.txt',
    path: '/test/test.txt',
    size: 100,
    modified: Date.now(),
    contentTheme: '文档',
    contentSummary: { keywords: ['test'] },
  };

  const entry = fileState.upsertFileState(file, { contentTheme: '文档', confidence: 0.8 });
  check(entry.path === '/test/test.txt', `状态路径正确 (实际: ${entry.path})`);
  check(entry.classification.theme === '文档', `分类主题正确 (实际: ${entry.classification.theme})`);
  check(entry.fingerprint && entry.fingerprint.startsWith('fp_'), `指纹格式正确 (实际: ${entry.fingerprint})`);
  check(entry.lastProcessedAt, `有处理时间`);

  const retrieved = fileState.getFileState('/test/test.txt');
  check(retrieved !== null, `查询状态存在`);
  check(retrieved && retrieved.fingerprint === entry.fingerprint, `查询指纹一致`);

  const stats = fileState.getStateStats();
  check(stats.total === 1, `统计总数为 1 (实际: ${stats.total})`);
  check(stats.classified === 1, `已分类数为 1 (实际: ${stats.classified})`);
}

// ── 测试 2: 变化检测 ──
console.log('\n测试 2: 变化检测\n');
{
  fileState.clearState();

  // 先记录 2 个文件
  fileState.upsertFileState(
    { name: 'a.txt', path: '/test/a.txt', size: 100, modified: 1000, contentTheme: '文档', contentSummary: { keywords: ['a'] } },
    { contentTheme: '文档', confidence: 0.8 }
  );
  fileState.upsertFileState(
    { name: 'b.txt', path: '/test/b.txt', size: 200, modified: 2000, contentTheme: '文档', contentSummary: { keywords: ['b'] } },
    { contentTheme: '文档', confidence: 0.8 }
  );

  // 先记录 d.txt（后续会被删除）
  fileState.upsertFileState(
    { name: 'd.txt', path: '/test/d.txt', size: 400, modified: 4000, contentTheme: '文档', contentSummary: { keywords: ['d'] } },
    { contentTheme: '文档', confidence: 0.8 }
  );

  // 模拟当前文件：a 未变，b 修改，c 新增，d 删除
  const currentFiles = [
    { name: 'a.txt', path: '/test/a.txt', size: 100, modified: 1000 }, // unchanged
    { name: 'b.txt', path: '/test/b.txt', size: 250, modified: 2000 }, // modified (size changed)
    { name: 'c.txt', path: '/test/c.txt', size: 300, modified: 3000 }, // added
  ];

  const changes = fileState.detectChanges(currentFiles);
  check(changes.stats.addedCount === 1, `新增 1 个 (实际: ${changes.stats.addedCount})`);
  check(changes.stats.modifiedCount === 1, `修改 1 个 (实际: ${changes.stats.modifiedCount})`);
  check(changes.stats.unchangedCount === 1, `未变化 1 个 (实际: ${changes.stats.unchangedCount})`);
  check(changes.stats.deletedCount === 1, `删除 1 个 (实际: ${changes.stats.deletedCount})`);
  check(changes.added[0].file.name === 'c.txt', `新增文件是 c.txt (实际: ${changes.added[0].file.name})`);
  check(changes.modified[0].file.name === 'b.txt', `修改文件是 b.txt (实际: ${changes.modified[0].file.name})`);
  check(changes.deleted[0].path === '/test/d.txt', `删除文件是 d.txt (实际: ${changes.deleted[0].path})`);
}

// ── 测试 3: 文件移动检测 ──
console.log('\n测试 3: 文件移动检测\n');
{
  fileState.clearState();

  fileState.upsertFileState(
    { name: 'same.txt', path: '/test/olddir/same.txt', size: 100, modified: 1000, contentTheme: '文档', contentSummary: { keywords: ['same'] } },
    { contentTheme: '文档', confidence: 0.8 }
  );

  // 文件移动：same.txt 从 /test/olddir/ 移动到 /test/newdir/
  const currentFiles = [
    { name: 'same.txt', path: '/test/newdir/same.txt', size: 100, modified: 1000 },
  ];

  let changes = fileState.detectChanges(currentFiles);
  changes = fileState.detectMoves(changes);

  check(changes.stats.movedCount === 1, `移动 1 个 (实际: ${changes.stats.movedCount})`);
  check(changes.moved.length === 1, `移动列表有 1 条 (实际: ${changes.moved.length})`);
  check(changes.moved[0].from === '/test/olddir/same.txt', `移动源正确 (实际: ${changes.moved[0].from})`);
  check(changes.moved[0].to === '/test/newdir/same.txt', `移动目标正确 (实际: ${changes.moved[0].to})`);
}

// ── 测试 4: 增量 Plan ──
console.log('\n测试 4: 增量 Plan 生成\n');
{
  fileState.clearState();
  memory.clearMemory();

  // 先记录历史状态
  fileState.upsertFileState(
    { name: 'existing.txt', path: '/test/existing.txt', size: 100, modified: 1000, contentTheme: '文档', contentSummary: { keywords: ['existing'] } },
    { contentTheme: '文档', confidence: 0.8 },
    { currentPath: '/test', targetPath: '/test/文档' }
  );

  // 新增文件
  const newFile = {
    name: 'newfile.txt',
    path: '/test/newfile.txt',
    dir: '/test',
    fileType: 'document',
    contentTheme: '文档',
    suggestedTarget: '文档',
    confidence: 0.8,
    contentSummary: { keywords: ['newfile'] },
  };

  const changeResult = {
    added: [{ file: newFile, reason: 'added' }],
    modified: [],
    unchanged: [],
    deleted: [],
    moved: [],
    stats: { addedCount: 1, modifiedCount: 0, unchangedCount: 0, deletedCount: 0, movedCount: 0 },
  };

  const plan = organizer.generatePlan([newFile], {
    incremental: true,
    fileState: fileState,
    changeResult: changeResult,
  });

  check(plan.incremental === true, `Plan 标记为增量 (实际: ${plan.incremental})`);
  check(plan.moves.length === 1, `有 1 条 move (实际: ${plan.moves.length})`);
  check(plan.moves[0].incremental === true, `move 标记为增量 (实际: ${plan.moves[0].incremental})`);
  check(plan.moves[0].changeReason === 'added', `changeReason 为 added (实际: ${plan.moves[0].changeReason})`);
  check(plan.incrementalStats && plan.incrementalStats.added === 1, `增量统计 added=1 (实际: ${plan.incrementalStats?.added})`);
}

// ── 测试 5: 增量 Plan + Memory 集成 ──
console.log('\n测试 5: 增量 Plan + Memory 集成\n');
{
  fileState.clearState();
  memory.clearMemory();

  // 记录 Memory
  for (let i = 0; i < 3; i++) {
    const entry = memory.recordDecision({
      type: 'target_override',
      file: {
        name: `发票${i}.xlsx`,
        path: `/test/发票${i}.xlsx`,
        contentTheme: '财务',
        contentSummary: { keywords: ['发票', '税务'], entities: [] },
      },
      target: '个人/税务',
    });
    for (let t = 0; t < 3; t++) memory.touchMemory(entry.id);
  }

  const newFile = {
    name: '新发票.xlsx',
    path: '/test/新发票.xlsx',
    dir: '/test',
    fileType: 'document',
    contentTheme: '财务',
    suggestedTarget: '文档',
    confidence: 0.8,
    contentSummary: { keywords: ['发票', '税务'] },
  };

  const changeResult = {
    added: [{ file: newFile, reason: 'added' }],
    modified: [],
    unchanged: [],
    deleted: [],
    moved: [],
    stats: { addedCount: 1, modifiedCount: 0, unchangedCount: 0, deletedCount: 0, movedCount: 0 },
  };

  const plan = organizer.generatePlan([newFile], {
    incremental: true,
    fileState: fileState,
    changeResult: changeResult,
  });

  check(plan.moves[0].to.includes('个人/税务'),
    `增量 Plan 使用 Memory 建议 (实际: ${plan.moves[0].to})`);
  check(plan.moves[0].memoryReason,
    `增量 Plan 携带 Memory reason (实际: ${plan.moves[0].memoryReason})`);
}

// ── 测试 6: 增量 Plan + Existing Organization State ──
console.log('\n测试 6: 增量 Plan + Existing Organization State\n');
{
  fileState.clearState();
  memory.clearMemory();

  // 记录历史组织状态
  fileState.upsertFileState(
    { name: 'report.pdf', path: '/test/report.pdf', size: 100, modified: 1000, contentTheme: '项目', contentSummary: { keywords: ['报告'] } },
    { contentTheme: '项目', confidence: 0.8 },
    { currentPath: '/test', targetPath: '/test/项目A' }
  );

  // 修改同一文件
  const modifiedFile = {
    name: 'report.pdf',
    path: '/test/report.pdf',
    dir: '/test',
    fileType: 'document',
    contentTheme: '项目',
    suggestedTarget: '文档',
    confidence: 0.85,
    contentSummary: { keywords: ['报告', '项目A'] },
  };

  const changeResult = {
    added: [],
    modified: [{ file: modifiedFile, reason: 'modified' }],
    unchanged: [],
    deleted: [],
    moved: [],
    stats: { addedCount: 0, modifiedCount: 1, unchangedCount: 0, deletedCount: 0, movedCount: 0 },
  };

  const plan = organizer.generatePlan([modifiedFile], {
    incremental: true,
    fileState: fileState,
    changeResult: changeResult,
  });

  check(plan.moves[0].to.includes('项目A'),
    `增量 Plan 保持历史组织状态 (实际: ${plan.moves[0].to})`);
}

// ── 结果汇总 ──
console.log('\n' + '='.repeat(50));
console.log(`增量整理测试: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log('='.repeat(process.stdout.columns ? Math.min(50, process.stdout.columns) : 50));

if (failed > 0) {
  process.exit(1);
}