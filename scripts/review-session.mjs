// A stand-in for a DeepSeek Harness session, for Chrome Web Store reviewers and manual smoke tests.
//
// DeepSeek Harness needs an API key, which a reviewer does not have. This script connects to the
// local broker exactly as the real plugin does, announces one session, and lets you type actions.
// It sends the same frames the plugin sends; nothing here bypasses the broker or the extension.
//
// Usage: node scripts/review-session.mjs [--home <dir>] [--port <n>]

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lib = join(root, "companion", "lib");

const { AgentClient } = await import(join(lib, "agent-client.js"));
const { loadOrCreateCredentials } = await import(join(lib, "auth.js"));
const { credentialsPath } = await import(join(lib, "paths.js"));
const { resolveDshHome, resolveProfileIdentity } = await import(join(lib, "dsh", "profile.js"));
const { DEFAULT_BROKER_PORT } = await import(join(lib, "protocol.js"));

const argument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const home = argument("--home", resolveDshHome());
const port = Number(argument("--port", String(DEFAULT_BROKER_PORT)));
const credentials = loadOrCreateCredentials(credentialsPath(home));
const identity = resolveProfileIdentity({ configuredName: "review", environment: { ...process.env, DSH_HOME: home } });
const sessionId = "review-session";

const client = new AgentClient({
  url: `ws://127.0.0.1:${port}`,
  secret: credentials.secret,
  version: "0.1.0",
  profileId: identity.profileId,
  name: "Review stand-in",
  onStatus: (status, detail) => process.stderr.write(`[connector] ${status}: ${detail}\n`),
});
client.start();

process.stdout.write(`Waiting for the connector on 127.0.0.1:${port} (home: ${home})...\n`);
for (let attempt = 0; attempt < 100 && !client.connected; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!client.connected) {
  process.stderr.write("The connector is not reachable. Start it with: node companion/lib/broker-main.js\n");
  process.exit(1);
}
client.addSession(sessionId, "Review session");
process.stdout.write(`Announced "Review session". In the extension panel, select it and attach a tab.\n`);
process.stdout.write("Commands: snapshot | text | url | find <text> | wait | click <ref> | type <ref> <text>\n"
  + "          navigate <url> | back | forward | reload | tabs | open [url] | switch <tabRef> | close\n"
  + "          screenshot [file.jpg]   (writes the capture to a file; screenshot.jpg by default)\n"
  + "          do <action> <json>   (any of the twenty-one actions, arguments as JSON) | quit\n\n");

const prompt = createInterface({ input: process.stdin, output: process.stdout, prompt: "review> " });
prompt.prompt();
prompt.on("line", async (line) => {
  const [command, ...rest] = line.trim().split(/\s+/);
  try {
    if (command === "quit" || command === "exit") { client.dispose(); process.exit(0); }
    else if (command === "snapshot") print(await client.request(sessionId, "snapshot", {}));
    else if (command === "text") print(await client.request(sessionId, "read_text", {}));
    else if (command === "url") print(await client.request(sessionId, "current_url", {}));
    else if (command === "click" && rest[0]) print(await client.request(sessionId, "click", { ref: rest[0] }));
    else if (command === "type" && rest[0]) {
      print(await client.request(sessionId, "type", { ref: rest[0], text: rest.slice(1).join(" "), replace: true }));
    }
    else if (command === "find" && rest[0]) print(await client.request(sessionId, "find", { text: rest.join(" ") }));
    else if (command === "wait") print(await client.request(sessionId, "wait", {}));
    else if (command === "navigate" && rest[0]) print(await client.request(sessionId, "navigate", { url: rest[0] }));
    else if (command === "back" || command === "forward" || command === "reload") print(await client.request(sessionId, command, {}));
    else if (command === "tabs") print(await client.request(sessionId, "list_tabs", {}));
    else if (command === "open") print(await client.request(sessionId, "open_tab", rest[0] ? { url: rest[0] } : {}));
    else if (command === "switch" && rest[0]) print(await client.request(sessionId, "switch_tab", { tabRef: rest[0] }));
    else if (command === "close") print(await client.request(sessionId, "close_tab", {}));
    else if (command === "screenshot") {
      const capture = await client.request(sessionId, "screenshot", {});
      const file = resolve(rest[0] ?? "screenshot.jpg");
      writeFileSync(file, Buffer.from(capture.dataUrl.slice(capture.dataUrl.indexOf(",") + 1), "base64"));
      print({ ...capture, dataUrl: `(${capture.dataUrl.length} characters, written to ${file})` });
    }
    else if (command === "do" && rest[0]) print(await client.request(sessionId, rest[0], rest[1] ? JSON.parse(rest.slice(1).join(" ")) : {}));
    else if (command !== "") process.stdout.write("unknown command\n");
  } catch (cause) {
    process.stdout.write(`refused: ${cause.code ?? ""} ${cause.message}\n`);
  }
  prompt.prompt();
});
prompt.on("close", () => { client.dispose(); process.exit(0); });

/**
 * @param {unknown} result A browser result.
 */
function print(result) {
  if (result && typeof result === "object" && Array.isArray(result.elements)) {
    process.stdout.write(`${result.title}\n${result.url}\n\n${result.text}\n\n`);
    for (const element of result.elements) {
      process.stdout.write(`[${element.ref}] ${element.role}: ${element.name}${element.value !== undefined ? ` = ${element.value}` : ""}\n`);
    }
    if (result.truncated) process.stdout.write("\n[truncated]\n");
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
