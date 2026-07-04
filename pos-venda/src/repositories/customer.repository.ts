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
