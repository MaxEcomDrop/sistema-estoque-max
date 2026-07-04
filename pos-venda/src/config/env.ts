import { z } from 'zod';
import { DEFAULT_CACHE_TTL_HOURS } from '../constants';
import { ConfigError } from '../utils/errors';

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
  /** Protege /api/status e /api/recent como alternativa ao login (uso em
   *  automação/testes). Sem ela E sem sessão válida, as rotas recusam. */
  ADMIN_KEY: z.string().optional(),
  /** Login da tela de diagnóstico — mesmo padrão do sistema principal
   *  (comparação em tempo constante + JWT). Opcionais aqui porque só o
   *  endpoint de login exige a presença deles (erro claro na hora certa). */
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  JWT_SECRET: z.string().optional(),
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

  let parsed: z.infer<typeof envSchema>;
  try {
    parsed = envSchema.parse(process.env);
  } catch (e) {
    // zod já lista exatamente qual variável falhou — mensagem segura
    // (nunca inclui valores, só nomes de campo e a regra violada).
    const detail = e instanceof z.ZodError ? e.issues.map((i) => i.message).join('; ') : 'inválida';
    throw new ConfigError(`Variáveis de ambiente inválidas: ${detail}`);
  }

  let serviceAccount: ServiceAccount;
  try {
    serviceAccount = JSON.parse(parsed.FIREBASE_SERVICE_ACCOUNT) as ServiceAccount;
  } catch {
    throw new ConfigError('FIREBASE_SERVICE_ACCOUNT não é um JSON válido');
  }
  if (!serviceAccount.project_id || !serviceAccount.private_key) {
    throw new ConfigError('FIREBASE_SERVICE_ACCOUNT incompleta (project_id/private_key ausentes)');
  }

  cached = { ...parsed, serviceAccount };
  return cached;
}
