/**
 * classifier.js — 文件分类引擎 (V0.2)
 *
 * 多维分类模型，替代旧的单层互斥分类：
 *
 *   fileType      — 文件是什么（扩展名决定，客观）
 *   contentTheme — 内容主题（文件名/上下文推断，可能主观）
 *   riskFlag     — 风险标记（敏感/大文件/疑似重复/临时）
 *   suggestedTarget — 建议目标目录名
 *   confidence   — 综合置信度 0-1
 *
 * 这些维度互相独立。一个 PDF 可以是：
 *   fileType: "document", contentTheme: "project-a", riskFlag: ["sensitive"]
 */

const path = require('path');

// ═══════════════════════════════════════════════
// 维度一：文件类型 (fileType)
// ═══════════════════════════════════════════════

const FILE_TYPES = {
  document:  { label: '文档',     targetDir: '文档' },
  image:     { label: '图片',     targetDir: '图片' },
  video:     { label: '视频',     targetDir: '视频' },
  audio:     { label: '音频',     targetDir: '音频' },
  archive:   { label: '压缩文件', targetDir: '压缩文件' },
  installer: { label: '安装包',   targetDir: '安装包' },
  code:      { label: '代码资料', targetDir: '代码' },
  data:      { label: '数据文件', targetDir: '数据' },
  temp:      { label: '临时文件', targetDir: '临时文件' },
  other:     { label: '其他',     targetDir: '其他' },
};

const EXT_TO_FILE_TYPE = {
  // 文档
  '.doc': 'document', '.docx': 'document', '.pdf': 'document',
  '.txt': 'document', '.rtf': 'document', '.md': 'document', '.markdown': 'document',
  '.xls': 'document', '.xlsx': 'document', '.ppt': 'document', '.pptx': 'document',
  '.odt': 'document', '.pages': 'document', '.numbers': 'document', '.key': 'document',
  '.csv': 'document', '.epub': 'document', '.mobi': 'document',
  '.wps': 'document', '.wpt': 'document', '.et': 'document', '.dps': 'document',
  '.log': 'document',

  // 图片
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image',
  '.bmp': 'image', '.svg': 'image', '.webp': 'image', '.heic': 'image',
  '.heif': 'image', '.tiff': 'image', '.tif': 'image', '.raw': 'image',
  '.cr2': 'image', '.nef': 'image', '.arw': 'image', '.psd': 'image',
  '.ai': 'image', '.sketch': 'image', '.fig': 'image',

  // 视频
  '.mp4': 'video', '.mov': 'video', '.avi': 'video', '.mkv': 'video',
  '.wmv': 'video', '.flv': 'video', '.webm': 'video', '.m4v': 'video',
  '.mpg': 'video', '.mpeg': 'video', '.ts': 'video', '.m2ts': 'video',
  '.3gp': 'video', '.rmvb': 'video', '.rm': 'video', '.vob': 'video',
  '.mts': 'video', '.divx': 'video',

  // 音频
  '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio', '.aac': 'audio',
  '.ogg': 'audio', '.wma': 'audio', '.m4a': 'audio', '.aiff': 'audio',
  '.alac': 'audio', '.cue': 'audio', '.ape': 'audio', '.dsd': 'audio',

  // 压缩文件
  '.zip': 'archive', '.rar': 'archive', '.7z': 'archive', '.tar': 'archive',
  '.gz': 'archive', '.bz2': 'archive', '.xz': 'archive', '.iso': 'archive',
  '.cab': 'archive', '.sit': 'archive', '.sitx': 'archive',
  '.dmg': 'archive', '.z01': 'archive', '.part': 'archive',

  // 安装包
  '.exe': 'installer', '.msi': 'installer', '.dmg': 'installer',
  '.pkg': 'installer', '.deb': 'installer', '.rpm': 'installer',
  '.apk': 'installer', '.ipa': 'installer', '.bin': 'installer',
  '.run': 'installer', '.cmd': 'installer', '.bat': 'installer',
  '.jar': 'installer', '.war': 'installer', '.msix': 'installer',

  // 代码
  '.js': 'code', '.ts': 'code', '.jsx': 'code', '.tsx': 'code',
  '.py': 'code', '.java': 'code', '.c': 'code', '.cpp': 'code',
  '.cc': 'code', '.h': 'code', '.hpp': 'code', '.cs': 'code',
  '.go': 'code', '.rs': 'code', '.rb': 'code', '.php': 'code',
  '.html': 'code', '.htm': 'code', '.css': 'code', '.scss': 'code',
  '.sass': 'code', '.less': 'code', '.json': 'code', '.xml': 'code',
  '.yaml': 'code', '.yml': 'code', '.sql': 'code', '.sh': 'code',
  '.bash': 'code', '.zsh': 'code', '.fish': 'code', '.ps1': 'code',
  '.pl': 'code', '.pm': 'code', '.lua': 'code', '.kt': 'code',
  '.swift': 'code', '.m': 'code', '.mm': 'code', '.r': 'code',
  '.dart': 'code', '.vue': 'code', '.env': 'code', '.gitignore': 'code',
  '.dockerfile': 'code', '.gradle': 'code', '.toml': 'code',
  '.ini': 'code', '.cfg': 'code', '.conf': 'code', '.properties': 'code',
  '.proto': 'code', '.graphql': 'code', '.gql': 'code', '.svelte': 'code',

  // 数据
  '.sqlite': 'data', '.db': 'data', '.mdb': 'data',
  '.dat': 'data', '.dat1': 'data', '.data': 'data',

  // 临时
  '.tmp': 'temp', '.temp': 'temp', '.bak': 'temp', '.swp': 'temp',
  '.swo': 'temp', '.cache': 'temp', '.part': 'temp',
  '.download': 'temp', '.crdownload': 'temp', '.partial': 'temp',
  '.lock': 'temp', '.tmp~': 'temp',
};

