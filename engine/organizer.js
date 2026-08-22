/**
 * organizer.js — 整理方案生成器 (V0.4.3)
 *
 * 基于多维分类结果 + 文件关系生成整理方案。
 * V0.4.3: 支持 Relationship Context 参与 Plan 生成。
 *
 * 原则：
 * - Relationship 提供上下文，不完全覆盖 Classification
 * - Group Suggestion 进入 Plan Review，不直接执行
 * - 冲突文件标记为 shared，不强制归组
 */

const path = require('path');
const groupNamer = require('./group-namer');
const memory = require('./memory');
const decisionEngine = require('./decision-engine');
const fileState = require('./file-state');
const relationshipState = require('./relationship-state');

const DANGEROUS_DIRS = new Set([
  '/', '/System', '/Library', '/Applications', '/bin', '/sbin',
  '/usr', '/etc', '/var', '/tmp', '/dev', '/proc', '/sys',
  'C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
]);

/**
 * 生成整理方案。
 *
 * V0.4.3: 新增 relationshipGroups 参数，支持基于关系分组的组织建议。
 *
 * @param {object[]} classifiedFiles  分类后的文件列表
 * @param {object} [options]
 * @param {string} [options.targetRoot]  目标根目录
 * @param {boolean} [options.flatten=true]  平铺到目标根目录
 * @param {object} [options.customTargets]  自定义目标目录
 * @param {Array} [options.relationshipGroups]  Relationship Group 数组
 * @param {boolean} [options.incremental=false]  V0.5.0: 增量模式，只处理变化文件
 * @param {object} [options.fileState]  V0.5.0: File State Store 实例
 * @param {object} [options.changeResult]  V0.5.0: 变化检测结果
 * @returns {{moves: Array, conflicts: Array, summary: object, groupSuggestions: Array}}
 */
