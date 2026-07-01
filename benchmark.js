const fetchPedidosSequential = async (maxPg) => {
  let all = [];
  for (let pg = 1; pg <= maxPg; pg++) {
    const items = await mockApiCall(pg);
    all = all.concat(items);
    if (items.length < 100) break;
  }
  return all;
};

const fetchPedidosOptimized = async (maxPg) => {
  if (maxPg < 1) return [];

  let all = [];
  const firstPage = await mockApiCall(1);
  all = all.concat(firstPage);

  if (firstPage.length === 100 && maxPg > 1) {
    const promises = [];
    for (let pg = 2; pg <= maxPg; pg++) {
      promises.push(mockApiCall(pg));
    }
    const results = await Promise.all(promises);
    for (const items of results) {
      all = all.concat(items);
      if (items.length < 100) break;
    }
  }

  return all;
};

const mockApiCall = async (pg) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (pg === 1) resolve(new Array(100).fill(1));
      else if (pg === 2) resolve(new Array(100).fill(1));
      else resolve(new Array(50).fill(1));
    }, 100);
  });
};

async function run() {
  console.time('Sequential');
  await fetchPedidosSequential(3);
  console.timeEnd('Sequential');

  console.time('Optimized');
  await fetchPedidosOptimized(3);
  console.timeEnd('Optimized');
}

run();
