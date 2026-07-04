import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleWebhook } from '../src/controllers/webhook.controller';
import { validateRequest } from '../src/middlewares/validateRequest';
import { handleApiError } from '../src/utils/handleApiError';

// Corpo cru necessário para verificar a assinatura HMAC byte a byte.
export const config = { api: { bodyParser: false } };

const MODULE = 'handler';

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const rawBody = await readRawBody(req);
    const { payload } = validateRequest(
      { method: req.method, headers: req.headers as Record<string, string | string[] | undefined> },
      rawBody,
    );
    const result = await handleWebhook(payload);
    res.status(200).json(result);
  } catch (err) {
    handleApiError(MODULE, err, res);
  }
}
