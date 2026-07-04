import { CUSTOMERS_COLLECTION } from '../constants';
import { CustomerRecord } from '../types/customer';
import { readDoc, upsertDoc } from '../services/firestore.service';

export async function getCustomer(cpf: string): Promise<CustomerRecord | null> {
  return readDoc<CustomerRecord>(CUSTOMERS_COLLECTION, cpf);
}

/** Upsert com merge — nunca apaga campos preenchidos por versões anteriores. */
export async function upsertCustomer(record: CustomerRecord): Promise<void> {
  await upsertDoc(CUSTOMERS_COLLECTION, record.cpf, { ...record });
}

/** Atualiza só notas/tags (dado que só existe aqui, nunca vem do Bling/ML). */
export async function updateCustomerNotes(
  cpf: string,
  patch: { readonly notas?: string | null; readonly tags?: ReadonlyArray<string> | null },
): Promise<void> {
  await upsertDoc(CUSTOMERS_COLLECTION, cpf, { ...patch });
}
