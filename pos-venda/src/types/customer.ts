export type WebhookSource = 'bling' | 'mercado_livre';

export interface CustomerRecord {
  readonly cpf: string;
  readonly telefone: string | null;
  readonly celular: string | null;
  readonly email: string | null;
  readonly source: WebhookSource;
  /** Epoch ms da última atualização (usado no cálculo do TTL). */
  readonly updatedAt: number;
}

export interface BlingContact {
  readonly telefone: string | null;
  readonly celular: string | null;
  readonly email: string | null;
}

export interface CaptureResult {
  readonly success: true;
  readonly action: 'cache_hit' | 'refreshed' | 'skipped';
  readonly cpf?: string;
  readonly reason?: string;
}
