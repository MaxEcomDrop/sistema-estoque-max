import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { getEnv } from '../config/env';
import { logger } from '../utils/logger';

const MODULE = 'validate';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const payloadSchema = z.record(z.string(), z.unknown());

export interface ValidatedRequest {
  readonly payload: Record<string, unknown>;
}

interface RawRequestLike {
  readonly method?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function headerValue(req: RawRequestLike, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Compara assinaturas em tempo constante aceitando hex e base64. */
function signatureMatches(rawBody: Buffer, received: string, secret: string): boolean {
  const clean = received.replace(/^sha256=/i, '').trim();
  const hmac = createHmac('sha256', secret).update(rawBody);
  const digest = hmac.digest();
  for (const candidate of [digest.toString('hex'), digest.toString('base64')]) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(clean);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * Valida método, Content-Type, JSON e autenticidade.
 * - Bling: HMAC-SHA256 do corpo cru contra BLING_WEBHOOK_SECRET (quando configurado).
 * - Mercado Livre: confere application_id contra ML_APP_ID (quando configurado);
 *   a autenticidade final vem de re-buscar o recurso na API com o nosso token.
 */
export function validateRequest(req: RawRequestLike, rawBody: Buffer): ValidatedRequest {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');

  const contentType = headerValue(req, 'content-type') ?? '';
  if (!contentType.includes('application/json')) throw new HttpError(400, 'invalid_content_type');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  const result = payloadSchema.safeParse(parsed);
  if (!result.success || Object.keys(result.data).length === 0) {
    throw new HttpError(400, 'invalid_payload');
  }
  const payload = result.data;

  const env = getEnv();
  const signature =
    headerValue(req, 'x-bling-signature-256') ?? headerValue(req, 'x-bling-signature');

  if (signature) {
    if (!env.BLING_WEBHOOK_SECRET) {
      logger.warn(MODULE, 'webhook assinado recebido, mas BLING_WEBHOOK_SECRET não configurado');
    } else if (!signatureMatches(rawBody, signature, env.BLING_WEBHOOK_SECRET)) {
      throw new HttpError(400, 'invalid_signature');
    }
  }

  const applicationId = payload['application_id'];
  if (applicationId !== undefined && env.ML_APP_ID) {
    if (String(applicationId) !== env.ML_APP_ID) throw new HttpError(400, 'invalid_application');
  }

  return { payload };
}
