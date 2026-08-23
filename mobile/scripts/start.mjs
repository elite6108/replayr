import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import qrcode from "qrcode-terminal";

function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if ((addr.family === "IPv4" || addr.family === 4) && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
}

const host = process.env.REACT_NATIVE_PACKAGER_HOSTNAME || lanAddress();
const port = process.env.EXPO_PORT || "8081";
process.env.REACT_NATIVE_PACKAGER_HOSTNAME = host;
const url = `exp://${host}:${port}`;

console.log("");
console.log("Scan this in Expo Go. Phone and PC must be on the same Wi-Fi.");
console.log(url);
console.log("");
qrcode.generate(url, { small: true });
console.log("");

const child = spawn("npx", ["expo", "start", "--lan", "--port", port, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
