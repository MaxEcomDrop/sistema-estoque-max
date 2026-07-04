import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminKey } from '../src/middlewares/requireAdminKey';
import { handleApiError } from '../src/utils/handleApiError';
import { importBlingContacts } from '../src/controllers/import.controller';

const MODULE = 'import-bling';

/**
 * Importação única (sob demanda) de todo o cadastro de contatos do Bling —
 * chamada repetidamente pelo front-end (passando `pagina`) até `concluido`,
 * já que uma função serverless não tem tempo pra varrer tudo de uma vez.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  try {
    if (!requireAdminKey(req, res)) return;
    const pagina = Number(req.query.pagina) || 1;
    const result = await importBlingContacts(pagina);
    res.status(200).json(result);
  } catch (err) {
    handleApiError(MODULE, err, res);
  }
}
