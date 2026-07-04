/**
 * Erro de CONFIGURAÇÃO (env var ausente/inválida, credencial malformada).
 * Diferente de um bug: é seguro mostrar a mensagem (nunca inclui segredos,
 * só nomes de variável e validações do zod) para quem administra o serviço
 * corrigir sem precisar vasculhar logs do Vercel.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
