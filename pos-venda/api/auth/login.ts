import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as cookie from 'cookie';
import * as jwt from 'jsonwebtoken';
import { getEnv } from '../../src/config/env';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const env = getEnv();
    const { email, password } = req.body;

    if (email === env.ADMIN_EMAIL && password === env.ADMIN_PASSWORD) {
      const token = jwt.sign({ user: 'admin', role: 'admin' }, env.JWT_SECRET, {
        expiresIn: '24h',
      });

      const isProd = env.NODE_ENV === 'production';
      res.setHeader(
        'Set-Cookie',
        cookie.serialize('auth_token', token, {
          httpOnly: true,
          secure: isProd,
          sameSite: isProd ? 'strict' : 'lax',
          maxAge: 60 * 60 * 24, // 24 hours
          path: '/',
        }),
      );

      res.status(200).json({ success: true, message: 'Logged in successfully' });
    } else {
      res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }
  } catch {
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
}
