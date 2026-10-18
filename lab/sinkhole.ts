// A tiny DNS server that behaves like a censoring ISP resolver: listed domains resolve to
// 0.0.0.0, everything else is forwarded to 1.1.1.1. Used by lab probes via --resolver.
//
//   node lab/sinkhole.ts --port 5533 --block torproject.org,wikipedia.org

import dgram from "node:dgram"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: { port: { type: "string", default: "5533" }, block: { type: "string", default: "torproject.org" } },
})
const blocked = values.block!.split(",").map((d) => d.trim().toLowerCase())
const server = dgram.createSocket("udp4")

function questionName(msg: Buffer): { name: string; end: number } {
  const labels: string[] = []
  let i = 12
  while (msg[i] !== 0) {
    labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString())
    i += msg[i] + 1
  }
  return { name: labels.join(".").toLowerCase(), end: i + 5 } // null byte + QTYPE + QCLASS
}

function sinkholeAnswer(query: Buffer, end: number): Buffer {
  const header = Buffer.from(query.subarray(0, 12))
  header.writeUInt16BE(0x8180, 2) // response, recursion available, no error
  header.writeUInt16BE(1, 4) // QDCOUNT
  header.writeUInt16BE(query.readUInt16BE(end - 4) === 1 ? 1 : 0, 6) // answer only A queries
  header.writeUInt32BE(0, 8) // NSCOUNT, ARCOUNT
  const question = query.subarray(12, end)
  if (header.readUInt16BE(6) === 0) return Buffer.concat([header, question])
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 0, 0, 0, 0])
  return Buffer.concat([header, question, answer])
}

server.on("message", (msg, rinfo) => {
  const { name, end } = questionName(msg)
  if (blocked.some((d) => name === d || name.endsWith(`.${d}`))) {
    console.log(`sinkhole  ${name} -> 0.0.0.0`)
    server.send(sinkholeAnswer(msg, end), rinfo.port, rinfo.address)
    return
  }
  const upstream = dgram.createSocket("udp4")
  upstream.once("message", (reply) => {
    server.send(reply, rinfo.port, rinfo.address)
    upstream.close()
  })
  upstream.send(msg, 53, "1.1.1.1")
  setTimeout(() => upstream.close(), 5000).unref()
})

server.bind(Number(values.port), "127.0.0.1", () =>
  console.log(`sinkhole DNS on 127.0.0.1:${values.port}, blocking ${blocked.join(", ")}`),
)
