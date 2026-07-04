/**
 * Logger fino sobre console.* — único ponto de saída de logs do serviço.
 * Nunca receba tokens, headers Authorization ou credenciais como argumento.
 */
const ts = (): string => new Date().toISOString();

export const logger = {
  info(module: string, message: string, extra?: Record<string, unknown>): void {
    console.info(`[${ts()}] [${module}] ${message}`, extra ?? '');
  },
  warn(module: string, message: string, extra?: Record<string, unknown>): void {
    console.warn(`[${ts()}] [${module}] ${message}`, extra ?? '');
  },
  error(module: string, message: string, extra?: Record<string, unknown>): void {
    console.error(`[${ts()}] [${module}] ${message}`, extra ?? '');
  },
};
