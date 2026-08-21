/**
 * relationship.js — 文件关系引擎 (V0.4.2.1)
 *
 * 基于 Semantic Fingerprint + 相似度引擎，构建文件关系图并生成分组建议。
 *
 * V0.4.2.1 核心修复：
 * - 候选索引替代全量 N² 遍历
 * - Group Cohesion 约束：连通分量不再等于分组，需要核心边 + 实体覆盖
 * - Group Evidence 修复：共享实体必须是真共享（出现在组内所有文件中）
 * - Group Confidence 基于覆盖率 + 内部边强度 + 一致性
 *
 * 分组策略：
 * - 候选索引（倒排索引）→ 候选对
 * - 相似度计算 → 边
 * - Group Cohesion 检测（核心边 + 实体覆盖 + 边密度）
 * - 分组建议（基于真共享实体 + 覆盖率）
 */

const path = require('path');
const {
  similarity,
  buildCandidateIndex,
  THRESHOLDS,
} = require('./similarity');
const { buildFingerprint } = require('./fingerprint');

/**
 * 获取文件的唯一标识（优先 path，回退到 name）。
 */
function getFileId(file) {
  return file.path || file.name;
}

/**
 * 构建文件关系图。
 *
 * @param {Array} files - FileEntry 数组（含 classification 结果）
 * @param {object} opts - 选项
 * @param {number} opts.minScore - 最低相似度阈值（默认 0.3）
 * @param {number} opts.maxPairs - 最大比较对数（性能保护）
 * @returns {object} { graph, groups, fingerprints, stats }
 */
function buildRelationshipGraph(files, opts = {}) {
  const minScore = opts.minScore ?? THRESHOLDS.minScore;
  const maxPairs = opts.maxPairs ?? 5000;

  // 1. 生成 Fingerprint
  const fingerprints = files.map(f => {
    const fp = buildFingerprint(f, f.contentSummary);
    return { file: f, fingerprint: fp, id: getFileId(f) };
  });

  // 2. 候选索引（倒排索引）— 避免全量 N²
  const candidatePairs = buildCandidateIndex(fingerprints);

  // 3. 相似度计算（仅对候选对）
  const edges = [];
  let pairsChecked = 0;

  for (const { i, j } of candidatePairs) {
    if (pairsChecked >= maxPairs) break;

    const a = fingerprints[i].fingerprint;
    const b = fingerprints[j].fingerprint;

    pairsChecked++;
    const sim = similarity(a, b);
    if (sim.score >= minScore) {
      edges.push({
        from: fingerprints[i].id,
        to: fingerprints[j].id,
        score: sim.score,
        evidence: sim.evidence,
        signals: sim.signals,
      });
    }
  }

  // 4. 构建关系图（邻接表）
  const graph = {};
  for (const fp of fingerprints) {
    graph[fp.id] = [];
  }
  for (const edge of edges) {
    if (!graph[edge.from]) graph[edge.from] = [];
    if (!graph[edge.to]) graph[edge.to] = [];
    graph[edge.from].push({
      path: edge.to,
      score: edge.score,
      evidence: edge.evidence,
      signals: edge.signals,
    });
    graph[edge.to].push({
      path: edge.from,
      score: edge.score,
      evidence: edge.evidence,
      signals: edge.signals,
    });
  }

  // 5. Group Cohesion 检测（替代简单连通分量）
  const groups = detectCohesiveGroups(graph, fingerprints, edges);

  // 6. 统计
  const stats = {
    totalFiles: files.length,
    totalEdges: edges.length,
    candidatePairs: candidatePairs.length,
    pairsChecked,
    groups: groups.length,
    multiFileGroups: groups.filter(g => g.files.length > 1).length,
    singleFileGroups: groups.filter(g => g.files.length === 1).length,
  };

  return { graph, groups, fingerprints, stats, edges };
}

/**
 * Group Cohesion 检测。
 *
 * 不再使用简单 BFS 连通分量（会导致链式污染）。
 * 而是：
 * 1. 找到强核心边（score >= strongEdgeThreshold）
 * 2. 从核心边扩展：只添加与核心有强连接的文件
 * 3. 验证 group cohesion：实体覆盖率 + 边密度
 * 4. 剩余文件归入单文件组
 *
 * @param {object} graph - 邻接表
 * @param {Array} fingerprints - Fingerprint 数组
 * @param {Array} edges - 边列表
 * @returns {Array} 分组数组 [{ files, coreEntities, confidence, reason }]
 */
