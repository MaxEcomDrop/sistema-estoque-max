const authService = require('../services/authService');

exports.authMiddleware = (req, res, next) => {
  const token = req.cookies?.auth_token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const decoded = authService.verifyJWT(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  req.user = decoded;
  next();
};

exports.optionalAuthMiddleware = (req, res, next) => {
  const token = req.cookies?.auth_token || req.headers.authorization?.split(' ')[1];

  if (token) {
    const decoded = authService.verifyJWT(token);
    if (decoded) {
      req.user = decoded;
    }
  }

  next();
};
