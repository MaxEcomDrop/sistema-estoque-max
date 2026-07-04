import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminKey } from '../../src/middlewares/requireAdminKey';
import { handleApiError } from '../../src/utils/handleApiError';
import { readJsonBody } from '../../src/utils/readJsonBody';
import { cleanDocument } from '../../src/utils/cleanDocument';
import { findContactId, listOrdersByContact } from '../../src/services/bling.service';
import { updateCustomerNotes } from '../../src/repositories/customer.repository';

const MODULE = 'customers.detail';
const MAX_DIAS = 3650;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const MAX_NOTAS_LEN = 5000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function handleGet(cpf: string, req: VercelRequest, res: VercelResponse): Promise<void> {
  const dias = Math.min(Math.max(Number(req.query.dias) || 365, 1), MAX_DIAS);
  const dataFinal = isoDate(new Date());
  const dataInicial = isoDate(new Date(Date.now() - dias * 86_400_000));

  const contactId = await findContactId(cpf);
  if (!contactId) {
    res.status(200).json({
      success: true,
      pedidos: [],
      totalGasto: 0,
      numPedidos: 0,
      ultimoPedido: null,
      periodoDias: dias,
      aviso: 'contato não encontrado no Bling — histórico indisponível',
    });
    return;
  }

  const pedidos = await listOrdersByContact(contactId, dataInicial, dataFinal);
  const ordenados = [...pedidos].sort((a, b) => (b.data ?? '').localeCompare(a.data ?? ''));
  const totalGasto = pedidos.reduce((acc, p) => acc + p.valor, 0);
  const ultimoPedido = ordenados[0]?.data ?? null;

  res.status(200).json({
    success: true,
    pedidos: ordenados,
    totalGasto,
    numPedidos: pedidos.length,
    ultimoPedido,
    periodoDias: dias,
  });
}

async function handlePatch(cpf: string, req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = await readJsonBody(req);
  const patch: { notas?: string | null; tags?: string[] | null } = {};

  if ('notas' in body) {
    const notas = body.notas;
    if (notas !== null && typeof notas !== 'string') {
      res.status(400).json({ success: false, error: 'notas_invalida' });
      return;
    }
    if (typeof notas === 'string' && notas.length > MAX_NOTAS_LEN) {
      res.status(400).json({ success: false, error: 'notas_muito_longa' });
      return;
    }
    patch.notas = notas;
  }

  if ('tags' in body) {
    const tags = body.tags;
    if (tags !== null && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) {
      res.status(400).json({ success: false, error: 'tags_invalidas' });
      return;
    }
    if (Array.isArray(tags)) {
      if (tags.length > MAX_TAGS || tags.some((t) => t.length > MAX_TAG_LEN)) {
        res.status(400).json({ success: false, error: 'tags_invalidas' });
        return;
      }
    }
    patch.tags = tags;
  }

  await updateCustomerNotes(cpf, patch);
  res.status(200).json({ success: true });
}

/**
 * Detalhe de um cliente específico: GET devolve histórico de pedidos + LTV
 * (dentro do período consultado — o Bling não filtra pedidos por contato,
 * só por data); PATCH atualiza notas/tags (dado que só existe aqui).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  try {
    if (!requireAdminKey(req, res)) return;
    const cpf = cleanDocument(req.query.cpf);
    if (!cpf) {
      res.status(400).json({ success: false, error: 'cpf_invalido' });
      return;
    }
    if (req.method === 'GET') await handleGet(cpf, req, res);
    else await handlePatch(cpf, req, res);
  } catch (err) {
    handleApiError(MODULE, err, res);
  }
}
