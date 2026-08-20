/**
 * classifier.js — 文件分类引擎
 *
 * 基于扩展名 + 文件名启发式规则进行分类。
 * 可选调用 LLM 辅助判断（需配置 API）。
 * 返回: { category, confidence, reason }
 */

const path = require('path');

// ── 分类定义 ──────────────────────────────────────────────
const CATEGORIES = {
  document:    { label: '文档',     color: '#D4A85C', icon: '📄' },
  image:       { label: '图片',     color: '#34C759', icon: '🖼️' },
  video:       { label: '视频',     color: '#AF52DE', icon: '🎬' },
  audio:       { label: '音频',     color: '#FF9500', icon: '🎵' },
  archive:     { label: '压缩文件', color: '#8E8E93', icon: '🗜️' },
  installer:   { label: '安装包',   color: '#5AC8FA', icon: '📦' },
  temp:        { label: '临时文件', color: '#FF3B30', icon: '🗑️' },
  develop:     { label: '开发资料', color: '#0066CC', icon: '💻' },
  work:        { label: '工作资料', color: '#BF5AF0', icon: '💼' },
  personal:    { label: '个人资料', color: '#FF2D55', icon: '🏠' },
  other:       { label: '其他',     color: '#8E8E93', icon: '📄' },
};

// ── 扩展名 → 分类映射 ────────────────────────────────────
const EXT_RULES = {
  // 文档
  '.doc': 'document', '.docx': 'document', '.pdf': 'document',
  '.txt': 'document', '.rtf': 'document', '.md': 'document',
  '.xls': 'document', '.xlsx': 'document', '.ppt': 'document', '.pptx': 'document',
  '.odt': 'document', '.pages': 'document', '.numbers': 'document', '.key': 'document',
  '.csv': 'document', '.epub': 'document', '.mobi': 'document',
  '.wps': 'document', '.wpt': 'document', '.et': 'document', '.dps': 'document',

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
  '.run': 'installer', '.app': 'installer', '.cmd': 'installer',
  '.bat': 'installer', '.ps1': 'installer', '.jar': 'installer',
  '.war': 'installer', '.msix': 'installer', '.appx': 'installer',

  // 临时文件
  '.tmp': 'temp', '.temp': 'temp', '.bak': 'temp', '.swp': 'temp',
  '.swo': 'temp', '.log': 'temp', '.cache': 'temp', '.DS_Store': 'temp',
  '.part': 'temp', '.download': 'temp', '.crdownload': 'temp',
  '.partial': 'temp', '.lock': 'temp', '.tmp~': 'temp',

  // 开发资料
  '.js': 'develop', '.ts': 'develop', '.jsx': 'develop', '.tsx': 'develop',
  '.py': 'develop', '.java': 'develop', '.c': 'develop', '.cpp': 'develop',
  '.cc': 'develop', '.h': 'develop', '.hpp': 'develop', '.cs': 'develop',
  '.go': 'develop', '.rs': 'develop', '.rb': 'develop', '.php': 'develop',
  '.html': 'develop', '.htm': 'develop', '.css': 'develop', '.scss': 'develop',
  '.sass': 'develop', '.less': 'develop', '.json': 'develop', '.xml': 'develop',
  '.yaml': 'develop', '.yml': 'develop', '.sql': 'develop', '.sh': 'develop',
  '.bash': 'develop', '.zsh': 'develop', '.fish': 'develop', '.ps1': 'develop',
  '.bat': 'develop', '.cmd': 'develop', '.pl': 'develop', '.pm': 'develop',
  '.lua': 'develop', '.kt': 'develop', '.swift': 'develop', '.m': 'develop',
  '.mm': 'develop', '.r': 'develop', '.dart': 'develop', '.vue': 'develop',
  '.env': 'develop', '.gitignore': 'develop', '.dockerfile': 'develop',
  '.gradle': 'develop', '.toml': 'develop', '.ini': 'develop', '.cfg': 'develop',
  '.conf': 'develop', '.properties': 'develop', '.proto': 'develop',
  '.graphql': 'develop', '.gql': 'develop', '.vue': 'develop', '.svelte': 'develop',
};

