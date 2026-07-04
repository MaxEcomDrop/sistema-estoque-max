import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readCookie, verifySession, SESSION_COOKIE } from '../../src/utils/auth';

/** Diz ao front se a sessão atual é válida — decide entre mostrar o painel
 *  ou redirecionar para /login.html, sem expor nada sensível. */
export default function handler(req: VercelRequest, res: VercelResponse): void {
  const token = readCookie(req.headers.cookie as string | undefined, SESSION_COOKIE);
  res.status(200).json({ success: true, autenticado: !!token && verifySession(token) });
}
