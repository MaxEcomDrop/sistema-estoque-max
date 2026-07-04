import axios, { AxiosError, AxiosInstance } from 'axios';
import { HTTP_TIMEOUT_MS, RETRY_BASE_DELAY_MS, RETRY_MAX_ATTEMPTS } from '../constants';
import { logger } from './logger';

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetriable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const ax = err as AxiosError;
  if (ax.response) return RETRIABLE_STATUS.has(ax.response.status);
  // Sem resposta = falha de rede/timeout/abort — vale tentar de novo.
  return true;
}

/**
 * Executa fn com retry + backoff exponencial com jitter.
 * Cada tentativa recebe um AbortSignal com timeout próprio.
 */
export async function withRetry<T>(
  moduleName: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      return await fn(controller.signal);
    } catch (err) {
      lastErr = err;
      if (attempt === RETRY_MAX_ATTEMPTS || !isRetriable(err)) break;
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 200;
      logger.warn(moduleName, `tentativa ${attempt} falhou; retry em ${Math.round(delay)}ms`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Cliente HTTP com timeout padrão (o AbortSignal por tentativa vem do withRetry). */
export function createHttpClient(): AxiosInstance {
  return axios.create({ timeout: HTTP_TIMEOUT_MS });
}
