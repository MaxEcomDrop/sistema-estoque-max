import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CUSTOMERS_COLLECTION, RESOURCE_CACHE_COLLECTION } from '../src/constants';
import { listRecent } from '../src/services/firestore.service';
import { requireAdminKey } from '../src/middlewares/requireAdminKey';
import { handleApiError } from '../src/utils/handleApiError';

const MODULE = 'recent';

/** Mascara um CPF/CNPJ para exibição: mantém só os 3 primeiros dígitos. */
function maskDocument(doc: string): string {
  return doc.length > 3 ? `${doc.slice(0, 3)}${'*'.repeat(doc.length - 3)}` : '***';
}

interface CustomerDoc {
  readonly cpf: string;
  readonly telefone: string | null;
  readonly celular: string | null;
  readonly email: string | null;
  readonly source: string;
  readonly updatedAt: number;
}
interface ResourceCacheDoc {
  readonly document: string;
  readonly resolvedAt: number;
}

/** Últimos eventos processados — só para conferir que o fluxo está vivo. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  try {
    if (!requireAdminKey(req, res)) return;
    const [customers, resources] = await Promise.all([
      listRecent<CustomerDoc>(CUSTOMERS_COLLECTION, 'updatedAt', 20),
      listRecent<ResourceCacheDoc>(RESOURCE_CACHE_COLLECTION, 'resolvedAt', 20),
    ]);

    res.status(200).json({
      success: true,
      clientes: customers.map((c) => ({
        cpf: maskDocument(c.id),
        temTelefone: !!(c.telefone || c.celular),
        temEmail: !!c.email,
        origem: c.source,
        atualizadoEm: new Date(c.updatedAt).toISOString(),
      })),
      eventosResolvidos: resources.map((r) => ({
        recurso: r.id,
        cpf: maskDocument(r.document),
        resolvidoEm: new Date(r.resolvedAt).toISOString(),
      })),
    });
  } catch (err) {
    handleApiError(MODULE, err, res);
  }
}
