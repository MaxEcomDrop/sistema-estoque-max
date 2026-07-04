import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as cookie from 'cookie';
import * as jwt from 'jsonwebtoken';
import { getEnv } from '../src/config/env';
import { CUSTOMERS_COLLECTION } from '../src/constants';
import { getDb } from '../src/config/firebase';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies.auth_token;

  if (!token) {
    res.status(401).json({ success: false, error: 'Não autorizado' });
    return;
  }

  try {
    const env = getEnv();
    jwt.verify(token, env.JWT_SECRET);
  } catch {
    res.status(401).json({ success: false, error: 'Token inválido ou expirado' });
    return;
  }

  try {
    const db = getDb();
    const snapshot = await db.collection(CUSTOMERS_COLLECTION).orderBy('updatedAt', 'desc').get();

    const customers = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        cpf: data.cpf,
        telefone: data.telefone,
        celular: data.celular,
        email: data.email,
        source: data.source,
        updatedAt: data.updatedAt
      };
    });

    res.status(200).json({ success: true, customers });
  } catch (error) {
    console.error('Erro ao buscar clientes:', error);
    res.status(500).json({ success: false, error: 'Erro interno ao buscar clientes' });
  }
}
