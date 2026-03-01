module.exports = {
    testMatch: ['**/*.integration.test.js'],

    testEnvironment: "node",
    moduleNameMapper: {
      electron: "<rootDir>/test/mock/electron.js"
    },
    roots: [
      "<rootDir>/src"
    ],
    collectCoverageFrom: [
      "src/**/*.{js,jsx,ts,tsx}",
      "!src/**/*.d.ts",
      "!src/**/*.{test,tests}.{js,jsx,ts,tsx}",
      "!src/**/*.unit.{test,tests}.{js,jsx,ts,tsx}",
      "!src/**/*.test.util.{js,jsx,ts,tsx}"
    ],


}