// ═══════════════════════════════════════════════
// 维度二：内容主题 (contentTheme)
// ═══════════════════════════════════════════════

const THEME_PATTERNS = [
  // 财务/商务
  { pattern: /(?:invoice|invoice_|账单|发票|结算|对账|报税|tax|receipt|billing|payment)/i, theme: '财务', weight: 0.85 },
  { pattern: /(?:contract|合同|协议|agreement|nda|lease|lease_)/i, theme: '合同', weight: 0.85 },
  { pattern: /(?:report|报告|summary|总结|briefing|memo|presentation|deck)/i, theme: '报告', weight: 0.7 },
  { pattern: /(?:meeting|会议|minutes|议程|agenda)/i, theme: '会议', weight: 0.7 },
  { pattern: /(?:budget|预算|forecast|projection|财务)/i, theme: '财务', weight: 0.75 },

  // 个人
  { pattern: /(?:resume|cv|简历|portfolio|作品集|self.?introduction)/i, theme: '个人简历', weight: 0.8 },
  { pattern: /(?:photo|photo_|picture|img_|image_|dsc_|pict|snap)/i, theme: '个人照片', weight: 0.6 },
  { pattern: /(?:screenshot|screen_shot|截图|snip|capture|snip_|sc_|ss_)/i, theme: '截图', weight: 0.6 },
  { pattern: /(?:diary|日记|journal|note|notes|memo|备忘)/i, theme: '个人笔记', weight: 0.5 },

  // 学习/教育
  { pattern: /(?:homework|作业|assignment|exercise|习题|test.?paper|试卷)/i, theme: '学习', weight: 0.7 },
  { pattern: /(?:thesis|论文|dissertation|paper|paper_)/i, theme: '学术', weight: 0.7 },
  { pattern: /(?:textbook|教材|course|课程|slide|slides)/i, theme: '学习', weight: 0.6 },

  // 项目相关
  { pattern: /(?:project|项目|proposal|提案|plan_?doc|roadmap|milestone)/i, theme: '项目', weight: 0.7 },
  { pattern: /(?:design|设计|mockup|wireframe|prototype|原型|草图)/i, theme: '设计', weight: 0.6 },
  { pattern: /(?:spec|specification|规格|requirement|需求)/i, theme: '技术文档', weight: 0.6 },
  { pattern: /(?:api|sdk|reference|manual|guide|文档|doc_)/i, theme: '技术文档', weight: 0.5 },

  // 媒体
  { pattern: /(?:video_|movie|film|clip|剪辑|vid_|mv_)/i, theme: '视频', weight: 0.5 },
  { pattern: /(?:song|music|track|song_|音频|录音|podcast)/i, theme: '音频', weight: 0.5 },

  // 备份/旧文件
  { pattern: /(?:backup|备份|bak|old|旧|archive|archived|历史)/i, theme: '备份', weight: 0.6 },
  { pattern: /(?:draft|草稿|wip|work.?in.?progress|scratch)/i, theme: '草稿', weight: 0.5 },
  { pattern: /(?:final|最终|done|completed|finished)/i, theme: '终稿', weight: 0.4 },
];

