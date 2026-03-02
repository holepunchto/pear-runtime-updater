runTests()

async function runTests() {
  const test = (await import('brittle')).default

  test.pause()

  // await import('./updates.test.js')
  await import('./updates-cli.test.js')

  test.resume()
}
