import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../config/env';
import { readCookie, verifySession, SESSION_COOKIE } from '../utils/auth';

/**
 * Protege rotas de diagnóstico com QUALQUER um dos dois métodos:
 * 1) sessão de login válida (cookie pv_session — fluxo normal da tela);
 * 2) ADMIN_KEY via ?key=/x-admin-key (uso em automação/scripts, sem UI).
 * Sem ADMIN_KEY configurada e sem sessão, a rota recusa por padrão —
 * diagnóstico interno não deve ficar aberto ao público.
 */
export function requireAdminKey(req: VercelRequest, res: VercelResponse): boolean {
  const cookieHeader = req.headers.cookie as string | undefined;
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (token && verifySession(token)) return true;

  const env = getEnv();
  if (env.ADMIN_KEY) {
    const provided = (req.query.key as string | undefined) ?? (req.headers['x-admin-key'] as string | undefined);
    if (provided === env.ADMIN_KEY) return true;
  }
  res.status(401).json({ success: false, error: 'unauthorized' });
  return false;
}
