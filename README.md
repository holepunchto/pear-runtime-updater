# pear-runtime-updater

> Listens for OTA Pear App updates

```sh
npm install pear-runtime-updater
```

Listens for P2P over-the-air (OTA) updates for [Pear](https://docs.pears.com) apps. Replicates from a pear upgrade link and emits when a new version is available.

## MVP - EXPERIMENTAL

This boilerplate is MVP and Experimental.

## Usage

```js
const PearRuntimeUpdater = require('pear-runtime-updater')
const path = require('path')
const { version, upgrade } = require('./package.json')

function getApp() {
  return path.join(process.resourcesPath, '../..')
}

const updater = new PearRuntimeUpdater({
  dir: path.join(app.getPath('userData')),
  upgrade,
  version,
  app: getApp() // path to .app / .AppImage
  name: 'name.ext' // <name>.app, <name>.AppImage, <name>.msix
})

await updater.ready()

updater.on('updating', () => console.log('Update downloading…'))
updater.on('updated', async () => {
  console.log('Update ready')
  await updater.applyUpdate()
  app.relaunch()
  app.exit(0)
})

process.on('beforeExit', () => updater.close())
```

## Features

- Peer-to-peer over-the-air (P2P OTA) update listening
- Replicates update content via [Hyperdrive](https://github.com/holepunchto/hyperdrive) / [Hyperswarm](https://github.com/holepunchto/hyperswarm)
- Emits when an update is in progress, update diffs and when it’s ready
- `applyUpdate()` to atomic swap the new build (bundled apps; macOS/Linux)

## API

#### `const updater = new PearRuntimeUpdater(opts)`

- `opts.dir` – (required) Directory to store data (e.g. app data dir).
- `opts.upgrade` – (required) Pear upgrade link (e.g. from `package.json` `upgrade` field).
- `opts.name` – (required) Application name with extension.
- `opts.version` – (optional) Current app version; used to decide if an update should be stored.
- `opts.app` – (optional) Path to the app bundle (for bundled apps; used with `applyUpdate()`).
- `opts.bundled` – (optional) Whether the app is bundled. Defaults to `!!opts.app`.
- `opts.updates` – (optional) Set to false to opt out of updates.

#### `updater.on('updating')`

Emitted when an update is in progress.

#### `updater.on('updating-delta', data)`

Emitted with progress data while mirroring the update.

#### `updater.on('updated')`

Emitted when the update is fully downloaded and ready. After this, `updater.next` is the path to the staged update.

#### `updater.next`

After `updated`, the path to the staged update (e.g. for use with `applyUpdate()` or custom install logic).

#### `await updater.applyUpdate()`

Apply the update by swapping the current app with the received build through atomic swap. Only valid after `updated`, when `opts.bundled` is true.

#### `await updater.close()`

Shut it down. You should do this when closing your app for best performance.

## License

Apache-2.0