// ═══════════════════════════════════════════════
// 维度三：风险标记 (riskFlag)
// ═══════════════════════════════════════════════

function detectRiskFlags(file, context) {
  const flags = [];
  const name = file.name.toLowerCase();
  const basename = path.basename(file.name, path.extname(file.name)).toLowerCase();

  // 敏感内容
  const sensitivePatterns = [
    /(?:password|passwd|pwd|secret|api.?key|token|credential)/i,
    /(?:bank|银行|信用卡|credit.?card|card.?number)/i,
    /(?:ssn|social.?security|身份证|护照|passport)/i,
    /(?:private|私密|confidential|机密)/i,
  ];
  for (const p of sensitivePatterns) {
    if (p.test(name)) { flags.push('sensitive'); break; }
  }

  // 大文件
  if (file.size > 100 * 1024 * 1024) flags.push('large');

  // 疑似临时文件
  const tempPatterns = /(?:tmp|temp|scratch|缓存|cache|\.bak|\.swp|\.part|\.download|\.crdownload|\.partial)/i;
  if (tempPatterns.test(name)) flags.push('temp_likely');

  // 疑似重复（同名文件在多个目录中出现）
  if (context && context.duplicateNames && context.duplicateNames.has(file.name)) {
    flags.push('possible_duplicate');
  }

  // 无扩展名
  if (!file.extension || file.extension === '') flags.push('no_extension');

  return flags;
}

// ═══════════════════════════════════════════════
// 维度四：建议目标目录 (suggestedTarget)
// ═══════════════════════════════════════════════

function suggestTarget(file, fileType, contentTheme, context) {
  // 如果有明确的项目/主题分组，使用主题作为子目录
  if (contentTheme && contentTheme !== '默认') {
    return contentTheme;
  }
  // 否则使用文件类型对应的目标目录
  return FILE_TYPES[fileType]?.targetDir || '其他';
}

// ═══════════════════════════════════════════════
// 主分类函数
// ═══════════════════════════════════════════════

/**
 * 基于规则对单个文件进行多维分类。
 */
function classifyByRules(file, context = {}) {
  const ext = '.' + (file.extension || '').toLowerCase();
  const basename = file.name;
  const nameWithoutExt = path.basename(basename, path.extname(basename)).toLowerCase();

  // ── fileType ──
  let fileType = EXT_TO_FILE_TYPE[ext];
  let fileTypeConfidence = 0.9;
  let fileTypeMethod = 'extension';

  if (!fileType) {
    // 无扩展名：尝试文件名模式推断
    fileType = 'other';
    fileTypeConfidence = 0.3;
    fileTypeMethod = 'fallback';

    // 大文件可能是视频/音频
    if (file.size > 10 * 1024 * 1024) {
      fileType = 'other';
      fileTypeConfidence = 0.2;
    }
  }

  // ── contentTheme ──
  let contentTheme = '默认';
  let themeConfidence = 0;
  let themeMethod = 'none';

  for (const { pattern, theme, weight } of THEME_PATTERNS) {
    if (pattern.test(basename) || pattern.test(nameWithoutExt)) {
      if (weight > themeConfidence) {
        themeConfidence = weight;
        contentTheme = theme;
        themeMethod = 'name_pattern';
      }
    }
  }

  // ── 目录名推断主题 ──
  if (themeConfidence < 0.5 && file.dir) {
    const dirName = path.basename(file.dir).toLowerCase();
    for (const { pattern, theme, weight } of THEME_PATTERNS) {
      if (pattern.test(dirName) && weight > themeConfidence) {
        themeConfidence = weight * 0.7; // 目录名权重低于文件名
        contentTheme = theme;
        themeMethod = 'dir_pattern';
      }
    }
  }

  // ── riskFlag ──
  const riskFlags = detectRiskFlags(file, context);

  // ── suggestedTarget ──
  const suggestedTarget = suggestTarget(file, fileType, contentTheme, context);

  // ── 整理建议置信度 ──
  // 重新定义：表示"有多确信这个文件应该移动到建议的目标目录"
  // 不再混合 risk flag 等无关因素
  // 三级制：高可信(≥0.7) / 建议确认(0.4-0.7) / 需要判断(<0.4)
  let confidence;
  if (fileTypeConfidence >= 0.9 && themeConfidence >= 0.5) {
    // 类型明确 + 主题明确 → 高可信
    confidence = 0.85;
  } else if (fileTypeConfidence >= 0.9 && themeConfidence < 0.5) {
    // 类型明确但主题不明确 → 建议确认
    confidence = 0.65;
  } else if (fileTypeConfidence < 0.9 && themeConfidence >= 0.5) {
    // 类型不确定但主题明确 → 建议确认
    confidence = 0.55;
  } else if (fileTypeConfidence < 0.9 && themeConfidence < 0.5) {
    // 都不明确 → 需要判断
    confidence = 0.35;
  } else {
    confidence = 0.5;
  }

  // 注意：置信度与风险标记解耦。
  // 风险标记通过 riskFlag 字段独立传递，由 UI 决定是否需要用户确认。
  // 不再通过降低置信度来触发确认流程。

  return {
    fileType,
    fileTypeLabel: FILE_TYPES[fileType]?.label || '其他',
    contentTheme,
    riskFlag: riskFlags,
    suggestedTarget,
    confidence: Math.round(confidence * 100) / 100,
    method: fileTypeMethod + (themeMethod !== 'none' ? '+' + themeMethod : ''),
    reason: buildReason(fileType, contentTheme, riskFlags, fileTypeMethod, themeMethod),
  };
}

