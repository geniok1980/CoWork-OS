#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const DEFAULT_PORT = 5173;
const MAX_PORT_SCAN_ATTEMPTS = 25;
const REACT_READY_TIMEOUT_MS = 30_000;

function parsePort(value, fallback = DEFAULT_PORT) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort) {
  for (let offset = 0; offset < MAX_PORT_SCAN_ATTEMPTS; offset += 1) {
    const candidate = startPort + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to find an available dev server port starting at ${startPort} after ${MAX_PORT_SCAN_ATTEMPTS} attempts.`,
  );
}

function pipePrefixedOutput(child, label) {
  const write = (stream, chunk) => {
    const lines = chunk.toString("utf8").split(/\r?\n/);
    const trailingEmpty = lines.at(-1) === "";
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line && i === lines.length - 1 && trailingEmpty) continue;
      stream.write(`[${label}] ${line}\n`);
    }
  };

  child.stdout?.on("data", (chunk) => write(process.stdout, chunk));
  child.stderr?.on("data", (chunk) => write(process.stderr, chunk));
}

async function waitForPort(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (value) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (open) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for dev server on port ${port}.`);
}

const requestedPort = parsePort(process.env.COWORK_DEV_SERVER_PORT);
const selectedPort = await findAvailablePort(requestedPort);
const devServerUrl = `http://127.0.0.1:${selectedPort}`;
const childEnv = {
  ...process.env,
  COWORK_DEV_SERVER_PORT: String(selectedPort),
  COWORK_DEV_SERVER_URL: devServerUrl,
};
delete childEnv.ELECTRON_RUN_AS_NODE;

if (selectedPort !== requestedPort) {
  process.stdout.write(
    `[dev-start] Port ${requestedPort} is busy; using ${selectedPort} instead.\n`,
  );
}

const react = spawn(
  npmCommand,
  ["run", "dev:react", "--", "--host", "127.0.0.1", "--port", String(selectedPort), "--strictPort"],
  {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["inherit", "pipe", "pipe"],
  },
);
pipePrefixedOutput(react, "react");

let electron = null;
let shuttingDown = false;
let resolvedExit = false;

function terminateChild(child, signal = "SIGTERM") {
  if (!child || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    // Ignore termination races.
  }
}

function shutdown(exitCode = 0) {
  if (resolvedExit) return;
  resolvedExit = true;
  shuttingDown = true;
  terminateChild(electron);
  terminateChild(react);
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

react.once("error", (error) => {
  process.stderr.write(`[react] Failed to start: ${error.message}\n`);
  shutdown(1);
});

react.once("exit", (code) => {
  if (shuttingDown) return;
  if (code !== 0) {
    process.stderr.write(`[dev-start] React dev server exited with code ${code ?? 1}.\n`);
    shutdown(code ?? 1);
    return;
  }
  process.stdout.write("[dev-start] React dev server exited cleanly.\n");
  shutdown(0);
});

try {
  await waitForPort(selectedPort, REACT_READY_TIMEOUT_MS);
} catch (error) {
  process.stderr.write(`[dev-start] ${error instanceof Error ? error.message : String(error)}\n`);
  shutdown(1);
}

electron = spawn(npmCommand, ["run", "dev:electron"], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: ["inherit", "pipe", "pipe"],
});
pipePrefixedOutput(electron, "electron");

electron.once("error", (error) => {
  process.stderr.write(`[electron] Failed to start: ${error.message}\n`);
  shutdown(1);
});

electron.once("exit", (code) => {
  if (shuttingDown) return;
  process.stdout.write(`[dev-start] Electron exited with code ${code ?? 0}.\n`);
  shutdown(code ?? 0);
});
