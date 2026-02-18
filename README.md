# pear-runtime-updater

> Listens for OTA app updates

```sh
npm install pear-runtime-updater
```

Listens for P2P over-the-air (OTA) updates for [Pear](https://docs.pears.com) apps. Replicates from a pear link and emits when a new version is available.

## Features

- Peer-to-peer over-the-air (P2P OTA) update listening
- Stores updatet app content
- Emits when an update is in progress and when it’s ready

## API

#### `const runtime = new PearRuntime(config)`

- `config.dir` – (required) Directory to store data (e.g. app data dir).
- `config.link` – (required) Pear upgrade link (e.g. from `package.json` `upgrade` field).
- `config.version` – (optional) Current app version; used to decide if an update should be stored.

#### `runtime.on('updating')`

Emitted when an update is in progress (download started).

#### `runtime.on('updating-delta', data)`

Emitted with progress data while mirroring the update.

#### `runtime.on('updated')`

Emitted when the update is fully downloaded and ready.

#### `runtime.next`

After `updated`, the path to the received update (e.g. `.../pear-runtime/next/<length>.<fork>`).

#### `await runtime.close()`

Closes the runtime. Call when shutting down the app.

## Making updates

Experimental; details may change.

1. Allocate a pear link with [pear](https://github.com/holepunchto/pear):

   ```sh
   pear touch
   ```

2. Put this link in your app’s `package.json` under an `upgrade` (or equivalent) field.

3. Build the app and create a deployment folder:

   ```
   /package.json
   /by-arch
     /app
       /[...platform-arch]
   ```

4. From that folder, stage and seed the link:

   ```sh
   pear stage <link-from-touch>
   ```

   Any running app with a lower version that uses this module will then see the update and emit `updated`.

## License

Apache-2.0
