const authService = require('./src/services/authService');

try {
  process.env.JWT_SECRET = 'short';
  authService.generateJWT(1);
  console.log('FAIL: Should have thrown error for short secret');
} catch (e) {
  console.log('PASS: Threw error for short secret:', e.message);
}

try {
  process.env.JWT_SECRET = 'a'.repeat(32);
  const token = authService.generateJWT(1);
  console.log('PASS: Generated token for valid secret');
  const decoded = authService.verifyJWT(token);
  console.log('PASS: Decoded token:', decoded);
} catch (e) {
  console.log('FAIL: Should not have thrown error for valid secret:', e.message);
}
