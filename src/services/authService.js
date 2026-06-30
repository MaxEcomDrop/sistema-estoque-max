const jwt = require('jsonwebtoken');
const db = require('../../config/database');
const blingService = require('./blingService');

exports.saveOrUpdateUser = (blingUserId, tokenData) => {
  return new Promise((resolve, reject) => {
    const expiresAt = Math.floor(Date.now() / 1000) + tokenData.expires_in;

    db.get('SELECT id FROM users WHERE bling_user_id = ?', [blingUserId], (err, user) => {
      if (err) return reject(err);

      if (user) {
        db.run(
          `UPDATE users SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE bling_user_id = ?`,
          [tokenData.access_token, tokenData.refresh_token, expiresAt, blingUserId],
          function (err) {
            if (err) return reject(err);
            resolve(user.id);
          }
        );
      } else {
        db.run(
          `INSERT INTO users (bling_user_id, access_token, refresh_token, expires_at)
           VALUES (?, ?, ?, ?)`,
          [blingUserId, tokenData.access_token, tokenData.refresh_token, expiresAt],
          function (err) {
            if (err) return reject(err);
            resolve(this.lastID);
          }
        );
      }
    });
  });
};

exports.getUserByBlingId = (blingUserId) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE bling_user_id = ?', [blingUserId], (err, user) => {
      if (err) return reject(err);
      resolve(user);
    });
  });
};

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET environment variable must be at least 32 characters long for security reasons.');
  }
  return secret;
};

exports.generateJWT = (userId) => {
  return jwt.sign({ userId }, getJwtSecret(), { expiresIn: '7d' });
};

exports.verifyJWT = (token) => {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (error) {
    return null;
  }
};

exports.isTokenExpired = (user) => {
  return user.expires_at < Math.floor(Date.now() / 1000);
};

exports.refreshUserToken = async (user) => {
  try {
    if (!user.refresh_token) {
      throw new Error('Sem refresh token');
    }

    const tokenData = await blingService.refreshAccessToken(user.refresh_token);
    await exports.saveOrUpdateUser(user.bling_user_id, tokenData);
    return tokenData.access_token;
  } catch (error) {
    console.error('Erro ao renovar token do usuário:', error);
    throw error;
  }
};
