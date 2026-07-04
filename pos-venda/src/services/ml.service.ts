import { ML_API_BASE, ML_AUTH_DOC } from '../constants';
import { logger } from '../utils/logger';
import { createHttpClient, withRetry } from '../utils/retry';
import { readDoc } from './firestore.service';

const MODULE = 'mercado-livre';
const http = createHttpClient();

interface StoredMlTokens {
  readonly accessToken?: string;
  readonly accessExpiresAt?: number;
}

/**
 * Usa APENAS o access token válido mantido pelo sistema principal
 * (ml_auth/tokens). Este serviço NÃO renova o token do ML de propósito:
 * o refresh_token do ML é de uso único e a renovação concorrente com o
 * sistema principal derrubaria a conexão do usuário.
 */
async function getMlAccessToken(): Promise<string | null> {
  const stored = await readDoc<StoredMlTokens>(ML_AUTH_DOC.collection, ML_AUTH_DOC.doc);
  if (stored?.accessToken && stored.accessExpiresAt && Date.now() < stored.accessExpiresAt) {
    return stored.accessToken;
  }
  logger.warn(MODULE, 'access token do ML ausente/expirado — enriquecimento via ML indisponível');
  return null;
}

interface MlOrder {
  readonly buyer?: {
    readonly first_name?: string;
    readonly last_name?: string;
    readonly billing_info?: { readonly doc_number?: string };
    readonly phone?: { readonly area_code?: string; readonly number?: string };
  };
}

export interface MlBuyerInfo {
  readonly document: string | null;
  readonly phone: string | null;
  readonly nome: string | null;
}

/**
 * Resolve o pedido apontado pelo webhook (`resource: "/orders/123"`) e
 * extrai documento, telefone e nome do comprador quando o ML os expõe.
 * Endereço completo não vem no pedido — só no recurso de envio
 * (`/shipments/{id}`), fora do escopo atual (o ML entrega só telefone e
 * documento de forma confiável aqui).
 */
export async function getBuyerFromResource(resource: string): Promise<MlBuyerInfo | null> {
  if (!/^\/orders\/\d+$/.test(resource)) return null;
  const token = await getMlAccessToken();
  if (!token) return null;

  try {
    const order = await withRetry<MlOrder>(MODULE, async (signal) => {
      const res = await http.get<MlOrder>(`${ML_API_BASE}${resource}`, {
        signal,
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.data;
    });
    const doc = order.buyer?.billing_info?.doc_number ?? null;
    const p = order.buyer?.phone;
    const phone = p?.number ? `${p.area_code ?? ''}${p.number}`.trim() : null;
    const nomeParts = [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean);
    const nome = nomeParts.length ? nomeParts.join(' ') : null;
    return { document: doc, phone, nome };
  } catch {
    logger.error(MODULE, 'falha ao buscar pedido do webhook', { resource });
    return null;
  }
}
