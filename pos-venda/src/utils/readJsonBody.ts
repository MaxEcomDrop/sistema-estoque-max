import type { VercelRequest } from '@vercel/node';

/** Lê o corpo cru da requisição e faz parse como JSON — usado nos poucos
 *  handlers que precisam ler o body manualmente (Vercel não faz isso por padrão
 *  fora do runtime Node com bodyParser habilitado). */
export async function readJsonBody(req: VercelRequest): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}
