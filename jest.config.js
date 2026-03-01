module.exports = {
    testEnvironment: "node",
    testRegex: "(/__tests__/.*|(\\.|/)(test|spec))\\.(ts|js)?$",
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


    testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.js$']
}