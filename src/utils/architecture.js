const os = require('node:os')
const process = require('node:process')

const getRealCPUArchitecture = () => {
  const cpuInfo = os.cpus()?.[0];
  const model = cpuInfo?.model || '';
  const processArch = process.arch; // architecture Electron was built for

  // Detect Apple Silicon (even under Rosetta)
  if (/Apple\s*M\d/i.test(model)) {
    return 'arm64';
  }

  // Generic ARM hardware (e.g. Raspberry Pi)
  if (/arm/i.test(model) || processArch.startsWith('arm')) {
    return 'arm64';
  }

  // Intel / AMD systems
  if (/intel|amd/i.test(model)) {
    return 'x64';
  }

  return processArch;
}

module.exports = {
    getRealCPUArchitecture
}