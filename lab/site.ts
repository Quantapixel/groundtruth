// A local site every lab probe can reach. Stop it to show a "down everywhere" outage.
//
//   node lab/site.ts --port 8099

import http from "node:http"
import { parseArgs } from "node:util"

const { values } = parseArgs({ options: { port: { type: "string", default: "8099" } } })

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<h1>Groundtruth lab site</h1><p>If you can read this, the site is up.</p>")
  })
  .listen(Number(values.port), "127.0.0.1", () => console.log(`lab site on http://127.0.0.1:${values.port}`))
