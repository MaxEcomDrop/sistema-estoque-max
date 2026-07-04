import { getEnv } from '../config/env';
import { getCustomer, upsertCustomer } from '../repositories/customer.repository';
import { findContactByDocument } from '../services/bling.service';
import { getBuyerFromResource } from '../services/ml.service';
import { CaptureResult, WebhookSource } from '../types/customer';
import { dedupe } from '../utils/cache';
import { cleanDocument } from '../utils/cleanDocument';
import { logger } from '../utils/logger';

const MODULE = 'webhook';

/** Chaves que podem carregar CPF/CNPJ nos payloads do Bling. */
const DOCUMENT_KEYS = new Set([
  'numerodocumento',
  'cpf',
  'cnpj',
  'documento',
  'cpfcnpj',
  'doc_number',
]);

/**
 * Varredura determinística em profundidade procurando um documento válido.
 * Payloads de webhook do Bling variam por evento (pedido, contato, NF-e);
 * esta busca cobre todos sem acoplar a um formato específico.
 */
function findDocumentDeep(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (DOCUMENT_KEYS.has(key.toLowerCase())) {
      const doc = cleanDocument(val);
      if (doc) return doc;
    }
    const nested = findDocumentDeep(val, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function isMlNotification(payload: Record<string, unknown>): boolean {
  return typeof payload['resource'] === 'string' && typeof payload['topic'] === 'string';
}

/**
 * Fluxo principal:
 * 1. identifica a origem (Bling ou Mercado Livre);
 * 2. resolve o documento do comprador;
 * 3. respeita o cache (customers/{cpf} + CACHE_TTL_HOURS);
 * 4. no cache frio, consulta o Bling e faz upsert de telefone/celular/email.
 */
export async function handleWebhook(payload: Record<string, unknown>): Promise<CaptureResult> {
  const env = getEnv();
  const ttlMs = env.CACHE_TTL_HOURS * 3_600_000;

  let source: WebhookSource = 'bling';
  let document = findDocumentDeep(payload);
  let mlPhoneFallback: string | null = null;

  if (!document && isMlNotification(payload)) {
    source = 'mercado_livre';
    const buyer = await getBuyerFromResource(String(payload['resource']));
    if (buyer) {
      document = cleanDocument(buyer.document);
      mlPhoneFallback = buyer.phone;
    }
  }

  if (!document) {
    // Sem documento não há chave de cache — reconhece o webhook e segue.
    logger.warn(MODULE, 'payload sem CPF/CNPJ identificável; nada a fazer');
    return { success: true, action: 'skipped', reason: 'document_not_found' };
  }

  return dedupe(document, async (): Promise<CaptureResult> => {
    const existing = await getCustomer(document);
    if (existing && Date.now() - existing.updatedAt < ttlMs) {
      logger.info(MODULE, 'cache válido — Bling não consultado');
      return { success: true, action: 'cache_hit', cpf: document };
    }

    const contact = await findContactByDocument(document);
    if (!contact && !mlPhoneFallback) {
      logger.warn(MODULE, 'contato indisponível no Bling e sem fallback do ML');
      return { success: true, action: 'skipped', cpf: document, reason: 'contact_not_found' };
    }

    await upsertCustomer({
      cpf: document,
      telefone: contact?.telefone ?? mlPhoneFallback,
      celular: contact?.celular ?? null,
      email: contact?.email ?? null,
      source,
      updatedAt: Date.now(),
    });
    logger.info(MODULE, 'contato atualizado no cache', { source });
    return { success: true, action: 'refreshed', cpf: document };
  });
}
