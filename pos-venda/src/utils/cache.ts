/**
 * Deduplicação em memória por execução/instância: chamadas simultâneas
 * para o mesmo CPF compartilham UMA promessa em vez de disparar consultas
 * paralelas ao Bling. O Map vive no escopo do módulo — sobrevive entre
 * invocações "quentes" da mesma instância serverless e morre com ela.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
