// vitest.config.js
const { configDefaults, defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    exclude: [...configDefaults.exclude, '.superpowers/**'],
  },
});
