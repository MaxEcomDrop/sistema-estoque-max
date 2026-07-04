import { getDb } from '../config/firebase';

export interface PingResult {
  readonly ok: boolean;
  readonly error: string | null;
}

/** Escreve e lê um documento de diagnóstico — prova real de leitura+escrita. */
export async function pingFirestore(): Promise<PingResult> {
  try {
    const ref = getDb().collection('_diag').doc('ping');
    await ref.set({ at: Date.now() });
    await ref.get();
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'erro desconhecido' };
  }
}

/** Conta documentos de uma coleção via aggregation query (sem baixar tudo). */
export async function countCollection(collection: string): Promise<number> {
  const snap = await getDb().collection(collection).count().get();
  return snap.data().count;
}

/** Últimos N documentos de uma coleção, ordenados por campo desc. */
export async function listRecent<T>(
  collection: string,
  orderField: string,
  limit: number,
): Promise<ReadonlyArray<T & { readonly id: string }>> {
  const snap = await getDb().collection(collection).orderBy(orderField, 'desc').limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
}

export interface Page<T> {
  readonly items: ReadonlyArray<T & { readonly id: string }>;
  /** Valor de `orderField` do último item — passe de volta como `cursor` pra
   *  buscar a próxima página. `null` quando não há mais páginas. Cursor por
   *  campo único (sem desempate por id): com muitos documentos empatados no
   *  mesmo valor, alguns podem repetir/pular entre páginas — aceitável no
   *  volume atual (não é uma garantia forte de paginação exata). */
  readonly nextCursor: number | null;
}

/** Página de uma coleção, ordenada por campo desc, com cursor pra continuar. */
export async function listPage<T>(
  collection: string,
  orderField: string,
  limit: number,
  cursor?: number,
): Promise<Page<T>> {
  let query = getDb().collection(collection).orderBy(orderField, 'desc').limit(limit);
  if (cursor !== undefined) query = query.startAfter(cursor);
  const snap = await query.get();
  const items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
  const last = items[items.length - 1] as (T & Record<string, unknown>) | undefined;
  const nextCursor = items.length === limit && last ? (last[orderField] as number) : null;
  return { items, nextCursor };
}

export async function readDoc<T>(collection: string, doc: string): Promise<T | null> {
  const snap = await getDb().collection(collection).doc(doc).get();
  return snap.exists ? (snap.data() as T) : null;
}

export async function upsertDoc(
  collection: string,
  doc: string,
  data: Record<string, unknown>,
): Promise<void> {
  await getDb().collection(collection).doc(doc).set(data, { merge: true });
}

/**
 * Lease transacional: retorna true se ESTE processo ganhou o direito de
 * executar a operação exclusiva (ex.: renovar um refresh_token de uso
 * único) dentro da janela. Perdedores devem aguardar/usar o resultado
 * de quem ganhou.
 */
export async function acquireLease(
  collection: string,
  doc: string,
  windowMs: number,
): Promise<boolean> {
  const ref = getDb().collection(collection).doc(doc);
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const last = snap.exists ? ((snap.data() as { at?: number }).at ?? 0) : 0;
    const now = Date.now();
    if (now - last < windowMs) return false;
    tx.set(ref, { at: now });
    return true;
  });
}