function generatePlan(classifiedFiles, options = {}) {
  const {
    targetRoot,
    flatten = false,
    customTargets = {},
    relationshipGroups = null,
    incremental = false,
    fileState = null,
    changeResult = null,
  } = options;

  // V0.5.0: 增量模式 — 只处理变化的文件
  if (incremental && changeResult) {
    return generateIncrementalPlan(classifiedFiles, options);
  }

  const moves = [];
  const conflicts = [];
  const seenTargets = new Map();

  // ── V0.4.3.2: 构建有效文件 ID 集合（与 classifiedFiles 对齐） ──
  const effectiveFileIds = new Set(classifiedFiles.map(f => f.path || f.name));

  // ── V0.4.3: 构建 file → group 映射 ──
  const fileToGroup = new Map();     // file → primary group index
  const fileToGroups = new Map();    // file → [all group indices]
  const conflictFiles = new Set();   // 属于多个 group 的文件

  if (relationshipGroups && relationshipGroups.length > 0) {
    for (let g = 0; g < relationshipGroups.length; g++) {
      const group = relationshipGroups[g];
      for (const file of group.files) {
        // V0.4.3: group.files 可能是字符串（file ID）或对象
        const fileId = typeof file === 'string' ? file : (file.path || file.name);
        // V0.4.3.2: 只考虑当前 effectiveFiles 中存在的文件
        if (!effectiveFileIds.has(fileId)) continue;
        if (!fileToGroups.has(fileId)) {
          fileToGroups.set(fileId, []);
        }
        fileToGroups.get(fileId).push(g);
      }
    }

    // 检测冲突文件（属于多个 group）
    for (const [fileId, groupIndices] of fileToGroups) {
      if (groupIndices.length > 1) {
        conflictFiles.add(fileId);
      }
      // 主 group = 第一个（分数最高的 group）
      fileToGroup.set(fileId, groupIndices[0]);
    }
  }

  // ── V0.4.3: 生成 Group Suggestion ──
  const groupSuggestions = [];
  if (relationshipGroups && relationshipGroups.length > 0) {
    for (let g = 0; g < relationshipGroups.length; g++) {
      const group = relationshipGroups[g];
      // V0.4.3.2: 过滤冲突文件 + 只保留 effectiveFiles 中的文件
      const groupFiles = group.files.filter(f => {
        const fileId = typeof f === 'string' ? f : (f.path || f.name);
        if (conflictFiles.has(fileId)) return false;
        if (!effectiveFileIds.has(fileId)) return false;
        return true;
      });

      // V0.4.3.2: 有效文件不足 2 个时不再作为 group suggestion
      if (groupFiles.length < 2) continue;

      const naming = groupNamer.generateGroupName({
        coreEntities: group.coreEntities,
        themes: group.themes,
        keywords: group.keywords,
        files: groupFiles,
      });

      groupSuggestions.push({
        groupName: naming.name,
        nameConfidence: naming.confidence,
        nameReason: naming.reason,
        files: groupFiles.map(f => {
          const fileId = typeof f === 'string' ? f : (f.path || f.name);
          const fileObj = classifiedFiles.find(cf => {
            const cfId = cf.path || cf.name;
            return cfId === fileId;
          });
          return {
            path: fileId,
            name: fileObj ? fileObj.name : (typeof f === 'string' ? f : f.name),
            fileType: fileObj ? fileObj.fileType : null,
            suggestedTarget: fileObj ? fileObj.suggestedTarget : null,
          };
        }),
        coreEntities: group.coreEntities,
        themes: group.themes,
        confidence: group.confidence,
        cohesion: group.cohesion,
      });
    }
  }

  // ── 确定目标根目录 ──
  let rootDir = targetRoot;
  if (!rootDir && classifiedFiles.length > 0) {
    const dirs = [...new Set(classifiedFiles.map(f => f.dir))];
    if (dirs.length === 1) {
      rootDir = dirs[0];
    } else {
      rootDir = findCommonParent(dirs);
    }
  }

  // 安全检查
  if (rootDir && DANGEROUS_DIRS.has(rootDir)) {
    rootDir = classifiedFiles[0]?.dir || null;
  }

  // ── V0.4.3: 构建 file → group 目录映射 ──
  // 如果文件属于某个 group，其目标目录优先使用 group 名称
  const groupDirMap = new Map(); // group index → target dir name
  for (const suggestion of groupSuggestions) {
    // 使用 group 名称作为目录名
    const dirName = suggestion.groupName;
    groupDirMap.set(suggestion, dirName);
  }

  // ── 生成 Moves ──
  // V0.5.2: 使用 Decision Engine 统一决策
  const decisionContext = {
    relationshipGroups,
    groupSuggestions,
    options: { customTargets, targetRoot, flatten },
  };

  for (const file of classifiedFiles) {
    const fileId = file.path || file.name;
    const groupIndex = fileToGroup.get(fileId);

    // V0.5.2: 调用 Decision Engine
    const decision = decisionEngine.decide(file, decisionContext);
    const targetDirName = decision.target;
    const memoryReason = (decision.source === 'trusted_memory' || decision.source === 'learned_memory')
      ? decision.reason : null;
    const memoryEvidence = (decision.source === 'trusted_memory' || decision.source === 'learned_memory')
      ? decision.evidence : null;

    let targetDir;
    if (flatten) {
      targetDir = path.join(rootDir || file.dir, targetDirName);
    } else if (targetRoot) {
      targetDir = path.join(targetRoot, targetDirName);
    } else {
      targetDir = path.join(file.dir, targetDirName);
    }

    let targetPath = path.join(targetDir, file.name);

    // 跳过：文件已在正确位置
    if (path.resolve(targetPath) === path.resolve(file.path)) continue;

    // 跳过：文件已在同名分类目录中
    const currentDirName = path.basename(file.dir);
    if (currentDirName === targetDirName) continue;

    // 冲突处理
    if (seenTargets.has(targetPath)) {
      const ext = path.extname(file.name);
      const base = path.basename(file.name, ext);
      let counter = 2;
      let newPath;
      do {
        newPath = path.join(targetDir, `${base}_${counter}${ext}`);
        counter++;
      } while (seenTargets.has(newPath));

      seenTargets.set(newPath, { original: file.path, counter });
      moves.push({
        from: file.path,
        to: newPath,
        category: file.suggestedTarget,
        fileType: file.fileType,
        conflictResolution: 'renamed',
        originalTarget: targetPath,
        relationshipGroup: groupIndex !== undefined ? relationshipGroups[groupIndex].coreEntities : null,
        memoryReason,
        memoryEvidence,
        // V0.5.2: Decision Engine 信息
        decisionSource: decision.source,
        decisionPriority: decision.priority,
        decisionConfidence: decision.confidence,
        decisionEvidence: decision.evidence,
        decisionChain: decision.evidenceChain,
      });
    } else {
      seenTargets.set(targetPath, { original: file.path });
      moves.push({
        from: file.path,
        to: targetPath,
        category: file.suggestedTarget,
        fileType: file.fileType,
        conflictResolution: null,
        relationshipGroup: groupIndex !== undefined ? relationshipGroups[groupIndex].coreEntities : null,
        memoryReason,
        memoryEvidence,
        // V0.5.2: Decision Engine 信息
        decisionSource: decision.source,
        decisionPriority: decision.priority,
        decisionConfidence: decision.confidence,
        decisionEvidence: decision.evidence,
        decisionChain: decision.evidenceChain,
      });
    }
  }

  // 按分类统计
  const summary = {};
  for (const move of moves) {
    if (!summary[move.category]) {
      summary[move.category] = { count: 0, label: move.category };
    }
    summary[move.category].count++;
  }

  // V0.4.4: 统计 Memory 命中
  const memoryHits = moves.filter(m => m.memoryReason).length;

  // V0.5.2: 决策统计
  const decisionSummary = decisionEngine.summarizeDecisions(
    new Map(moves.map(m => [m.from, {
      source: m.decisionSource,
      priority: m.decisionPriority,
      confidence: m.decisionConfidence,
      evidence: m.decisionEvidence,
    }]))
  );

  return {
    moves,
    conflicts: moves.filter(m => m.conflictResolution === 'renamed'),
    summary,
    targetRoot: rootDir || null,
    groupSuggestions,
    conflictFiles: [...conflictFiles],
    memoryStats: {
      hits: memoryHits,
      total: moves.length,
    },
    decisionStats: decisionSummary,
  };
}

