import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CUSTOMERS_COLLECTION } from '../src/constants';
import { listPage } from '../src/services/firestore.service';
import { requireAdminKey } from '../src/middlewares/requireAdminKey';
import { handleApiError } from '../src/utils/handleApiError';
import { CustomerRecord } from '../src/types/customer';

const MODULE = 'customers';
const PAGE_SIZE = 100;

/**
 * Lista paginada de clientes enriquecidos (CRM do pos-venda) — atrás de
 * login, por isso NÃO mascara CPF/CNPJ como o /api/recent (que é só um
 * resumo de diagnóstico). `?cursor=<updatedAt>` continua de onde parou
 * (scroll infinito no front-end).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  try {
    if (!requireAdminKey(req, res)) return;
    const cursor = req.query.cursor ? Number(req.query.cursor) : undefined;
    const page = await listPage<CustomerRecord>(CUSTOMERS_COLLECTION, 'updatedAt', PAGE_SIZE, cursor);

    res.status(200).json({
      success: true,
      total: page.items.length,
      nextCursor: page.nextCursor,
      clientes: page.items.map((c) => ({
        cpf: c.id,
        nome: c.nome,
        email: c.email,
        telefone: c.celular || c.telefone,
        endereco: c.endereco,
        origem: c.source,
        tipoPessoa: c.tipoPessoa ?? null,
        notas: c.notas ?? null,
        tags: c.tags ?? [],
        atualizadoEm: new Date(c.updatedAt).toISOString(),
      })),
    });
  } catch (err) {
    handleApiError(MODULE, err, res);
  }
}
