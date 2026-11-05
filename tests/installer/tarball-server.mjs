// A loopback stand-in for the project's GitHub release, for the installer suites.
//
// The extension's setup card and both installers name the companion by its release URL,
// `https://github.com/CorsenAI/deepseek-harness-connector/releases/download/v<version>/<name>.tgz`,
// which github.com answers with a redirect to its asset store; `dsh plugin add` hands the URL to
// pnpm, which follows the redirect and installs the tarball. This server plays both hops on
// 127.0.0.1 so the suites exercise that path against a real `dsh` without the network:
// `/releases/download/<tag>/<name>` answers 302 to `/objects/<name>`, which serves the file.
//
// Usage: node tarball-server.mjs <tarball> <port> <tag>
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [file, port, tag] = process.argv.slice(2);
if (!file || !port || !tag) {
  process.stderr.write("usage: node tarball-server.mjs <tarball> <port> <tag>\n");
  process.exit(2);
}
const name = basename(file);
const bytes = readFileSync(file);

const server = createServer((request, response) => {
  process.stdout.write(`${request.method} ${request.url}\n`);
  if (request.url === `/releases/download/${tag}/${name}`) {
    response.writeHead(302, { location: `/objects/${name}` });
    response.end();
    return;
  }
  if (request.url === `/objects/${name}`) {
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
    response.end(bytes);
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(Number(port), "127.0.0.1", () => {
  process.stdout.write(`listening http://127.0.0.1:${port}/releases/download/${tag}/${name}\n`);
});
