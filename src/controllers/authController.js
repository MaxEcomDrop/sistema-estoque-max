const blingService = require('../services/blingService');
const authService = require('../services/authService');

exports.getAuthUrl = (req, res) => {
  const authUrl = blingService.getAuthorizationUrl();
  res.json({ authUrl });
};

exports.handleCallback = async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Código de autorização não fornecido' });
    }

    const tokenData = await blingService.exchangeCodeForToken(code);

    const blingUserId = 'bling_user'; // Em produção, você extrai do token JWT do Bling
    const userId = await authService.saveOrUpdateUser(blingUserId, tokenData);
    const jwtToken = authService.generateJWT(userId);

    res.cookie('auth_token', jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
    });

    res.redirect('/dashboard');
  } catch (error) {
    console.error('Erro no callback de autenticação:', error);
    res.status(500).json({ error: 'Erro ao autenticar com Bling' });
  }
};

exports.logout = (req, res) => {
  res.clearCookie('auth_token');
  res.json({ message: 'Desconectado com sucesso' });
};

exports.getCurrentUser = (req, res) => {
  res.json({ userId: req.user.userId });
};
