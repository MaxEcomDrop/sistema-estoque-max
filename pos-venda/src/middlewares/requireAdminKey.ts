import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../config/env';

/**
 * Protege rotas de diagnóstico com uma chave simples (?key= ou header
 * x-admin-key). Sem ADMIN_KEY configurada, a rota fica aberta — aceitável
 * para um ambiente de validação inicial, mas deve ser definida em produção.
 */
export function requireAdminKey(req: VercelRequest, res: VercelResponse): boolean {
  const env = getEnv();
  if (!env.ADMIN_KEY) return true;
  const provided = (req.query.key as string | undefined) ?? (req.headers['x-admin-key'] as string | undefined);
  if (provided === env.ADMIN_KEY) return true;
  res.status(401).json({ success: false, error: 'unauthorized' });
  return false;
}
