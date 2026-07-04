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
import { cleanDocument } from '../utils/cleanDocument';
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
  readonly id?: number | string;
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

export interface ImportedContact extends BlingContact {
  readonly cpf: string;
}

/** Busca só o ID interno do contato no Bling — usado pra filtrar pedidos
 *  por comprador, já que /pedidos/vendas não filtra por documento. */
export async function findContactId(cleanDoc: string): Promise<number | string | null> {
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
  return contact?.id ?? null;
}

interface PedidoRaw {
  readonly numero?: number | string;
  readonly data?: string;
  readonly situacao?: unknown;
  readonly totalVenda?: number;
  readonly totalProdutos?: number;
  readonly contato?: { readonly id?: number | string };
}
export interface PedidoResumo {
  readonly numero: string;
  readonly data: string | null;
  readonly situacao: unknown;
  readonly valor: number;
}

/**
 * Pedidos de um contato específico, dentro do período informado — o Bling
 * não expõe filtro por documento/contato em `/pedidos/vendas` (só por
 * data), então busca por data e filtra pelo ID do contato no cliente.
 * Por isso é um histórico "dentro do período consultado", não o total
 * desde sempre — honesto sobre essa limitação da API.
 */
export async function listOrdersByContact(
  contactId: number | string,
  dataInicial: string,
  dataFinal: string,
  maxPaginas = 5,
): Promise<ReadonlyArray<PedidoResumo>> {
  const token = await getBlingAccessToken();
  if (!token) return [];

  const pedidos: PedidoResumo[] = [];
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const data = await withRetry<{ data?: PedidoRaw[] }>(MODULE, async (signal) => {
      const res = await http.get<{ data?: PedidoRaw[] }>(`${BLING_API_BASE}/pedidos/vendas`, {
        signal,
        headers: { Authorization: `Bearer ${token}` },
        params: { limite: 100, pagina, dataInicial, dataFinal },
      });
      return res.data;
    });
    const items = Array.isArray(data?.data) ? data.data : [];
    for (const p of items) {
      if (String(p.contato?.id) !== String(contactId)) continue;
      pedidos.push({
        numero: String(p.numero ?? ''),
        data: p.data ?? null,
        situacao: p.situacao ?? null,
        valor: p.totalVenda || p.totalProdutos || 0,
      });
    }
    if (items.length < 100) break;
  }
  return pedidos;
}

/**
 * Uma página de `/contatos` (todos os contatos já cadastrados no Bling, não
 * só os que já dispararam webhook) — usada pela importação inicial única,
 * já que o serviço normalmente só grava contato quando um webhook chega.
 */
export async function listContactsPage(
  pagina: number,
  limite: number,
): Promise<{ readonly contatos: ReadonlyArray<ImportedContact>; readonly hasMore: boolean }> {
  const token = await getBlingAccessToken();
  if (!token) return { contatos: [], hasMore: false };

  const data = await withRetry<{ data?: BlingContactRaw[] }>(MODULE, async (signal) => {
    const res = await http.get<{ data?: BlingContactRaw[] }>(`${BLING_API_BASE}/contatos`, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
      params: { limite, pagina },
    });
    return res.data;
  });

  const raw = Array.isArray(data?.data) ? data.data : [];
  const contatos = raw
    .map((c) => {
      const cpf = cleanDocument(c.numeroDocumento);
      if (!cpf) return null;
      return {
        cpf,
        nome: c.nome?.trim() || null,
        telefone: c.telefone?.trim() || null,
        celular: c.celular?.trim() || null,
        email: c.email?.trim() || null,
        endereco: extractEndereco(c.endereco),
      };
    })
    .filter((c): c is ImportedContact => c !== null);

  return { contatos, hasMore: raw.length === limite };
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
