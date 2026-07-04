import { timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { getEnv } from '../config/env';
import { ConfigError } from './errors';

export const SESSION_COOKIE = 'pv_session';

/** Compara em tempo constante — evita vazar por timing se a string bate. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) {
    // Ainda compara (tamanho diferente) pra não vazar por tempo de retorno antecipado.
    timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Credenciais do painel de diagnóstico (mesmo par email/senha do sistema
 *  principal, se configurado assim) — exige as 3 variáveis presentes. */
export function checkCredentials(email: string, password: string): boolean {
  const env = getEnv();
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || !env.JWT_SECRET) {
    throw new ConfigError('ADMIN_EMAIL, ADMIN_PASSWORD ou JWT_SECRET não configurados');
  }
  return safeEqual(email, env.ADMIN_EMAIL) && safeEqual(password, env.ADMIN_PASSWORD);
}

export function signSession(email: string): string {
  const env = getEnv();
  if (!env.JWT_SECRET) throw new ConfigError('JWT_SECRET não configurado');
  return jwt.sign({ email }, env.JWT_SECRET, { expiresIn: '7d' });
}

export function verifySession(token: string): boolean {
  const env = getEnv();
  if (!env.JWT_SECRET || !token) return false;
  try {
    jwt.verify(token, env.JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

/** Extrai um cookie específico do header Cookie cru (sem dependências). */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
