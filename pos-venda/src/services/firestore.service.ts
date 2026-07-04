import { getDb } from '../config/firebase';

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
