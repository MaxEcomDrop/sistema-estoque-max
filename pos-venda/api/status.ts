import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../src/config/env';
import { RESOURCE_CACHE_COLLECTION, CUSTOMERS_COLLECTION, BLING_AUTH_DOC, ML_AUTH_DOC } from '../src/constants';
import { countCollection, pingFirestore, readDoc } from '../src/services/firestore.service';
import { requireAdminKey } from '../src/middlewares/requireAdminKey';
import { handleApiError } from '../src/utils/handleApiError';

const MODULE = 'status';

interface StoredBlingTokens {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly accessExpiresAt?: number;
}
interface StoredMlTokens {
  readonly accessToken?: string;
  readonly accessExpiresAt?: number;
}

/**
 * Diagnóstico ao vivo: prova (não afirma) que cada peça está funcionando —
 * mesmo espírito do /api/diagnostico do sistema principal. Nunca expõe
 * tokens/segredos, só presença + validade.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  try {
    if (!requireAdminKey(req, res)) return;
    const env = getEnv();
    const firestore = await pingFirestore();

    const bling = await readDoc<StoredBlingTokens>(BLING_AUTH_DOC.collection, BLING_AUTH_DOC.doc);
    const ml = await readDoc<StoredMlTokens>(ML_AUTH_DOC.collection, ML_AUTH_DOC.doc);
    const now = Date.now();

    const [customersCount, resourceCacheCount] = firestore.ok
      ? await Promise.all([
          countCollection(CUSTOMERS_COLLECTION).catch(() => -1),
          countCollection(RESOURCE_CACHE_COLLECTION).catch(() => -1),
        ])
      : [-1, -1];

    res.status(200).json({
      success: true,
      firebase: {
        projetoConfigurado: env.serviceAccount.project_id,
        // O sistema principal (Estoque Max) usa o MESMO projeto por decisão
        // de arquitetura — se bater, os tokens do Bling/ML são compartilhados.
        projetoEsperado: 'erp-max-sistema',
        projetoBate: env.serviceAccount.project_id === 'erp-max-sistema',
        firestoreRespondendo: firestore.ok,
        firestoreErro: firestore.error,
        bancoDeDados: env.FIRESTORE_DB_ID || '(default)',
      },
      bling: {
        tokenPresente: !!(bling?.accessToken || bling?.refreshToken),
        accessValido: !!(bling?.accessToken && bling.accessExpiresAt && now < bling.accessExpiresAt),
        expiraEm: bling?.accessExpiresAt ? Math.max(0, Math.round((bling.accessExpiresAt - now) / 1000)) : null,
      },
      mercadoLivre: {
        tokenPresente: !!ml?.accessToken,
        accessValido: !!(ml?.accessToken && ml.accessExpiresAt && now < ml.accessExpiresAt),
        expiraEm: ml?.accessExpiresAt ? Math.max(0, Math.round((ml.accessExpiresAt - now) / 1000)) : null,
      },
      cache: {
        clientesEmCache: customersCount,
        eventosResolvidos: resourceCacheCount,
        cacheTtlHoras: env.CACHE_TTL_HOURS,
      },
      config: {
        webhookSecretConfigurado: !!env.BLING_WEBHOOK_SECRET,
        mlAppIdConfigurado: !!env.ML_APP_ID,
        adminKeyConfigurado: !!env.ADMIN_KEY,
      },
    });
  } catch (err) {
    handleApiError(MODULE, err, res);
  }
}
