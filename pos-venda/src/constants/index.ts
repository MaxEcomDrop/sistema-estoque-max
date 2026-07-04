export const BLING_API_BASE = 'https://www.bling.com.br/Api/v3';
export const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
export const ML_API_BASE = 'https://api.mercadolibre.com';

export const CUSTOMERS_COLLECTION = 'customers';
export const BLING_AUTH_DOC = { collection: 'bling_auth', doc: 'tokens' } as const;
export const BLING_LEASE_DOC = { collection: 'bling_auth', doc: 'refresh_lease' } as const;
export const ML_AUTH_DOC = { collection: 'ml_auth', doc: 'tokens' } as const;

export const DEFAULT_CACHE_TTL_HOURS = 24;
export const HTTP_TIMEOUT_MS = 10_000;
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 400;
/** Janela em que uma renovação de token em andamento bloqueia outra (evita corrida com refresh_token de uso único). */
export const REFRESH_LEASE_MS = 60_000;
