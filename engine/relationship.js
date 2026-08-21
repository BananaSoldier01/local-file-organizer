/**
 * relationship.js — 文件关系引擎 (V0.4.2)
 *
 * 基于 Semantic Fingerprint + 相似度引擎，构建文件关系图并生成分组建议。
 *
 * 关系类型：
 * 1. SAME_PROJECT — 同一项目（共享实体 + 相同主题）
 * 2. SAME_THEME — 相同主题
 * 3. SAME_DIR — 同目录
 * 4. NAME_VARIANTS — 文件名变体（同一文件的不同版本/命名）
 * 5. RELATED_CONTENT — 内容相关（关键词/实体重叠）
 *
 * 分组策略：
 * - 候选过滤（isCandidatePair）避免全量 N²
 * - 阈值过滤（score >= 0.3）
 * - 连通分量分组
 */

const path = require('path');
const { similarity, isCandidatePair } = require('./similarity');
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
  const minScore = opts.minScore ?? 0.3;
  const maxPairs = opts.maxPairs ?? 5000;

  // 1. 生成 Fingerprint
  const fingerprints = files.map(f => {
    const fp = buildFingerprint(f, f.contentSummary);
    return { file: f, fingerprint: fp, id: getFileId(f) };
  });

  // 2. 候选过滤 + 相似度计算
  const edges = [];
  let pairsChecked = 0;

  for (let i = 0; i < fingerprints.length; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      const a = fingerprints[i].fingerprint;
      const b = fingerprints[j].fingerprint;

      // 快速候选过滤
      if (!isCandidatePair(a, b)) continue;

      pairsChecked++;
      if (pairsChecked > maxPairs) break;

      const sim = similarity(a, b);
      if (sim.score >= minScore) {
        edges.push({
          from: fingerprints[i].id,
          to: fingerprints[j].id,
          score: sim.score,
          evidence: sim.evidence,
        });
      }
    }
    if (pairsChecked > maxPairs) break;
  }

  // 3. 构建关系图（邻接表）
  const graph = {};
  for (const fp of fingerprints) {
    graph[fp.id] = [];
  }
  for (const edge of edges) {
    if (!graph[edge.from]) graph[edge.from] = [];
    if (!graph[edge.to]) graph[edge.to] = [];
    graph[edge.from].push({ path: edge.to, score: edge.score, evidence: edge.evidence });
    graph[edge.to].push({ path: edge.from, score: edge.score, evidence: edge.evidence });
  }

  // 4. 连通分量分组
  const groups = findConnectedComponents(graph, fingerprints);

  // 5. 统计
  const stats = {
    totalFiles: files.length,
    totalEdges: edges.length,
    pairsChecked,
    groups: groups.length,
    multiFileGroups: groups.filter(g => g.length > 1).length,
    singleFileGroups: groups.filter(g => g.length === 1).length,
  };

  return { graph, groups, fingerprints, stats };
}

/**
 * 查找连通分量（分组）。
 * 每个分量是一个文件标识数组。
 */
function findConnectedComponents(graph, fingerprints) {
  const visited = new Set();
  const groups = [];

  for (const fp of fingerprints) {
    const id = fp.id;
    if (visited.has(id)) continue;

    // BFS
    const component = [];
    const queue = [id];
    visited.add(id);

    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);

      const neighbors = graph[current] || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.path)) {
          visited.add(neighbor.path);
          queue.push(neighbor.path);
        }
      }
    }

    groups.push(component);
  }

  return groups;
}

/**
 * 分析分组特征，生成分组建议。
 *
 * @param {Array} group - 文件标识数组
 * @param {Array} fingerprints - Fingerprint 数组（含 file 引用）
 * @returns {object} { suggestedName, reason, confidence, files }
 */
function analyzeGroup(group, fingerprints) {
  const fpMap = new Map();
  for (const fp of fingerprints) {
    fpMap.set(fp.id, fp.fingerprint);
  }

  const fps = group.map(p => fpMap.get(p)).filter(Boolean);
  if (fps.length === 0) {
    return { suggestedName: '未分组', reason: '无指纹数据', confidence: 0, files: group };
  }

  // 收集主题
  const themes = new Set(fps.map(fp => fp.theme));
  const entities = new Set();
  const keywords = new Set();
  for (const fp of fps) {
    for (const e of fp.entities || []) entities.add(e);
    for (const k of fp.keywords || []) keywords.add(k);
  }

  // 主题一致性
  const themeConsistency = themes.size === 1 ? 1.0 : (themes.size <= 2 ? 0.7 : 0.3);

  // 实体一致性
  const entityConsistency = entities.size > 0 ? 1.0 : 0.3;

  // 综合置信度
  const confidence = Math.round(
    (themeConsistency * 0.4 + entityConsistency * 0.3 + (fps.length > 1 ? 0.3 : 0)) * 1000
  ) / 1000;

  // 建议分组名
  let suggestedName;
  if (themes.size === 1) {
    suggestedName = [...themes][0];
  } else if (entities.size > 0) {
    suggestedName = [...entities].slice(0, 2).join('_');
  } else {
    const commonDir = findCommonDir(fps);
    suggestedName = commonDir || '未分组';
  }

  // 生成理由
  const reasonParts = [];
  if (themes.size === 1) {
    reasonParts.push(`统一主题: "${[...themes][0]}"`);
  } else {
    reasonParts.push(`多主题: ${[...themes].join(', ')}`);
  }
  if (entities.size > 0) {
    reasonParts.push(`共享实体: ${[...entities].slice(0, 3).join(', ')}`);
  }
  reasonParts.push(`${fps.length} 个文件`);

  return {
    suggestedName,
    reason: reasonParts.join('; '),
    confidence,
    files: group,
    themes: [...themes],
    entities: [...entities],
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
  findConnectedComponents,
};