const http = require('http');

async function testCors() {
  const optionsGood = {
    hostname: 'localhost',
    port: 3000,
    path: '/',
    method: 'GET',
    headers: {
      'Origin': 'http://localhost:3000'
    }
  };

  const optionsBad = {
    hostname: 'localhost',
    port: 3000,
    path: '/',
    method: 'GET',
    headers: {
      'Origin': 'http://evil.com'
    }
  };

  const optionsNone = {
    hostname: 'localhost',
    port: 3000,
    path: '/',
    method: 'GET'
  };

  function makeRequest(options, expectedStatus) {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (expectedStatus && res.statusCode !== expectedStatus) {
            reject(new Error(`Expected status ${expectedStatus} but got ${res.statusCode}. Origin: ${options.headers ? options.headers.Origin : 'None'}`));
          } else {
             console.log(`Success: Origin ${options.headers ? options.headers.Origin : 'None'} got status ${res.statusCode}`);
             resolve();
          }
        });
      });

      req.on('error', (e) => {
        reject(e);
      });

      req.end();
    });
  }

  try {
    // 1. Valid origin should succeed (redirects to /login, so status 302)
    await makeRequest(optionsGood, 302);
    console.log('Passed test: Valid origin');

    // 2. No origin should succeed
    await makeRequest(optionsNone, 302);
    console.log('Passed test: No origin');

    // 3. Invalid origin should fail (Express will catch the error thrown by CORS middleware and return 500)
    await makeRequest(optionsBad, 500);
    console.log('Passed test: Invalid origin');

    console.log('All CORS tests passed!');
    process.exit(0);

  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

testCors();
