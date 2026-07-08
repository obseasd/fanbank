/// Vercel serverless entry point. Wraps the Express app defined in
/// src/server.js so it runs as a single serverless function that catches
/// every route (see vercel.json). Cold start reboots the WDK wallet
/// lazily on the first request, cached for subsequent ones within the
/// same warm instance.

import { app } from '../src/server.js'

export default app
