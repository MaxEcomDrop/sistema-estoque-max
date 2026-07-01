const { performance } = require('perf_hooks');

const mockDocs = Array.from({ length: 50 }).map((_, i) => ({
  data: () => ({ title: `Title ${i}`, body: `Body ${i}`, url: '/test' }),
  ref: `ref_${i}`
}));

const mockTokens = ['token1', 'token2'];

const mockAdmin = {
  messaging: () => ({
    sendEachForMulticast: async (msg) => {
      await new Promise(r => setTimeout(r, 10)); // 10ms network delay simulation
      return { successCount: mockTokens.length };
    }
  }),
  firestore: {
    FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' }
  }
};

const mockBatch = {
  update: () => {}
};

async function runSequential() {
  const start = performance.now();
  let sent = 0;
  for (const doc of mockDocs) {
    const { title, body, url = '/dashboard.html', action } = doc.data();
    try {
      let successCount = 0;
      if (mockTokens.length) {
        const msg = { tokens: mockTokens, notification: { title, body }, webpush: { fcmOptions: { link: url } } };
        if (action) msg.webpush.notification = { actions: [{ action: 'open', title: action }] };
        const result = await mockAdmin.messaging().sendEachForMulticast(msg);
        successCount = result.successCount;
      }
      mockBatch.update(doc.ref, { status: 'sent', sent: successCount, sentAt: mockAdmin.firestore.FieldValue.serverTimestamp() });
      sent++;
    } catch (e) {
      mockBatch.update(doc.ref, { status: 'error', error: e.message });
    }
  }
  return performance.now() - start;
}

async function runParallel() {
  const start = performance.now();
  const results = await Promise.all(mockDocs.map(async (doc) => {
    const { title, body, url = '/dashboard.html', action } = doc.data();
    try {
      let successCount = 0;
      if (mockTokens.length) {
        const msg = { tokens: mockTokens, notification: { title, body }, webpush: { fcmOptions: { link: url } } };
        if (action) msg.webpush.notification = { actions: [{ action: 'open', title: action }] };
        const result = await mockAdmin.messaging().sendEachForMulticast(msg);
        successCount = result.successCount;
      }
      mockBatch.update(doc.ref, { status: 'sent', sent: successCount, sentAt: mockAdmin.firestore.FieldValue.serverTimestamp() });
      return true;
    } catch (e) {
      mockBatch.update(doc.ref, { status: 'error', error: e.message });
      return false;
    }
  }));
  const sent = results.filter(Boolean).length;
  return performance.now() - start;
}

async function run() {
  console.log("Sequential: " + (await runSequential()).toFixed(2) + " ms");
  console.log("Parallel: " + (await runParallel()).toFixed(2) + " ms");
}
run();
