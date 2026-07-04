export type WebhookSource = 'bling' | 'mercado_livre';

export interface EnderecoInfo {
  readonly logradouro: string | null;
  readonly numero: string | null;
  readonly bairro: string | null;
  readonly municipio: string | null;
  readonly uf: string | null;
  readonly cep: string | null;
}

export interface CustomerRecord {
  readonly cpf: string;
  readonly nome: string | null;
  readonly telefone: string | null;
  readonly celular: string | null;
  readonly email: string | null;
  readonly endereco: EnderecoInfo | null;
  readonly source: WebhookSource;
  /** Epoch ms da última atualização (usado no cálculo do TTL). */
  readonly updatedAt: number;
}

export interface BlingContact {
  readonly nome: string | null;
  readonly telefone: string | null;
  readonly celular: string | null;
  readonly email: string | null;
  readonly endereco: EnderecoInfo | null;
}

export interface CaptureResult {
  readonly success: true;
  readonly action: 'cache_hit' | 'refreshed' | 'skipped';
  readonly cpf?: string;
  readonly reason?: string;
}
