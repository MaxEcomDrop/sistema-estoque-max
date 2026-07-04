import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { getEnv } from './env';
import { ConfigError } from '../utils/errors';

let db: Firestore | null = null;

/** Firestore singleton; suporta banco nomeado via FIRESTORE_DB_ID. */
export function getDb(): Firestore {
  if (db) return db;
  const env = getEnv();
  try {
    const app =
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId: env.serviceAccount.project_id,
          clientEmail: env.serviceAccount.client_email,
          privateKey: env.serviceAccount.private_key,
        }),
      });
    db =
      env.FIRESTORE_DB_ID && env.FIRESTORE_DB_ID !== '(default)'
        ? getFirestore(app, env.FIRESTORE_DB_ID)
        : getFirestore(app);
    return db;
  } catch (e) {
    // Causa mais comum: private_key colado sem as quebras de linha reais
    // (\n literais preservados errado ao salvar a env var na Vercel).
    const msg = e instanceof Error ? e.message : 'erro desconhecido';
    throw new ConfigError(`Falha ao inicializar o Firebase Admin (credencial inválida): ${msg}`);
  }
}