// ── 文件名启发式规则 ──────────────────────────────────────
// 检查文件名中是否包含特定关键词，用于辅助判断
const NAME_PATTERNS = [
  {
    pattern: /(?:invoice|invoice_|账单|发票|结算|对账|报税|tax|receipt)/i,
    category: 'work',
    weight: 0.8,
    reason: '文件名包含财务相关关键词',
  },
  {
    pattern: /(?:resume|cv|简历|portfolio|作品集)/i,
    category: 'personal',
    weight: 0.8,
    reason: '文件名包含简历/作品集关键词',
  },
  {
    pattern: /(?:screenshot|screen_shot|截图|snip|capture)/i,
    category: 'personal',
    weight: 0.6,
    reason: '文件名包含截图关键词',
  },
  {
    pattern: /(?:contract|合同|协议|agreement|nda)/i,
    category: 'work',
    weight: 0.8,
    reason: '文件名包含合同/协议关键词',
  },
  {
    pattern: /(?:report|报告|summary|总结|meeting|会议|memo)/i,
    category: 'work',
    weight: 0.6,
    reason: '文件名包含报告/会议关键词',
  },
  {
    pattern: /(?:photo|photo_|picture|img_|image_|dsc_|pict)/i,
    category: 'image',
    weight: 0.5,
    reason: '文件名包含照片关键词',
  },
  {
    pattern: /(?:backup|备份|bak|old|旧)/i,
    category: 'temp',
    weight: 0.5,
    reason: '文件名包含备份/旧文件关键词',
  },
  {
    pattern: /(?:install|setup|installer|安装)/i,
    category: 'installer',
    weight: 0.7,
    reason: '文件名包含安装/设置关键词',
  },
  {
    pattern: /(?:video_|movie|film|clip|剪辑|vid_)/i,
    category: 'video',
    weight: 0.5,
    reason: '文件名包含视频关键词',
  },
  {
    pattern: /(?:song|music|track|song_|音频|录音)/i,
    category: 'audio',
    weight: 0.5,
    reason: '文件名包含音频关键词',
  },
  {
    pattern: /(?:draft|草稿|tmp|temp|scratch|wip)/i,
    category: 'temp',
    weight: 0.5,
    reason: '文件名包含草稿/临时关键词',
  },
];

// ── 默认目标子目录 ────────────────────────────────────────
const DEFAULT_TARGET_DIRS = {
  document: '文档',
  image: '图片',
  video: '视频',
  audio: '音频',
  archive: '压缩文件',
  installer: '安装包',
  temp: '临时文件',
  develop: '开发资料',
  work: '工作资料',
  personal: '个人资料',
  other: '其他',
};

/**
 * 基于规则对单个文件进行分类。
 *
 * @param {object} file  文件条目 (来自 scanner)
 * @param {object} [config]  分类配置
 * @returns {{category: string, confidence: number, reason: string, method: string}}
 */
function classifyByRules(file, config = {}) {
  const ext = '.' + (file.extension || '').toLowerCase();
  const basename = file.name;
  const nameWithoutExt = path.basename(basename, path.extname(basename)).toLowerCase();

  // 1. 扩展名规则
  if (ext && EXT_RULES[ext]) {
    const category = EXT_RULES[ext];
    return {
      category,
      confidence: 0.9,
      reason: `扩展名 "${ext}" 匹配 ${CATEGORIES[category].label} 分类`,
      method: 'extension',
    };
  }

  // 2. 无扩展名文件 — 检查文件名模式
  let bestMatch = null;
  let bestWeight = 0;

  for (const { pattern, category, weight, reason } of NAME_PATTERNS) {
    if (pattern.test(basename) || pattern.test(nameWithoutExt)) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestMatch = { category, weight, reason };
      }
    }
  }

  if (bestMatch && bestWeight >= 0.5) {
    return {
      category: bestMatch.category,
      confidence: bestWeight,
      reason: bestMatch.reason,
      method: 'name_pattern',
    };
  }

  // 3. 特殊情况：无扩展名的大文件可能是视频/音频
  if (file.size > 10 * 1024 * 1024) {
    return {
      category: 'other',
      confidence: 0.3,
      reason: '无扩展名且文件较大，无法确定类型',
      method: 'fallback',
    };
  }

  // 4. 默认归为其他
  return {
    category: 'other',
    confidence: 0.5,
    reason: ext ? `扩展名 "${ext}" 未匹配已知分类` : '无扩展名，无法确定类型',
    method: 'fallback',
  };
}

