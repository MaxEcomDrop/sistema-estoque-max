/**
 * Normaliza CPF/CNPJ: remove pontos, traços, barras e espaços.
 * Retorna null quando o resultado não tem o comprimento de CPF (11)
 * nem de CNPJ (14) — entrada inválida não vira chave de documento.
 */
export function cleanDocument(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length === 11 || digits.length === 14) return digits;
  return null;
}
