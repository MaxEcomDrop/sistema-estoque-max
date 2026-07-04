import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SESSION_COOKIE } from '../../src/utils/auth';

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.status(200).json({ success: true });
}