function detectCohesiveGroups(graph, fingerprints, edges) {
  const fpMap = new Map();
  for (const fp of fingerprints) {
    fpMap.set(fp.id, fp.fingerprint);
  }

  // 按分数降序排列边
  const sortedEdges = [...edges].sort((a, b) => b.score - a.score);

  // 找到强核心边（score >= strongEdgeThreshold）
  const strongEdges = sortedEdges.filter(e => e.score >= THRESHOLDS.strongEdge);

  // 从强核心边构建初始组
  const visited = new Set();
  const groups = [];

  for (const edge of strongEdges) {
    if (visited.has(edge.from) && visited.has(edge.to)) continue;

    // 找到包含 edge.from 或 edge.to 的未访问连通分量
    // 但只扩展与核心有强连接的节点
    const group = expandCohesiveGroup(edge, graph, fpMap, visited);
    if (group && group.files.length >= 2) {
      groups.push(group);
    }
  }

  // 剩余未访问的文件归入单文件组
  for (const fp of fingerprints) {
    if (!visited.has(fp.id)) {
      groups.push({
        files: [fp.id],
        coreEntities: [],
        confidence: 0,
        reason: '无强关系连接',
        cohesion: 0,
        entityCoverage: 0,
        edgeDensity: 0,
      });
    }
  }

  return groups;
}

/**
 * 从核心边扩展，构建有凝聚力的组。
 * 只添加与当前组核心有强连接的文件。
 */
function expandCohesiveGroup(seedEdge, graph, fpMap, visited) {
  const groupFiles = new Set();
  const queue = [];
  const coreEntities = new Set();

  // 从种子边开始
  groupFiles.add(seedEdge.from);
  groupFiles.add(seedEdge.to);
  visited.add(seedEdge.from);
  visited.add(seedEdge.to);

  // 收集种子边的共享实体
  const fpA = fpMap.get(seedEdge.from);
  const fpB = fpMap.get(seedEdge.to);
  if (fpA && fpB) {
    const entA = new Set(fpA.entities || []);
    for (const e of fpB.entities || []) {
      if (entA.has(e)) coreEntities.add(e);
    }
  }

  // BFS 扩展：只添加与组内至少一个文件有强连接的节点
  queue.push(seedEdge.from);
  queue.push(seedEdge.to);

  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = graph[current] || [];

    for (const neighbor of neighbors) {
      if (visited.has(neighbor.path)) continue;

      // 检查：该邻居与组内文件的连接是否足够强
      const groupConnections = groupFiles.has(neighbor.path)
        ? 0
        : countStrongConnections(neighbor.path, groupFiles, graph);

      // V0.4.2.1: 实体一致性检查 — 防止 bridge file 链式污染
      // 候选节点必须与组核心实体有交集，或者核心实体为空（初始种子边）
      const nfp = fpMap.get(neighbor.path);
      let hasEntityConsistency = false;
      if (nfp && coreEntities.size > 0) {
        const nEnt = new Set(nfp.entities || []);
        hasEntityConsistency = [...coreEntities].some(e => nEnt.has(e));
      }

      // 只有在有强连接 AND (实体一致 OR 核心实体为空) 时才添加
      if (groupConnections > 0 && (hasEntityConsistency || coreEntities.size === 0)) {
        groupFiles.add(neighbor.path);
        visited.add(neighbor.path);
        queue.push(neighbor.path);

        // 更新核心实体（只保留在所有已访问文件中都出现的实体）
        if (nfp) {
          const nEnt = new Set(nfp.entities || []);
          for (const e of [...coreEntities]) {
            if (!nEnt.has(e)) coreEntities.delete(e);
          }
        }
      }
    }
  }

  // 计算 group cohesion 指标
  const cohesion = computeGroupCohesion(groupFiles, graph, fpMap, coreEntities);

  // 计算实体覆盖率
  const entityCoverage = computeEntityCoverage(groupFiles, fpMap, coreEntities);

  // 计算边密度
  const edgeDensity = computeEdgeDensity(groupFiles, graph);

  // 生成理由
  const reason = buildGroupReason(groupFiles, fpMap, coreEntities, cohesion, entityCoverage);

  return {
    files: [...groupFiles],
    coreEntities: [...coreEntities],
    confidence: cohesion,
    reason,
    cohesion,
    entityCoverage,
    edgeDensity,
  };
}

