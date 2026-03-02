#!/usr/bin/env node

const path = require('path')
const fs = require('fs')

const pkg = require('./package.json')
const { version, upgrade } = pkg

const response = { version }
const line = JSON.stringify(response) + '\n'
process.stdout.write(line)

const outFile = process.env.PEAR_CLI_RESPONSE_FILE
if (outFile) {
  fs.writeFileSync(outFile, line, 'utf8')
}

;(async () => {
  if (!upgrade) return

  const PearRuntime = require('pear-runtime')
  const Corestore = require('corestore')
  const Hyperswarm = require('hyperswarm')

  const dir = process.cwd()
  const appPath = process.env.PEAR_APP_PATH ? path.join(dir, process.env.PEAR_APP_PATH) : process.execPath
  // Use a temp store at a different path only to get keypair; PearRuntime will create and own pear-runtime/corestore
  const keypairStore = new Corestore(path.join(dir, 'pear-runtime-keypair-temp/corestore'))
  const keyPair = await keypairStore.createKeyPair('pear-container')
  await keypairStore.close()
  const bootstrap = JSON.parse(process.env.PEAR_BOOTSTRAP || '[]')
  const swarm = new Hyperswarm({ keyPair, bootstrap })
  const app = new PearRuntime({ dir, version, upgrade, swarm, app: appPath, bundled: true })

  let closing = false
  const teardown = () => {
    if (closing) return
    closing = true
    app.close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err)
        process.exit(1)
      })
  }
  process.on('beforeExit', teardown)
  process.on('SIGINT', teardown)
  process.on('SIGTERM', teardown)

  app.updater.on('updating', function () {
    process.stdout.write('updating\n')
  })

  app.updater.on('updated', function () {
    process.stdout.write('updated\n')
    app.updater
      .applyUpdate()
      .then(() => app.close())
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err)
        process.exit(1)
      })
  })

  await app.ready()
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
