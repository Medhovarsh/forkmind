module.exports = {
  testEnvironment: 'node',
  // Only run backend tests; the dashboard has its own toolchain.
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/dashboard/'],
};
