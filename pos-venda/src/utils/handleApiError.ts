import type { VercelResponse } from '@vercel/node';
import { ConfigError } from './errors';
import { HttpError } from '../middlewares/validateRequest';
import { logger } from './logger';

/**
 * Resposta de erro única para toda API: distingue 3 casos —
 * 1) HttpError: erro de requisição do CLIENTE (400/401/405) → mensagem já é segura;
 * 2) ConfigError: env var ausente/credencial malformada → 503 + mensagem segura
 *    (some var/regra do zod, nunca um valor/segredo) — ACIONÁVEL por quem administra;
 * 3) qualquer outro erro: 500 genérico, detalhe só no log do servidor (nunca no
 *    corpo da resposta — pode conter caminho de arquivo, stack, etc.).
 */
export function handleApiError(module: string, err: unknown, res: VercelResponse): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof ConfigError) {
    logger.error(module, 'erro de configuração', { message: err.message });
    res.status(503).json({ success: false, error: 'config_error', detail: err.message });
    return;
  }
  logger.error(module, 'erro interno', { message: err instanceof Error ? err.message : 'unknown' });
  res.status(500).json({ success: false, error: 'internal_error' });
}
