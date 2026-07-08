/// Vercel serverless entry point. Wraps the Express app defined in
/// src/server.js so it runs as a single serverless function that catches
/// every route (see vercel.json). Cold start reboots the WDK wallet
/// lazily on the first request, cached for subsequent ones within the
/// same warm instance.
///
/// The dynamic import + try/catch is defensive: if server.js throws at
/// module load (missing dep, incompatible package, env-var parse error)
/// we surface the real reason in the response body instead of a raw
/// Vercel FUNCTION_INVOCATION_FAILED which reveals nothing to the user.

let cachedApp = null
let bootError = null

async function loadApp () {
  if (cachedApp) return cachedApp
  if (bootError) return null
  try {
    const mod = await import('../src/server.js')
    cachedApp = mod.app
    return cachedApp
  } catch (err) {
    bootError = err
    console.error('[fanbank] fatal boot error:', err)
    console.error(err?.stack)
    return null
  }
}

export default async function handler (req, res) {
  const app = await loadApp()
  if (!app) {
    res.status(500).json({
      error: 'boot_failure',
      message: bootError?.message || 'unknown error importing server.js',
      stack: bootError?.stack?.split('\n').slice(0, 8) || null,
    })
    return
  }
  return app(req, res)
}
