const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Some native deps ship `exports` maps that Metro's package-exports resolution
// trips over; file-based resolution works fine. (Matches the nekoni app.)
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
