import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CUSTOMERS_COLLECTION } from '../src/constants';
import { listRecent } from '../src/services/firestore.service';
import { requireAdminKey } from '../src/middlewares/requireAdminKey';
import { handleApiError } from '../src/utils/handleApiError';
import { CustomerRecord } from '../src/types/customer';

const MODULE = 'customers';
const MAX_RESULTS = 500;

/**
 * Lista completa de clientes enriquecidos (CRM do pos-venda) — atrás de
 * login, por isso NÃO mascara CPF/CNPJ como o /api/recent (que é só um
 * resumo de diagnóstico).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  try {
    if (!requireAdminKey(req, res)) return;
    const clientes = await listRecent<CustomerRecord>(CUSTOMERS_COLLECTION, 'updatedAt', MAX_RESULTS);

    res.status(200).json({
      success: true,
      total: clientes.length,
      clientes: clientes.map((c) => ({
        cpf: c.id,
        nome: c.nome,
        email: c.email,
        telefone: c.celular || c.telefone,
        endereco: c.endereco,
        origem: c.source,
        atualizadoEm: new Date(c.updatedAt).toISOString(),
      })),
    });
  } catch (err) {
    handleApiError(MODULE, err, res);
  }
}
