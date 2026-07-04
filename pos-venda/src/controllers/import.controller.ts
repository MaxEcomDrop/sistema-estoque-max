import { listContactsPage } from '../services/bling.service';
import { upsertCustomer } from '../repositories/customer.repository';
import { logger } from '../utils/logger';

const MODULE = 'import';
const PAGE_SIZE = 100;
/** Vercel serverless tem tempo de execução limitado — processa só algumas
 *  páginas por chamada e devolve de onde continuar, em vez de tentar
 *  varrer o cadastro inteiro do Bling numa única invocação. */
const MAX_PAGES_PER_CALL = 3;

export interface ImportResult {
  readonly success: true;
  readonly importados: number;
  readonly paginasProcessadas: number;
  readonly proximaPagina: number | null;
  readonly concluido: boolean;
}

/**
 * Importação única de todo o cadastro de contatos do Bling (não só os que
 * já dispararam webhook) — popula o CRM do pos-venda de uma vez, em vez de
 * esperar pedidos/NF-e novos acontecerem para cada cliente aparecer.
 */
export async function importBlingContacts(startPagina: number): Promise<ImportResult> {
  let pagina = startPagina;
  let importados = 0;
  let paginasProcessadas = 0;
  let hasMore = true;

  while (hasMore && paginasProcessadas < MAX_PAGES_PER_CALL) {
    const page = await listContactsPage(pagina, PAGE_SIZE);
    for (const contato of page.contatos) {
      await upsertCustomer({
        cpf: contato.cpf,
        nome: contato.nome,
        telefone: contato.telefone,
        celular: contato.celular,
        email: contato.email,
        endereco: contato.endereco,
        tipoPessoa: contato.tipoPessoa,
        source: 'bling',
        updatedAt: Date.now(),
      });
      importados += 1;
    }
    hasMore = page.hasMore;
    paginasProcessadas += 1;
    pagina += 1;
  }

  logger.info(MODULE, 'lote de importação concluído', { importados, paginasProcessadas, hasMore });
  return {
    success: true,
    importados,
    paginasProcessadas,
    proximaPagina: hasMore ? pagina : null,
    concluido: !hasMore,
  };
}
