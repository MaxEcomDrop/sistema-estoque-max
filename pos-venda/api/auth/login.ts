import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkCredentials, signSession } from '../../src/utils/auth';
import { SESSION_COOKIE } from '../../src/utils/auth';
import { handleApiError } from '../../src/utils/handleApiError';
import { readJsonBody } from '../../src/utils/readJsonBody';

const MODULE = 'auth.login';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    if (!email || !password) {
      res.status(400).json({ success: false, error: 'email_e_senha_obrigatorios' });
      return;
    }

    if (!checkCredentials(email, password)) {
      res.status(401).json({ success: false, error: 'credenciais_invalidas' });
      return;
    }

    const token = signSession(email);
    const maxAge = 7 * 24 * 3600;
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    );
    res.status(200).json({ success: true });
  } catch (err) {
    handleApiError(MODULE, err, res);
  }
}
