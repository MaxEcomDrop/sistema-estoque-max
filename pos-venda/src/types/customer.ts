export type WebhookSource = 'bling' | 'mercado_livre';

export interface EnderecoInfo {
  readonly logradouro: string | null;
  readonly numero: string | null;
  readonly bairro: string | null;
  readonly municipio: string | null;
  readonly uf: string | null;
  readonly cep: string | null;
}

export type TipoPessoa = 'PF' | 'PJ' | null;

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
  /** Anotação livre e etiquetas — só existem aqui, o Bling/ML não fornecem isso. */
  readonly notas?: string | null;
  readonly tags?: ReadonlyArray<string> | null;
  /** PF ou PJ (campo `tipo` do Bling: 'F'/'J') — null quando a fonte não informa (ex.: ML). */
  readonly tipoPessoa?: TipoPessoa;
}

export interface BlingContact {
  readonly nome: string | null;
  readonly telefone: string | null;
  readonly celular: string | null;
  readonly email: string | null;
  readonly endereco: EnderecoInfo | null;
  readonly tipoPessoa: TipoPessoa;
}

export interface CaptureResult {
  readonly success: true;
  readonly action: 'cache_hit' | 'refreshed' | 'skipped';
  readonly cpf?: string;
  readonly reason?: string;
}
