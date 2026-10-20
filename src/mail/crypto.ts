/**
 * src/mail/crypto.ts —— 邮箱凭证的加密存储（T1，2026-10-20）
 *
 * 为什么单独一个文件：
 *   邮箱密码泄露的后果和 API token 不是一个量级 —— 邮箱能改密码、
 *   能收验证码、能冒充本人，等于身份被盗。所以加密逻辑要独立、
 *   要能被单元测试直接打，不能埋在业务里。
 *
 * 设计（照抄 OpenMuse 的 vault.ts 思路，但密钥来源不同）：
 *   - AES-256-GCM，带版本前缀，方便以后换算法而不破坏已有密文
 *   - 信封格式：`v1.<nonce-hex>.<tag-hex>.<ciphertext-hex>`
 *   - 密钥必须是 32 字节 base64，长度不对**直接抛错**，不静默降级
 *
 * 密钥从哪来：环境变量 DOTD_MAIL_KEY。
 * 为什么不硬编码/不自动生成：自动生成的密钥存在同一个库里，等于没加密。
 * 主人必须自己给一个，这本身就是一道"你确认要接邮箱吗"的门。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12; // GCM 推荐 96 bit

/** 解析 base64 密钥。必须是 32 字节，否则抛错（不降级）。 */
export function decodeKey(keyB64: string): Buffer {
  const buf = Buffer.from(keyB64, 'base64');
  // 严格校验：base64 往返必须一致，防止 'abc' 这种残缺输入被 Buffer 默默接受
  if (buf.length !== 32 || buf.toString('base64').replace(/=+$/, '') !== keyB64.replace(/=+$/, '')) {
    throw new Error('DOTD_MAIL_KEY 必须是 32 字节的 base64（用 openssl rand -base64 32 生成）');
  }
  return buf;
}

/** 加密。返回 `v1.nonce.tag.ciphertext`，可直接存 TEXT 列。 */
export function encryptSecret(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, nonce.toString('hex'), tag.toString('hex'), ct.toString('hex')].join('.');
}

/** 解密。版本不认识 / 密文被改过都会抛错 —— 绝不返回半截明文。 */
export function decryptSecret(envelope: string, keyB64: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 4) throw new Error('凭证密文格式不对（应为 v1.nonce.tag.ciphertext）');
  const [ver, nonceHex, tagHex, ctHex] = parts as [string, string, string, string];
  if (ver !== VERSION) throw new Error(`不支持的凭证版本：${ver}`);
  const key = decodeKey(keyB64);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(nonceHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  // GCM 的认证失败会在这里抛 —— 密文被动过就不可能解出来，这是我们不自己校验的原因
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}

/** 生成一把新密钥，给主人看的那行命令用。 */
export function generateKeyB64(): string {
  return randomBytes(32).toString('base64');
}