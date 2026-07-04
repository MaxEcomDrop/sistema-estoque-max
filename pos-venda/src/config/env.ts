import { z } from 'zod';
import { DEFAULT_CACHE_TTL_HOURS } from '../constants';

/**
 * Validação centralizada das variáveis de ambiente (zod).
 * Falha de configuração derruba a inicialização — nunca meio-funciona.
 */
const envSchema = z.object({
  FIREBASE_SERVICE_ACCOUNT: z.string().min(1, 'FIREBASE_SERVICE_ACCOUNT é obrigatória'),
  FIRESTORE_DB_ID: z.string().optional(),
  BLING_CLIENT_ID: z.string().min(1, 'BLING_CLIENT_ID é obrigatória'),
  BLING_CLIENT_SECRET: z.string().min(1, 'BLING_CLIENT_SECRET é obrigatória'),
  BLING_WEBHOOK_SECRET: z.string().optional(),
  ML_APP_ID: z.string().optional(),
  CACHE_TTL_HOURS: z.coerce.number().positive().default(DEFAULT_CACHE_TTL_HOURS),
  NODE_ENV: z.string().default('production'),
  /** Protege /api/status e /api/recent (tela de diagnóstico). Sem ela, as
   *  rotas ficam abertas — defina em produção. */
  ADMIN_KEY: z.string().optional(),
});

export interface ServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
}

export interface Env extends z.infer<typeof envSchema> {
  readonly serviceAccount: ServiceAccount;
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.parse(process.env);

  let serviceAccount: ServiceAccount;
  try {
    serviceAccount = JSON.parse(parsed.FIREBASE_SERVICE_ACCOUNT) as ServiceAccount;
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT não é um JSON válido');
  }
  if (!serviceAccount.project_id || !serviceAccount.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT incompleta (project_id/private_key ausentes)');
  }

  cached = { ...parsed, serviceAccount };
  return cached;
}
