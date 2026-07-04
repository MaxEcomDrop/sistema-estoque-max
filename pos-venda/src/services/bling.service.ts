import { getEnv } from '../config/env';
import {
  BLING_API_BASE,
  BLING_AUTH_DOC,
  BLING_LEASE_DOC,
  BLING_TOKEN_URL,
  REFRESH_LEASE_MS,
} from '../constants';
import { BlingContact, EnderecoInfo } from '../types/customer';
import { logger } from '../utils/logger';
import { createHttpClient, withRetry } from '../utils/retry';
import { acquireLease, readDoc, upsertDoc } from './firestore.service';

const MODULE = 'bling';
const http = createHttpClient();

interface StoredTokens {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly accessExpiresAt?: number;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

/**
 * Devolve um access_token válido do Bling.
 * Decisão de arquitetura (opção A): os tokens são COMPARTILHADOS com o
 * sistema principal via Firestore (bling_auth/tokens). O refresh_token do
 * Bling é de USO ÚNICO — a renovação é protegida por lease transacional
 * para nunca queimar o mesmo refresh em corrida.
 */
export async function getBlingAccessToken(): Promise<string | null> {
  const stored = await readDoc<StoredTokens>(BLING_AUTH_DOC.collection, BLING_AUTH_DOC.doc);
  if (!stored?.refreshToken && !stored?.accessToken) {
    logger.warn(MODULE, 'nenhum token Bling no Firestore — conecte o Bling no sistema principal');
    return null;
  }
  if (stored.accessToken && stored.accessExpiresAt && Date.now() < stored.accessExpiresAt) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) return null;

  const won = await acquireLease(BLING_LEASE_DOC.collection, BLING_LEASE_DOC.doc, REFRESH_LEASE_MS);
  if (!won) {
    // Outra instância está renovando agora; espera e relê o resultado dela.
    await new Promise((r) => setTimeout(r, 2_000));
    const again = await readDoc<StoredTokens>(BLING_AUTH_DOC.collection, BLING_AUTH_DOC.doc);
    return again?.accessToken ?? null;
  }

  const env = getEnv();
  const basic = Buffer.from(`${env.BLING_CLIENT_ID}:${env.BLING_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
  });

  try {
    const data = await withRetry<TokenResponse>(MODULE, async (signal) => {
      const res = await http.post<TokenResponse>(BLING_TOKEN_URL, body.toString(), {
        signal,
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      return res.data;
    });
    const accessExpiresAt = Date.now() + ((data.expires_in ?? 21_600) - 120) * 1_000;
    await upsertDoc(BLING_AUTH_DOC.collection, BLING_AUTH_DOC.doc, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? stored.refreshToken,
      accessExpiresAt,
    });
    logger.info(MODULE, 'access token renovado e persistido');
    return data.access_token;
  } catch {
    logger.error(MODULE, 'falha ao renovar token (refresh pode ter sido rejeitado)');
    return null;
  }
}

interface BlingEnderecoRaw {
  readonly endereco?: string;
  readonly numero?: string;
  readonly bairro?: string;
  readonly municipio?: string;
  readonly cidade?: string;
  readonly uf?: string;
  readonly estado?: string;
  readonly cep?: string;
}
interface BlingContactRaw {
  readonly nome?: string;
  readonly telefone?: string;
  readonly celular?: string;
  readonly email?: string;
  readonly numeroDocumento?: string;
  readonly endereco?: { readonly geral?: BlingEnderecoRaw } & BlingEnderecoRaw;
}

/** Mesmo formato usado pelo sistema principal (`/api/clientes`): o endereço
 *  do Bling vem em `endereco.geral` ou direto em `endereco`, com nomes de
 *  campo que variam (`municipio`/`cidade`, `uf`/`estado`). */
function extractEndereco(raw: BlingContactRaw['endereco']): EnderecoInfo | null {
  const end = raw?.geral ?? raw;
  if (!end) return null;
  const municipio = end.municipio || end.cidade || null;
  const uf = end.uf || end.estado || null;
  const logradouro = end.endereco || null;
  const numero = end.numero || null;
  const bairro = end.bairro || null;
  const cep = end.cep || null;
  if (!municipio && !uf && !logradouro && !numero && !bairro && !cep) return null;
  return { logradouro, numero, bairro, municipio, uf, cep };
}

/**
 * Busca o contato no Bling pelo documento (CPF/CNPJ já limpo) e extrai
 * nome/telefone/celular/email/endereço — exatamente como retornados
 * (máscaras incluídas), sem qualquer transformação.
 */
export async function findContactByDocument(cleanDoc: string): Promise<BlingContact | null> {
  const token = await getBlingAccessToken();
  if (!token) return null;

  const data = await withRetry<{ data?: BlingContactRaw[] }>(MODULE, async (signal) => {
    const res = await http.get<{ data?: BlingContactRaw[] }>(`${BLING_API_BASE}/contatos`, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
      params: { numeroDocumento: cleanDoc, limite: 1, pagina: 1 },
    });
    return res.data;
  });

  const contact = Array.isArray(data?.data) ? data.data[0] : undefined;
  if (!contact) {
    logger.info(MODULE, 'contato não encontrado no Bling', { doc: cleanDoc.slice(0, 5) + '***' });
    return null;
  }
  return {
    nome: contact.nome?.trim() || null,
    telefone: contact.telefone?.trim() || null,
    celular: contact.celular?.trim() || null,
    email: contact.email?.trim() || null,
    endereco: extractEndereco(contact.endereco),
  };
}

interface ContatoAninhado {
  readonly numeroDocumento?: string;
  readonly celular?: string;
  readonly telefone?: string;
}
interface ResourceDetailResponse {
  readonly data?: { readonly contato?: ContatoAninhado };
}

/**
 * Webhooks de "Pedido" e "Nota Fiscal" no Bling trazem só o ID do registro
 * (não o contato completo) — é preciso buscar o recurso pra extrair o
 * documento do comprador. Como não sabemos de qual módulo veio o ID sem
 * uma pista mais forte, tentamos pedido de venda primeiro e, se não
 * existir (404), tentamos nota fiscal.
 */
export async function findContactByResourceId(
  resourceId: string,
): Promise<{ readonly numeroDocumento: string | null; readonly celular: string | null; readonly telefone: string | null } | null> {
  const token = await getBlingAccessToken();
  if (!token) return null;

  const tryFetch = async (path: string): Promise<ContatoAninhado | null> => {
    try {
      const data = await withRetry<ResourceDetailResponse>(MODULE, async (signal) => {
        const res = await http.get<ResourceDetailResponse>(`${BLING_API_BASE}${path}/${resourceId}`, {
          signal,
          headers: { Authorization: `Bearer ${token}` },
        });
        return res.data;
      });
      return data.data?.contato ?? null;
    } catch {
      return null;
    }
  };

  const contato =
    (await tryFetch('/pedidos/vendas')) ?? (await tryFetch('/nfe'));
  if (!contato) {
    logger.info(MODULE, 'recurso do webhook não encontrado (nem pedido, nem nfe)', { resourceId });
    return null;
  }
  return {
    numeroDocumento: contato.numeroDocumento?.trim() || null,
    celular: contato.celular?.trim() || null,
    telefone: contato.telefone?.trim() || null,
  };
}