function findCommonParent(dirs) {
  if (dirs.length === 0) return null;
  if (dirs.length === 1) return dirs[0];

  const splitDirs = dirs.map(d => d.split(path.sep).filter(Boolean));
  let common = [];
  const minLen = Math.min(...splitDirs.map(s => s.length));

  for (let i = 0; i < minLen; i++) {
    const segment = splitDirs[0][i];
    if (splitDirs.every(s => s[i] === segment)) {
      common.push(segment);
    } else break;
  }

  if (common.length === 0) return null;
  const result = common.join(path.sep);
  return path.isAbsolute(dirs[0]) ? path.sep + result : result;
}

function validatePlan(plan) {
  const issues = [];
  const fs = require('fs');
  for (const move of plan.moves) {
    let sourceIsDir = false;
    try {
      sourceIsDir = fs.statSync(move.from).isDirectory();
    } catch (_) { /* 文件不存在，跳过 */ }

    if (!sourceIsDir) continue;

    const sourceDir = path.dirname(move.from);
    if (move.to.startsWith(sourceDir + path.sep) || move.to === sourceDir) {
      issues.push({
        type: 'circular',
        message: `目标路径 "${move.to}" 是源路径 "${move.from}" 的子目录，无法移动`,
        move,
      });
    }
  }
  return { valid: issues.length === 0, issues };
}

function getPlanStats(plan) {
  return {
    totalMoves: plan.moves.length,
    categories: Object.keys(plan.summary).length,
    renamed: plan.conflicts.length,
    totalSize: plan.moves.reduce((sum, m) => sum + (m.size || 0), 0),
    groupSuggestions: plan.groupSuggestions ? plan.groupSuggestions.length : 0,
    conflictFiles: plan.conflictFiles ? plan.conflictFiles.length : 0,
  };
}

// ── V0.5.0: Incremental Plan ──────────────────────────────
/**
 * 生成增量 Plan — 只处理变化的文件，复用已有 File State。
 *
 * 优先级链：
 *   Current User Override > Trusted Memory > Learned Memory
 *   > Existing Organization State > Relationship > Classification
 *
 * @param {object[]} classifiedFiles  分类后的文件列表（仅变化文件）
 * @param {object} options
 * @returns {{moves: Array, conflicts: Array, summary: object, groupSuggestions: Array, incremental: boolean}}
 */
