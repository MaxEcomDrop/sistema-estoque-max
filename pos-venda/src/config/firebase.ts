import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { getEnv } from './env';

let db: Firestore | null = null;

/** Firestore singleton; suporta banco nomeado via FIRESTORE_DB_ID. */
export function getDb(): Firestore {
  if (db) return db;
  const env = getEnv();
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
}