/**
 * 批量分类文件。
 *
 * @param {object[]} files  文件列表
 * @param {object} [config]
 * @param {object} [config.llm]  LLM 配置 {enabled, endpoint, apiKey, model}
 * @returns {Promise<Array<Object & {category, confidence, reason, method}>>}
 */
async function classifyFiles(files, config = {}) {
  // 先用规则分类
  const results = files.map(file => {
    const ruleResult = classifyByRules(file, config);
    return {
      ...file,
      category: ruleResult.category,
      confidence: ruleResult.confidence,
      reason: ruleResult.reason,
      method: ruleResult.method,
    };
  });

  // 如果启用了 LLM，对低置信度的文件进行 AI 辅助分类
  if (config.llm && config.llm.enabled && config.llm.apiKey) {
    const lowConfidence = results.filter(r => r.confidence < 0.7);
    if (lowConfidence.length > 0) {
      try {
        const llmResults = await classifyWithLLM(lowConfidence, config.llm);
        // 合并 LLM 结果
        for (const llmResult of llmResults) {
          const idx = results.findIndex(r => r.path === llmResult.path);
          if (idx >= 0) {
            results[idx] = {
              ...results[idx],
              category: llmResult.category,
              confidence: llmResult.confidence,
              reason: llmResult.reason,
              method: 'llm',
            };
          }
        }
      } catch (err) {
        // LLM 调用失败，保持规则分类结果
        console.warn('[classifier] LLM 分类失败，使用规则结果:', err.message);
      }
    }
  }

  return results;
}

/**
 * 调用 LLM 进行批量分类。
 *
 * @param {object[]} files  待分类文件
 * @param {object} llmConfig  LLM 配置
 * @returns {Promise<Array<{path, category, confidence, reason}>>}
 */
async function classifyWithLLM(files, llmConfig) {
  const { endpoint, apiKey, model } = llmConfig;

  // 构建 prompt
  const fileList = files.map(f =>
    `- ${f.name} (扩展名: .${f.extension || '无'}, 大小: ${f.size} bytes)`
  ).join('\n');

  const categoryList = Object.entries(CATEGORIES)
    .map(([key, val]) => `${key}（${val.label}）`)
    .join('、');

  const prompt = `你是文件分类助手。请根据文件名和扩展名，将以下文件分类到最合适的类别中。

可选类别：${categoryList}

文件列表：
${fileList}

请以 JSON 数组格式返回结果，每个元素包含：
{ "path": "文件完整路径", "category": "类别名", "confidence": 0-1之间的数字, "reason": "简短理由" }

只返回 JSON 数组，不要其他文字。`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个文件分类专家。只返回 JSON 数组。' },
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

  // 尝试提取 JSON 数组
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('LLM 返回格式无效，无法提取 JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return parsed;
}

/**
 * 获取所有可用分类。
 */
function getCategories() {
  return Object.entries(CATEGORIES).map(([key, val]) => ({
    key,
    label: val.label,
    color: val.color,
    icon: val.icon,
  }));
}

/**
 * 获取分类的默认目标子目录名。
 */
function getCategoryTargetDir(categoryKey) {
  return DEFAULT_TARGET_DIRS[categoryKey] || '其他';
}

module.exports = {
  classifyByRules,
  classifyFiles,
  classifyWithLLM,
  getCategories,
  getCategoryTargetDir,
  CATEGORIES,
};