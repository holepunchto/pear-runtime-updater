module.exports = {
  packagerConfig: process.env.MAC_CODESIGN_IDENTITY
    ? {
        osxSign: {
          identity: process.env.MAC_CODESIGN_IDENTITY
        },
        osxNotarize: {
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_PASSWORD,
          teamId: process.env.TEAM_ID
        }
      }
    : {},

  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {}
    },
    {
      name: '@forkprince/electron-forge-maker-appimage',
      platforms: ['linux']
    },
    {
      name: '@electron-forge/maker-msix',
      platforms: ['win32'],
      config: {
        manifestVariables: { publisher: 'Holepunch' }
      }
    }
  ],

  plugins: []
}