/**
 * 计算节点与组内文件的强连接数。
 */
function countStrongConnections(nodeId, groupFiles, graph) {
  const neighbors = graph[nodeId] || [];
  let count = 0;
  for (const neighbor of neighbors) {
    if (groupFiles.has(neighbor.path) && neighbor.score >= THRESHOLDS.strongEdge) {
      count++;
    }
  }
  return count;
}

/**
 * 计算 Group Cohesion 分数。
 * 基于：实体覆盖率 + 边强度均值 + 主题一致性。
 */
function computeGroupCohesion(groupFiles, graph, fpMap, coreEntities) {
  if (groupFiles.size < 2) return 0;

  // 实体覆盖率
  const entityCoverage = computeEntityCoverage(groupFiles, fpMap, coreEntities);

  // 边强度均值
  const groupEdges = [];
  const files = [...groupFiles];
  for (let i = 0; i < files.length; i++) {
    const neighbors = graph[files[i]] || [];
    for (const neighbor of neighbors) {
      if (groupFiles.has(neighbor.path) && files[i] < neighbor.path) {
        groupEdges.push(neighbor.score);
      }
    }
  }
  const avgEdgeStrength = groupEdges.length > 0
    ? groupEdges.reduce((s, v) => s + v, 0) / groupEdges.length
    : 0;

  // 主题一致性
  const themes = new Set();
  for (const f of files) {
    const fp = fpMap.get(f);
    if (fp) themes.add(fp.theme);
  }
  const themeConsistency = themes.size === 1 ? 1.0 : (themes.size <= 2 ? 0.7 : 0.3);

  // 综合 cohesion
  const cohesion = Math.round(
    (entityCoverage * 0.4 + avgEdgeStrength * 0.35 + themeConsistency * 0.25) * 1000
  ) / 1000;

  return cohesion;
}

/**
 * 计算实体覆盖率。
 * 核心实体必须出现在组内至少 coverageThreshold 比例的文件中。
 */
function computeEntityCoverage(groupFiles, fpMap, coreEntities) {
  if (coreEntities.size === 0) return 0;
  if (groupFiles.size < 2) return 0;

  const files = [...groupFiles];
  let totalCoverage = 0;

  for (const entity of coreEntities) {
    let filesWithEntity = 0;
    for (const f of files) {
      const fp = fpMap.get(f);
      if (fp && (fp.entities || []).includes(entity)) {
        filesWithEntity++;
      }
    }
    const coverage = filesWithEntity / files.length;
    totalCoverage += coverage;
  }

  return Math.round((totalCoverage / coreEntities.size) * 1000) / 1000;
}

/**
 * 计算边密度（组内实际边数 / 最大可能边数）。
 */
function computeEdgeDensity(groupFiles, graph) {
  if (groupFiles.size < 2) return 0;
  const files = [...groupFiles];
  let actualEdges = 0;

  for (let i = 0; i < files.length; i++) {
    const neighbors = graph[files[i]] || [];
    for (const neighbor of neighbors) {
      if (groupFiles.has(neighbor.path) && files[i] < neighbor.path) {
        actualEdges++;
      }
    }
  }

  const maxPossible = files.length * (files.length - 1) / 2;
  return Math.round((actualEdges / maxPossible) * 1000) / 1000;
}

/**
 * 生成分组理由。
 */
function buildGroupReason(groupFiles, fpMap, coreEntities, cohesion, entityCoverage) {
  const files = [...groupFiles];
  const parts = [];

  // 主题
  const themes = new Set();
  for (const f of files) {
    const fp = fpMap.get(f);
    if (fp) themes.add(fp.theme);
  }
  if (themes.size === 1) {
    parts.push(`统一主题: "${[...themes][0]}"`);
  } else {
    parts.push(`多主题: ${[...themes].join(', ')}`);
  }

  // 核心实体（真共享）
  if (coreEntities.length > 0) {
    parts.push(`核心共享实体: ${coreEntities.slice(0, 3).join(', ')}`);
    parts.push(`实体覆盖率: ${Math.round(entityCoverage * 100)}%`);
  }

  // Cohesion
  parts.push(`组凝聚力: ${cohesion.toFixed(2)}`);

  // 文件数
  parts.push(`${files.length} 个文件`);

  return parts.join('; ');
}

