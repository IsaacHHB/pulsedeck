// Personal Mac build. Developer ID signing and notarization are configured in CI.
const config = require('./package.json').build;
module.exports = { ...config, mac: {
    ...config.mac,
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    identity: '-', notarize: false,
    entitlements: 'build/entitlements.mac-local.plist',
    entitlementsInherit: 'build/entitlements.mac-local.plist'
} };