function buildReason(fileType, theme, flags, ftMethod, themeMethod) {
  const parts = [];
  parts.push(`类型: ${FILE_TYPES[fileType]?.label || fileType}`);
  if (theme && theme !== '默认') parts.push(`主题: ${theme}`);
  if (flags.length > 0) parts.push(`风险: ${flags.join(', ')}`);
  return parts.join(' · ');
}

// ═══════════════════════════════════════════════
// LLM 辅助：语义理解
// ═══════════════════════════════════════════════

/**
 * 调用 LLM 进行语义分析。
 *
 * 与旧版的区别：
 * - 不是"规则失败时的兜底"，而是"理解上下文"
 * - 分析文件之间的语义关系（是否属于同一项目）
 * - 为低置信度文件提供更准确的判断
 * - 返回结构化结果，包含不确定项
 */
async function analyzeWithLLM(files, llmConfig, context = {}) {
  const { endpoint, apiKey, model } = llmConfig;

  // 构建上下文感知的 prompt
  const dirContext = context.dirs ? `
相关目录：
${context.dirs.slice(0, 20).map(d => `- ${d}`).join('\n')}` : '';

  // 使用内部 ID 代替绝对路径，保护隐私
  const fileIdMap = new Map();
  files.forEach((f, i) => {
    const fid = 'file_' + String(i).padStart(4, '0');
    fileIdMap.set(f.path, { fid, file: f });
  });

  const fileList = files.map(f => {
    const { fid } = fileIdMap.get(f.path);
    return {
      id: fid,
      name: f.name,
      dir: path.basename(f.dir),  // 只传目录名，不传绝对路径
      size: f.size,
      ext: f.extension || 'none',
      existingFileType: f.fileType,
      existingTheme: f.contentTheme,
    };
  });

  const prompt = `你是文件整理助手。请分析以下文件，帮助回答三个问题：

1. **文件类型** (fileType): document/image/video/audio/archive/installer/code/data/temp/other
2. **内容主题** (contentTheme): 这个文件属于什么主题或项目？用简短的中文标签（如"项目A"、"财务"、"个人照片"、"学习资料"）。如果不确定就写"默认"。
3. **是否敏感** (isSensitive): 文件名是否暗示包含密码/密钥/隐私/财务等敏感内容？
4. **建议目标目录** (suggestedTarget): 建议把文件放到哪个目录下？应该是简短的中文目录名。

文件列表（JSON）：
${JSON.stringify(fileList, null, 2)}
${dirContext}

请以 JSON 数组格式返回，每个元素包含：
{ "id": "file_0001", "fileType": "...", "contentTheme": "...", "isSensitive": false, "suggestedTarget": "...", "confidence": 0-1, "reason": "简短理由" }

只返回 JSON 数组，不要其他文字。如果对某个文件不确定，confidence 设为 0.3-0.5。`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个文件整理专家。只返回 JSON 数组，不要 markdown 格式。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API 返回错误: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('LLM 返回内容为空');
  }

  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('LLM 返回格式无效，无法提取 JSON');
  }

  const llmResults = JSON.parse(jsonMatch[0]);

  // 将 ID 映射回文件路径
  const idToPath = new Map();
  for (const [path, { fid }] of fileIdMap) {
    idToPath.set(fid, path);
  }

  return llmResults.map(r => ({
    ...r,
    _path: idToPath.get(r.id) || r.id,
  }));
}

