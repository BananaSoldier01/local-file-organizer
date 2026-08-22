/**
 * decision-provider.js — Decision Provider Abstraction (V0.5.3)
 *
 * 统一 Decision Provider 接口。
 * 将 Memory / Relationship / Classification / State 等决策来源抽象为 Provider。
 *
 * 为未来 LLM / Embedding Provider 预留接口。
 *
 * 统一输出格式：
 * {
 *   source: "",
 *   target: "",
 *   confidence: 0,
 *   priority: 0,
 *   evidence: [{ type: "", detail: "" }]
 * }
 */

const memory = require('./memory');
const fileState = require('./file-state');
const relationshipState = require('./relationship-state');

// ── Provider 接口 ─────────────────────────────────────────
/**
 * Decision Provider 基类。
 * 所有 Provider 必须实现 evaluate() 方法。
 */
class DecisionProvider {
  constructor(name, priority = 0) {
    this.name = name;
    this.priority = priority;
  }

  /**
   * 评估文件，返回候选决策。
   * @param {object} file - 分类后的文件
   @param {object} context - 决策上下文
   * @returns {object|null} 候选决策，不参与时返回 null
   */
  evaluate(file, context) {
    throw new Error('Provider must implement evaluate()');
  }

  /**
   * 检查此 Provider 是否适用于当前文件。
   * @param {object} file
   * @param {object} context
   * @returns {boolean}
   */
  applicable(file, context) {
    return true;
  }
}

// ── 内置 Provider ─────────────────────────────────────────
/**
 * User Override Provider — 最高优先级。
 */
class UserOverrideProvider extends DecisionProvider {
  constructor() {
    super('user_override', 100);
  }

  evaluate(file, context) {
    if (!file._userOverride) return null;
    const customTargets = context.options?.customTargets || {};
    return {
      source: this.name,
      target: customTargets[file.suggestedTarget] || file.suggestedTarget || '其他',
      confidence: 1.0,
      priority: this.priority,
      evidence: [{
        type: 'user_action',
        detail: `用户手工修改目标目录为 "${file.suggestedTarget}"`,
      }],
    };
  }
}

/**
 * Memory Provider — 用户偏好记忆。
 */
class MemoryProvider extends DecisionProvider {
  constructor() {
    super('memory', 80);
  }

  evaluate(file, context) {
    const memSug = memory.lookupMemorySuggestion(file);
    if (!memSug || !memSug.participates) return null;

    const isTrusted = memSug.level === 'trusted';
    const customTargets = context.options?.customTargets || {};

    return {
      source: isTrusted ? 'trusted_memory' : 'learned_memory',
      target: customTargets[memSug.target] || memSug.target,
      confidence: memSug.confidence,
      priority: isTrusted ? 100 : 80,
      evidence: [{
        type: 'memory',
        detail: memSug.reason,
        memoryId: memSug.entries?.[0]?.id || '',
        level: memSug.level,
        score: memSug.confidence,
        matchScore: memSug.matchScore,
      }],
    };
  }
}

/**
 * Organization State Provider — 文件历史组织状态。
 */
class OrganizationStateProvider extends DecisionProvider {
  constructor() {
    super('existing_org_state', 60);
  }

  evaluate(file, context) {
    const targets = fileState.getOrganizationTargets ?
      fileState.getOrganizationTargets() : new Map();
    const existingTarget = targets.get(file.path);

    if (!existingTarget) return null;

    return {
      source: this.name,
      target: existingTarget,
      confidence: 0.85,
      priority: this.priority,
      evidence: [{
        type: 'file_state',
        detail: `File State 记录该文件历史目标为 "${existingTarget}"`,
      }],
    };
  }
}

/**
 * Relationship State Provider — 持久化关系组。
 */
class RelationshipStateProvider extends DecisionProvider {
  constructor() {
    super('relationship_state', 40);
  }

  evaluate(file, context) {
    const relGroup = relationshipState.getGroupContaining ?
      relationshipState.getGroupContaining(file.path) : null;

    if (!relGroup) return null;

    return {
      source: this.name,
      target: relGroup.name,
      confidence: relGroup.confidence || 0.7,
      priority: this.priority,
      evidence: [{
        type: 'relationship_state',
        detail: `Relationship State Group "${relGroup.name}"，包含 ${relGroup.files.length} 个文件`,
        groupId: relGroup.groupId,
        entities: [...relGroup.entities],
      }],
    };
  }
}

/**
 * Relationship Engine Provider — 临时关系分析。
 */
class RelationshipProvider extends DecisionProvider {
  constructor() {
    super('relationship', 40);
  }