/**
 * 分析分组特征，生成分组建议。
 *
 * V0.4.2.1: 基于真共享实体和覆盖率，不再使用实体并集。
 *
 * @param {Array} group - 分组对象
 * @param {Array} fingerprints - Fingerprint 数组
 * @returns {object} 分析结果
 */
function analyzeGroup(group, fingerprints) {
  const fpMap = new Map();
  for (const fp of fingerprints) {
    fpMap.set(fp.id, fp.fingerprint);
  }

  const files = group.files;
  const fps = files.map(p => fpMap.get(p)).filter(Boolean);
  if (fps.length === 0) {
    return { suggestedName: '未分组', reason: '无指纹数据', confidence: 0, files };
  }

  // 收集主题
  const themes = new Set(fps.map(fp => fp.theme));

  // 真共享实体（出现在所有文件中）
  const trueSharedEntities = new Set();
  if (fps.length >= 2) {
    const firstEnt = new Set(fps[0].entities || []);
    for (const e of firstEnt) {
      if (fps.every(fp => (fp.entities || []).includes(e))) {
        trueSharedEntities.add(e);
      }
    }
  }

  // 建议分组名
  let suggestedName;
  if (trueSharedEntities.size > 0) {
    suggestedName = [...trueSharedEntities].slice(0, 2).join('_');
  } else if (themes.size === 1) {
    suggestedName = [...themes][0];
  } else {
    const commonDir = findCommonDir(fps);
    suggestedName = commonDir || '未分组';
  }

  return {
    suggestedName,
    reason: group.reason,
    confidence: group.confidence,
    files,
    themes: [...themes],
    entities: [...trueSharedEntities],
    cohesion: group.cohesion,
    entityCoverage: group.entityCoverage,
    edgeDensity: group.edgeDensity,
  };
}

/**
 * 找到文件的共同目录
 */
function findCommonDir(fps) {
  const dirs = fps.map(fp => fp.dir).filter(Boolean);
  if (dirs.length === 0) return '';
  if (dirs.length === 1) return dirs[0];

  const parts = dirs[0].split('/').map((_, i) => dirs[0].split('/').slice(0, i + 1).join('/'));
  for (let i = parts.length - 1; i >= 0; i--) {
    if (dirs.every(d => d.startsWith(parts[i]))) {
      return parts[i];
    }
  }
  return '';
}

/**
 * 生成关系报告（用于 API 响应）。
 *
 * @param {object} result - buildRelationshipGraph 的返回值
 * @returns {object} 可序列化的报告
 */
function generateReport(result) {
  const { graph, groups, fingerprints, stats } = result;

  // 构建 file id → name 映射
  const idToName = new Map();
  for (const fp of fingerprints) {
    idToName.set(fp.id, fp.fingerprint.name || fp.id);
  }

  const groupReports = groups.map(group => {
    const analysis = analyzeGroup(group, fingerprints);
    return {
      files: analysis.files.map(p => ({
        path: p,
        name: idToName.get(p) || p.split('/').pop() || p,
      })),
      suggestedName: analysis.suggestedName,
      reason: analysis.reason,
      confidence: analysis.confidence,
      themes: analysis.themes,
      entities: analysis.entities,
      cohesion: analysis.cohesion,
      entityCoverage: analysis.entityCoverage,
      edgeDensity: analysis.edgeDensity,
    };
  });

  // 构建边列表（去重）
  const edgeSet = new Set();
  const edges = [];
  for (const [from, neighbors] of Object.entries(graph)) {
    for (const neighbor of neighbors) {
      const key = [from, neighbor.path].sort().join('||');
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({
          from,
          to: neighbor.path,
          score: neighbor.score,
          evidence: neighbor.evidence,
        });
      }
    }
  }

  return {
    stats,
    groups: groupReports,
    edges,
  };
}

module.exports = {
  buildRelationshipGraph,
  analyzeGroup,
  generateReport,
  detectCohesiveGroups,
  computeGroupCohesion,
  computeEntityCoverage,
  computeEdgeDensity,
};