/**
 * 分析文件之间的语义关系，识别可能属于同一项目的文件群。
 *
 * 返回: [{ theme, files: [fileIndex...], confidence }]
 */
async function detectProjectGroups(files, llmConfig) {
  const { endpoint, apiKey, model } = llmConfig;

  const summary = files.map((f, i) => ({
    index: i,
    name: f.name,
    dir: path.basename(f.dir),  // 只传目录名，不传绝对路径
  }));

  const prompt = `以下是某个文件夹中的文件列表。请识别哪些文件可能属于同一个项目或主题，将它们分组。

文件列表（JSON）：
${JSON.stringify(summary, null, 2)}

返回 JSON 数组，每个元素包含：
{ "theme": "项目/主题名（中文简短标签）", "fileIndices": [索引数组], "confidence": 0-1 }

只返回 JSON 数组。如果找不到明显的项目分组，返回空数组 []。`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个文件整理专家。只返回 JSON 数组。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API 返回错误: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) return [];

  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  return JSON.parse(jsonMatch[0]);
}

// ═══════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════

/**
 * 批量分类文件（多维模型）。
 *
 * @param {object[]} files
 * @param {object} config
 * @param {object} config.llm
 * @param {object} config.context  { dirs, duplicateNames }
 * @returns {Promise<Array>}
 */
async function classifyFiles(files, config = {}) {
  const context = config.context || {};
  // 构建重复文件名集合
  const nameCount = {};
  for (const f of files) {
    nameCount[f.name] = (nameCount[f.name] || 0) + 1;
  }
  context.duplicateNames = new Set(
    Object.entries(nameCount).filter(([_, c]) => c > 1).map(([n]) => n)
  );

  // 1. 规则分类
  const results = files.map(file => {
    const ruleResult = classifyByRules(file, context);
    return {
      ...file,
      fileType: ruleResult.fileType,
      fileTypeLabel: ruleResult.fileTypeLabel,
      contentTheme: ruleResult.contentTheme,
      riskFlag: ruleResult.riskFlag,
      suggestedTarget: ruleResult.suggestedTarget,
      confidence: ruleResult.confidence,
      method: ruleResult.method,
      reason: ruleResult.reason,
    };
  });

  // 2. LLM 语义增强（分批处理，支持任意数量文件）
  if (config.llm && config.llm.enabled && config.llm.apiKey) {
    try {
      // 对低置信度或有风险标记的文件进行 LLM 分析
      const needsLLM = results.filter(r =>
        r.confidence < 0.6 ||
        r.riskFlag.includes('sensitive') ||
        r.riskFlag.includes('no_extension') ||
        r.contentTheme === '默认'
      );

      if (needsLLM.length > 0) {
        // 分批处理：每批 20 个文件，避免单次请求过大
        const BATCH_SIZE = 20;
        const batches = [];
        for (let i = 0; i < needsLLM.length; i += BATCH_SIZE) {
          batches.push(needsLLM.slice(i, i + BATCH_SIZE));
        }

        let totalProcessed = 0;
        for (let bi = 0; bi < batches.length; bi++) {
          const batch = batches[bi];
          try {
            const llmResults = await analyzeWithLLM(batch, config.llm, context);
            for (const llmResult of llmResults) {
              const idx = results.findIndex(r => r.path === llmResult._path);
              if (idx >= 0) {
                const r = results[idx];
                if (llmResult.fileType && llmResult.fileType !== r.fileType) {
                  r.fileType = llmResult.fileType;
                  r.fileTypeLabel = FILE_TYPES[llmResult.fileType]?.label || llmResult.fileType;
                }
                if (llmResult.contentTheme && llmResult.contentTheme !== '默认') {
                  r.contentTheme = llmResult.contentTheme;
                }
                if (llmResult.isSensitive) {
                  if (!r.riskFlag.includes('sensitive')) r.riskFlag.push('sensitive');
                }
                if (llmResult.suggestedTarget) {
                  r.suggestedTarget = llmResult.suggestedTarget;
                }
                r.confidence = llmResult.confidence || r.confidence;
                r.method = 'llm';
                r.reason = llmResult.reason || r.reason;
              }
            }
            totalProcessed += llmResults.length;
          } catch (batchErr) {
            // 单 batch 失败不影响其他 batch，记录警告继续
            console.warn(`[classifier] LLM batch ${bi + 1}/${batches.length} 失败:`, batchErr.message);
          }
        }
        if (totalProcessed > 0) {
          console.log(`[classifier] LLM 分析完成: ${totalProcessed}/${needsLLM.length} 个文件`);
        }
      }
    } catch (err) {
      console.warn('[classifier] LLM 分析整体失败，使用规则结果:', err.message);
    }
  }

  // 3. 项目分组（可选）
  if (config.llm && config.llm.enabled && config.llm.apiKey && config.detectProjects) {
    try {
      const groups = await detectProjectGroups(results, config.llm);
      for (const group of groups) {
        for (const idx of group.fileIndices) {
          if (results[idx]) {
            results[idx].contentTheme = group.theme;
            results[idx].suggestedTarget = group.theme;
            // groupConfidence 与 suggestionConfidence 解耦，不覆盖原置信度
            results[idx].groupConfidence = group.confidence || 0.7;
          }
        }
      }
    } catch (err) {
      console.warn('[classifier] 项目分组失败:', err.message);
    }
  }

  return results;
}

