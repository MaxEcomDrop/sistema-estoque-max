import { RESOURCE_CACHE_COLLECTION } from '../constants';
import { getEnv } from '../config/env';
import { getCustomer, upsertCustomer } from '../repositories/customer.repository';
import { findContactByDocument, findContactByResourceId } from '../services/bling.service';
import { readDoc, upsertDoc } from '../services/firestore.service';
import { getBuyerFromResource } from '../services/ml.service';
import { CaptureResult, WebhookSource } from '../types/customer';
import { dedupe } from '../utils/cache';
import { cleanDocument } from '../utils/cleanDocument';
import { logger } from '../utils/logger';

interface ResourceCacheEntry {
  readonly document: string;
  readonly telefone: string | null;
  readonly celular: string | null;
  readonly resolvedAt: number;
}

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
 * Webhooks de Pedido/Nota Fiscal do Bling (as únicas categorias disponíveis
 * no painel, já que "Contato" não existe como opção) trazem só o ID do
 * registro alterado — não o comprador. Esta varredura acha o primeiro
 * campo "id" numérico no payload para buscar o recurso completo.
 */
function findIdDeep(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase() === 'id' && (typeof val === 'number' || typeof val === 'string')) {
      const id = String(val).trim();
      if (/^\d+$/.test(id)) return id;
    }
  }
  for (const val of Object.values(value as Record<string, unknown>)) {
    const nested = findIdDeep(val, depth + 1);
    if (nested) return nested;
  }
  return null;
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
  let phoneFallback: string | null = null;
  let celularFallback: string | null = null;
  let nomeFallback: string | null = null;

  if (!document && isMlNotification(payload)) {
    source = 'mercado_livre';
    const buyer = await getBuyerFromResource(String(payload['resource']));
    if (buyer) {
      document = cleanDocument(buyer.document);
      phoneFallback = buyer.phone;
      nomeFallback = buyer.nome;
    }
  } else if (!document) {
    // Webhook de Pedido/Nota Fiscal do Bling: o payload só traz o ID do
    // registro — busca o recurso completo pra extrair o comprador.
    const resourceId = findIdDeep(payload);
    if (resourceId) {
      // Retries do mesmo evento (comum em webhooks) não devem bater no
      // Bling de novo só pra redescobrir um CPF que já resolvemos.
      const cachedResource = await readDoc<ResourceCacheEntry>(RESOURCE_CACHE_COLLECTION, resourceId);
      if (cachedResource && Date.now() - cachedResource.resolvedAt < ttlMs) {
        document = cachedResource.document;
        phoneFallback = cachedResource.telefone;
        celularFallback = cachedResource.celular;
      } else {
        const resource = await findContactByResourceId(resourceId);
        if (resource?.numeroDocumento) {
          document = cleanDocument(resource.numeroDocumento);
          phoneFallback = resource.telefone;
          celularFallback = resource.celular;
          if (document) {
            await upsertDoc(RESOURCE_CACHE_COLLECTION, resourceId, {
              document,
              telefone: phoneFallback,
              celular: celularFallback,
              resolvedAt: Date.now(),
            });
          }
        }
      }
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

    // Sempre tenta /contatos por último: é a única fonte de e-mail, nome
    // completo e endereço (o fallback via pedido/nfe/ML só traz documento,
    // telefone e, no caso do ML, nome).
    const contact = await findContactByDocument(document);
    if (!contact && !phoneFallback && !celularFallback && !nomeFallback) {
      logger.warn(MODULE, 'contato indisponível no Bling e sem fallback');
      return { success: true, action: 'skipped', cpf: document, reason: 'contact_not_found' };
    }

    await upsertCustomer({
      cpf: document,
      nome: contact?.nome ?? nomeFallback,
      telefone: contact?.telefone ?? phoneFallback,
      celular: contact?.celular ?? celularFallback,
      email: contact?.email ?? null,
      endereco: contact?.endereco ?? null,
      source,
      updatedAt: Date.now(),
    });
    logger.info(MODULE, 'contato atualizado no cache', { source });
    return { success: true, action: 'refreshed', cpf: document };
  });
}
