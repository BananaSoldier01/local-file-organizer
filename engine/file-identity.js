/**
 * file-identity.js — File Identity Layer (V0.5.1)
 *
 * 多级指纹识别，用于精确检测文件变化。
 *
 * Level 1 (Fast):    size + modified — 默认，用于快速扫描
 * Level 2 (Medium):  partial hash — 文件头尾部分内容
 * Level 3 (Strong):  full hash — 完整内容哈希
 *
 * 原则：
 * - 不默认全量 hash（保持大文件扫描性能）
 * - 与 File State 兼容
 * - 逐级升级，只有必要时才计算更高级别
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 常量 ──────────────────────────────────────────────────
const PARTIAL_HASH_SIZE = 64 * 1024; // 64KB 头尾
const FULL_HASH_ALGORITHM = 'sha256';

// ── Level 1: 快速指纹 ─────────────────────────────────────
/**
 * 计算 Level 1 快速指纹（size + modified）。
 *
 * @param {object} file - 文件信息
 * @returns {string} 指纹字符串
 */
function fastFingerprint(file) {
  const parts = [
    file.path || '',
    file.size || 0,
    file.modified || 0,
  ];
  let hash = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return 'l1_' + Math.abs(hash).toString(16);
}

// ── Level 2: 中级指纹 ─────────────────────────────────────
/**
 * 计算 Level 2 中级指纹（partial hash — 文件头尾各 64KB）。
 *
 * @param {string} filePath - 文件完整路径
 * @returns {string|null} 指纹字符串，失败返回 null
 */
function mediumFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    const size = stat.size;
    const chunks = [];

    // 文件头
    const headFd = fs.openSync(filePath, 'r');
    const headBuf = Buffer.alloc(Math.min(PARTIAL_HASH_SIZE, size));
    fs.readSync(headFd, headBuf, 0, headBuf.length, 0);
    fs.closeSync(headFd);
    chunks.push(headBuf);

    // 文件尾（如果文件足够大）
    if (size > PARTIAL_HASH_SIZE * 2) {
      const tailFd = fs.openSync(filePath, 'r');
      const tailBuf = Buffer.alloc(PARTIAL_HASH_SIZE);
      fs.readSync(tailFd, tailBuf, 0, tailBuf.length, size - PARTIAL_HASH_SIZE);
      fs.closeSync(tailFd);
      chunks.push(tailBuf);
    }

    const hash = crypto.createHash(FULL_HASH_ALGORITHM);
    for (const chunk of chunks) hash.update(chunk);
    return 'l2_' + hash.digest('hex').slice(0, 16);
  } catch (err) {
    return null;
  }
}

// ── Level 3: 强指纹 ───────────────────────────────────────
/**
 * 计算 Level 3 强指纹（full hash）。
 *
 * @param {string} filePath - 文件完整路径
 * @returns {string|null} 指纹字符串，失败返回 null
 */
function strongFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    const hash = crypto.createHash(FULL_HASH_ALGORITHM);
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    return new Promise((resolve, reject) => {
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve('l3_' + hash.digest('hex').slice(0, 16)));
      stream.on('error', reject);
    });
  } catch (err) {
    return null;
  }
}

/**
 * 计算强指纹（同步版本，用于小文件）。
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function strongFingerprintSync(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    // 小文件直接全量读取
    if (stat.size <= 10 * 1024 * 1024) { // 10MB
      const data = fs.readFileSync(filePath);
      const hash = crypto.createHash(FULL_HASH_ALGORITHM).update(data).digest('hex');
      return 'l3_' + hash.slice(0, 16);
    }
    return null; // 大文件用异步版本
  } catch (err) {
    return null;
  }
}

// ── 指纹比较 ──────────────────────────────────────────────
/**
 * 比较两个指纹是否匹配。
 *
 * @param {string} fp1
 * @param {string} fp2
 * @returns {boolean}
 */
function fingerprintsMatch(fp1, fp2) {
  if (!fp1 || !fp2) return false;
  // 不同级别的指纹不能直接比较
  const level1 = fp1.startsWith('l1_');
  const level2 = fp2.startsWith('l2_');
  const level3 = fp3.startsWith('l3_');
  // 同级别比较
  if (fp1.startsWith('l1_') && fp2.startsWith('l1_')) return fp1 === fp2;
  if (fp1.startsWith('l2_') && fp2.startsWith('l2_')) return fp1 === fp2;
  if (fp1.startsWith('l3_') && fp2.startsWith('l3_')) return fp1 === fp2;
  return false;
}

/**
 * 获取指纹级别。
 *
 * @param {string} fp
 * @returns {string} 'l1' | 'l2' | 'l3' | 'unknown'
 */
function fingerprintLevel(fp) {
  if (!fp) return 'unknown';
  if (fp.startsWith('l1_')) return 'l1';
  if (fp.startsWith('l2_')) return 'l2';
  if (fp.startsWith('l3_')) return 'l3';
  return 'unknown';
}

module.exports = {
  fastFingerprint,
  mediumFingerprint,
  strongFingerprint,
  strongFingerprintSync,
  fingerprintsMatch,
  fingerprintLevel,
  PARTIAL_HASH_SIZE,
  FULL_HASH_ALGORITHM,
};