/**
 * 获取所有文件类型。
 */
function getFileTypes() {
  return Object.entries(FILE_TYPES).map(([key, val]) => ({
    key, label: val.label, targetDir: val.targetDir,
  }));
}

/**
 * 对单批文件执行规则 + LLM 分类。
 * 供异步 classify job 调用，每批独立 try/catch。
 *
 * @param {Array} files  文件列表
 * @param {object} config  配置 { llm, context, detectProjects }
 * @returns {Promise<Array>}  分类结果
 */
async function classifyBatch(files, config = {}) {
  // 先走规则分类
  let results;
  try {
    results = files.map(f => {
      const ruleResult = classifyByRules(f, {});
      return {
        ...f,           // 保留原始文件元数据（path/name/dir/size/extension）
        ...ruleResult,   // 覆盖分类结果
      };
    });
  } catch (err) {
    console.error('[classifier] classifyByRules failed:', err.message, err.stack);
    throw err;
  }

  // LLM 辅助分析
  if (config.llm && config.llm.enabled && config.llm.apiKey) {
    const needsLLM = results.filter(r =>
      r.confidence < 0.6 ||
      r.riskFlag.includes('sensitive') ||
      r.riskFlag.includes('no_extension') ||
      r.contentTheme === '默认'
    );

    if (needsLLM.length > 0) {
      try {
        const llmResults = await analyzeWithLLM(needsLLM, config.llm, config.context || {});
        for (const llmResult of llmResults) {
          const idx = results.findIndex(r => r.path === llmResult._path);
          if (idx >= 0) {
            const r = results[idx];
            if (llmResult.fileType && llmResult.fileType !== r.fileType) {
              r.fileType = llmResult.fileType;
              r.fileTypeLabel = FILE_TYPES[llmResult.fileType]?.label || llmResult.fileType;
            }
            if (llmResult.contentTheme && llmResult.contentTheme !== '默认') {
              r.contentTheme = llmResult.contentTheme;
            }
            if (llmResult.isSensitive) {
              if (!r.riskFlag.includes('sensitive')) r.riskFlag.push('sensitive');
            }
            if (llmResult.suggestedTarget) {
              r.suggestedTarget = llmResult.suggestedTarget;
            }
            if (llmResult.reason) r.llmReason = llmResult.reason;
          }
        }
      } catch (err) {
        console.warn('[classifier] batch LLM failed:', err.message);
        // 单批 LLM 失败不影响其他批次
      }
    }
  }

  return results;
}

module.exports = {
  classifyByRules,
  classifyFiles,
  classifyBatch,
  analyzeWithLLM,
  detectProjectGroups,
  getFileTypes,
  FILE_TYPES,
  EXT_TO_FILE_TYPE,
};