  evaluate(file, context) {
    const relationshipGroups = context.relationshipGroups;
    if (!relationshipGroups || relationshipGroups.length === 0) return null;

    for (const group of relationshipGroups) {
      const groupFiles = group.files || [];
      const inGroup = groupFiles.some(f => {
        const fId = typeof f === 'string' ? f : (f.path || f.name);
        return fId === (file.path || file.name);
      });
      if (inGroup) {
        const suggestion = (context.groupSuggestions || []).find(s =>
          s.files.some(f => {
            const fId = typeof f === 'string' ? f : (f.path || f.name);
            return fId === (file.path || file.name);
          })
        );
        const groupName = suggestion ? suggestion.groupName : (group.name || '未命名');
        return {
          source: this.name,
          target: groupName,
          confidence: suggestion ? (suggestion.confidence || 0.7) : (group.cohesion || 0.5),
          priority: this.priority,
          evidence: [{
            type: 'relationship',
            detail: suggestion ?
              `Relationship Group "${groupName}"，置信度 ${suggestion.confidence}` :
              `Relationship Group "${groupName}"`,
            cohesion: group.cohesion,
            coreEntities: group.coreEntities ? [...group.coreEntities] : [],
          }],
        };
      }
    }
    return null;
  }
}

/**
 * Classification Provider — 内容分类兜底。
 */
class ClassificationProvider extends DecisionProvider {
  constructor() {
    super('classification', 10);
  }

  evaluate(file, context) {
    const customTargets = context.options?.customTargets || {};
    return {
      source: this.name,
      target: customTargets[file.suggestedTarget] || file.suggestedTarget || '其他',
      confidence: file.confidence || 0.5,
      priority: this.priority,
      evidence: [{
        type: 'classification',
        detail: `Classification: theme="${file.contentTheme}", confidence=${file.confidence}`,
        theme: file.contentTheme,
        confidence: file.confidence,
      }],
    };
  }
}

// ── 未来 Provider Stub ────────────────────────────────────
/**
 * LLM Provider — 预留接口（V0.5.5）。
 * 当前返回 null，不引入模型依赖。
 */
class LLMDecisionProvider extends DecisionProvider {
  constructor() {
    super('llm', 90);
  }

  evaluate(file, context) {
    // V0.5.5: 待实现
    return null;
  }
}

/**
 * Embedding Provider — 预留接口（V0.5.5）。
 * 当前返回 null，不引入模型依赖。
 */
class EmbeddingDecisionProvider extends DecisionProvider {
  constructor() {
    super('embedding', 70);
  }

  evaluate(file, context) {
    // V0.5.5: 待实现
    return null;
  }
}

// ── Provider 注册表 ────────────────────────────────────────
const DEFAULT_PROVIDERS = [
  new UserOverrideProvider(),
  new MemoryProvider(),
  new OrganizationStateProvider(),
  new RelationshipStateProvider(),
  new RelationshipProvider(),
  new ClassificationProvider(),
  // 未来 Provider（当前不参与决策）
  new LLMDecisionProvider(),
  new EmbeddingDecisionProvider(),
];

/**
 * 运行所有 Provider，收集候选决策。
 *
 * @param {object} file - 分类后的文件
 * @param {object} context - 决策上下文
 * @param {DecisionProvider[]} [providers] - Provider 列表
 * @returns {object[]} 候选决策列表
 */
function collectCandidates(file, context, providers = DEFAULT_PROVIDERS) {
  const candidates = [];
  for (const provider of providers) {
    if (!provider.applicable(file, context)) continue;
    try {
      const result = provider.evaluate(file, context);
      if (result) {
        candidates.push(result);
      }
    } catch (err) {
      console.error(`[decision-provider] ${provider.name} 失败:`, err.message);
    }
  }
  return candidates;
}

/**
 * 获取所有已注册的 Provider。
 *
 * @returns {DecisionProvider[]}
 */
function getProviders() {
  return DEFAULT_PROVIDERS;
}

/**
 * 根据名称获取 Provider。
 *
 * @param {string} name
 * @returns {DecisionProvider|null}
 */
function getProvider(name) {
  return DEFAULT_PROVIDERS.find(p => p.name === name) || null;
}

module.exports = {
  DecisionProvider,
  UserOverrideProvider,
  MemoryProvider,
  OrganizationStateProvider,
  RelationshipStateProvider,
  RelationshipProvider,
  ClassificationProvider,
  LLMDecisionProvider,
  EmbeddingDecisionProvider,
  collectCandidates,
  getProviders,
  getProvider,
  DEFAULT_PROVIDERS,
};