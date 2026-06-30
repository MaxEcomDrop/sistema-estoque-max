const authService = require('./src/services/authService');
const assert = require('assert');

let passed = true;

// Test short secret
try {
  process.env.JWT_SECRET = 'short';
  authService.generateJWT(1);
  console.log('❌ FAIL: generateJWT should have thrown error for short secret');
  passed = false;
} catch (e) {
  if (e.message.includes('at least 32 characters long')) {
    console.log('✅ PASS: generateJWT threw correct error for short secret');
  } else {
    console.log('❌ FAIL: generateJWT threw unexpected error for short secret:', e.message);
    passed = false;
  }
}

try {
  process.env.JWT_SECRET = 'short';
  // Note: verifyJWT returns null instead of throwing error now due to catch block
  const decoded = authService.verifyJWT('sometoken');
  if (decoded === null) {
      console.log('✅ PASS: verifyJWT returned null for short secret');
  } else {
      console.log('❌ FAIL: verifyJWT should have returned null for short secret');
      passed = false;
  }
} catch(e) {
  console.log('❌ FAIL: verifyJWT should not throw error but return null:', e.message);
  passed = false;
}

// Test undefined secret
try {
  delete process.env.JWT_SECRET;
  authService.generateJWT(1);
  console.log('❌ FAIL: generateJWT should have thrown error for undefined secret');
  passed = false;
} catch (e) {
  if (e.message.includes('at least 32 characters long')) {
    console.log('✅ PASS: generateJWT threw correct error for undefined secret');
  } else {
    console.log('❌ FAIL: generateJWT threw unexpected error for undefined secret:', e.message);
    passed = false;
  }
}

// Test valid secret
try {
  process.env.JWT_SECRET = 'a'.repeat(32);
  const token = authService.generateJWT(1);
  console.log('✅ PASS: Generated token for valid secret');

  const decoded = authService.verifyJWT(token);
  if (decoded && decoded.userId === 1) {
    console.log('✅ PASS: Decoded token matches expected output');
  } else {
    console.log('❌ FAIL: Decoded token does not match expected output:', decoded);
    passed = false;
  }
} catch (e) {
  console.log('❌ FAIL: Should not have thrown error for valid secret:', e.message);
  passed = false;
}

if (!passed) {
  process.exit(1);
}
