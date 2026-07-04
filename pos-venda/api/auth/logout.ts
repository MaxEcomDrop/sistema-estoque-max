import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as cookie from 'cookie';
import { getEnv } from '../../src/config/env';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const env = getEnv();
  const isProd = env.NODE_ENV === 'production';

  res.setHeader(
    'Set-Cookie',
    cookie.serialize('auth_token', '', {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'strict' : 'lax',
      expires: new Date(0), // Expira imediatamente
      path: '/',
    }),
  );

  res.status(200).json({ success: true, message: 'Logged out successfully' });
}
