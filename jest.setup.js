jest.mock('./config/database-vercel', () => {
  return {
    init: jest.fn(),
    getDb: jest.fn().mockReturnValue({
      run: jest.fn(),
      get: jest.fn(),
      all: jest.fn(),
      serialize: jest.fn((cb) => cb()),
    }),
  };
});