function generateIncrementalPlan(classifiedFiles, options = {}) {
  const {
    targetRoot,
    flatten = false,
    customTargets = {},
    relationshipGroups = null,
    fileState = null,
    changeResult = null,
  } = options;

  const moves = [];
  const conflicts = [];
  const seenTargets = new Map();

  // V0.5.0: 获取已有组织目标（Existing Organization State）
  const existingTargets = fileState ? fileState.getOrganizationTargets() : new Map();

  // 只处理新增和修改的文件
  const filesToProcess = [];
  if (changeResult) {
    for (const item of changeResult.added) {
      filesToProcess.push({ file: item.file, reason: 'added' });
    }
    for (const item of changeResult.modified) {
      filesToProcess.push({ file: item.file, reason: 'modified' });
    }
    for (const item of changeResult.moved) {
      filesToProcess.push({ file: item.file, reason: 'moved' });
    }
  } else {
    // fallback: 处理所有文件
    for (const file of classifiedFiles) {
      filesToProcess.push({ file, reason: 'all' });
    }
  }

  // 构建 file → group 映射（仅对新增文件）
  const fileToGroup = new Map();
  const conflictFiles = new Set();

  if (relationshipGroups && relationshipGroups.length > 0) {
    for (let g = 0; g < relationshipGroups.length; g++) {
      const group = relationshipGroups[g];
      for (const file of group.files) {
        const fId = typeof file === 'string' ? file : (file.path || file.name);
        if (!fileToGroup.has(fId)) {
          fileToGroup.set(fId, g);
        } else {
          conflictFiles.add(fId);
        }
      }
    }
  }

  // 预计算 Memory 建议
  const memorySuggestions = new Map();
  for (const { file } of filesToProcess) {
    const memSug = memory.lookupMemorySuggestion(file);
    if (memSug) {
      memorySuggestions.set(file.path || file.name, memSug);
    }
  }

  // V0.5.2: 使用 Decision Engine 统一决策
  const incDecisionContext = {
    relationshipGroups,
    groupSuggestions: options.groupSuggestions || [],
    options: { customTargets, targetRoot, flatten, fileState, changeResult },
  };

  // 生成 moves
  for (const { file, reason } of filesToProcess) {
    const fileId = file.path || file.name;
    const groupIndex = fileToGroup.get(fileId);

    // V0.5.2: 调用 Decision Engine
    const decision = decisionEngine.decide(file, incDecisionContext);
    const targetDirName = decision.target;
    const memoryReason = (decision.source === 'trusted_memory' || decision.source === 'learned_memory')
      ? decision.reason : null;
    const memoryEvidence = (decision.source === 'trusted_memory' || decision.source === 'learned_memory')
      ? decision.evidence : null;

    let targetDir;
    if (flatten) {
      targetDir = path.join(file.dir, targetDirName);
    } else if (targetRoot) {
      targetDir = path.join(targetRoot, targetDirName);
    } else {
      targetDir = path.join(file.dir, targetDirName);
    }

    let targetPath = path.join(targetDir, file.name);

    if (path.resolve(targetPath) === path.resolve(file.path)) continue;

    const currentDirName = path.basename(file.dir);
    if (currentDirName === targetDirName) continue;

    if (seenTargets.has(targetPath)) {
      const ext = path.extname(file.name);
      const base = path.basename(file.name, ext);
      let counter = 2;
      let newPath;
      do {
        newPath = path.join(targetDir, `${base}_${counter}${ext}`);
        counter++;
      } while (seenTargets.has(newPath));

      seenTargets.set(newPath, { original: file.path, counter });
      moves.push({
        from: file.path,
        to: newPath,
        category: file.suggestedTarget,
        fileType: file.fileType,
        conflictResolution: 'renamed',
        originalTarget: targetPath,
        relationshipGroup: groupIndex !== undefined ? relationshipGroups[groupIndex].coreEntities : null,
        memoryReason,
        memoryEvidence,
        incremental: true,
        changeReason: reason,
        decisionSource: decision.source,
        decisionPriority: decision.priority,
        decisionConfidence: decision.confidence,
        decisionEvidence: decision.evidence,
        decisionChain: decision.evidenceChain,
      });
    } else {
      seenTargets.set(targetPath, { original: file.path });
      moves.push({
        from: file.path,
        to: targetPath,
        category: file.suggestedTarget,
        fileType: file.fileType,
        conflictResolution: null,
        relationshipGroup: groupIndex !== undefined ? relationshipGroups[groupIndex].coreEntities : null,
        memoryReason,
        memoryEvidence,
        incremental: true,
        changeReason: reason,
        decisionSource: decision.source,
        decisionPriority: decision.priority,
        decisionConfidence: decision.confidence,
        decisionEvidence: decision.evidence,
        decisionChain: decision.evidenceChain,
      });
    }
  }

  // 按分类统计
  const summary = {};
  for (const move of moves) {
    if (!summary[move.category]) {
      summary[move.category] = { count: 0, label: move.category };
    }
    summary[move.category].count++;
  }

  const memoryHits = moves.filter(m => m.memoryReason).length;

  // V0.5.2: 决策统计
  const incDecisionSummary = decisionEngine.summarizeDecisions(
    new Map(moves.map(m => [m.from, {
      source: m.decisionSource,
      priority: m.decisionPriority,
      confidence: m.decisionConfidence,
      evidence: m.decisionEvidence,
    }]))
  );

  return {
    moves,
    conflicts,
    summary,
    groupSuggestions: options.groupSuggestions || [],
    incremental: true,
    incrementalStats: {
      totalProcessed: filesToProcess.length,
      added: changeResult ? changeResult.stats.addedCount : 0,
      modified: changeResult ? changeResult.stats.modifiedCount : 0,
      moved: changeResult ? changeResult.stats.movedCount : 0,
      memoryHits,
    },
    memoryStats: { hits: memoryHits, total: filesToProcess.length },
    decisionStats: incDecisionSummary,
  };
}

module.exports = { generatePlan, generateIncrementalPlan, validatePlan, getPlanStats };