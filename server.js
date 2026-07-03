const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_DIR = path.join(__dirname, "config");
const CONFIG_PATH = path.join(CONFIG_DIR, "app-config.json");

const DEFAULT_CONFIG = {
  commandRunner: {
    mode: "local",
    ssh: {
      host: "jetson-orin.local",
      user: "ubuntu",
      port: 22,
      identityFile: "~/.ssh/id_ed25519",
      workingDirectory: "",
      remoteStateDirectory: "~/.genauto-sensor-dash",
      options: [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2"
      ]
    }
  },
  launchProfiles: {
    gmsl_stack: {
      label: "GMSL Cameras + Sensor Stack",
      command: "source /opt/ros/humble/setup.bash && source ~/your_ros_ws/install/setup.bash && ros2 launch your_package gmsl_sensor_stack.launch.py"
    },
    security_stack: {
      label: "Security Cameras + Sensor Stack",
      command: "source /opt/ros/humble/setup.bash && source ~/your_ros_ws/install/setup.bash && ros2 launch your_package security_sensor_stack.launch.py"
    }
  },
  sensors: [
    {
      id: "ouster_os128",
      name: "Ouster OS-128 LiDAR",
      expectedOutputs: [
        "sensor initialized",
        "publishing point cloud",
        "/ouster/points"
      ]
    },
    {
      id: "mti_680g",
      name: "MTi-680G GPS/IMU",
      expectedOutputs: [
        "device connected",
        "filter profile",
        "/imu/data"
      ]
    },
    {
      id: "camera_stack",
      name: "Camera Stack",
      expectedOutputs: [
        "camera ready",
        "stream started",
        "/camera"
      ]
    }
  ],
  rosbag: {
    enabled: true,
    setupCommand: "source /opt/ros/humble/setup.bash && source ~/your_ros_ws/install/setup.bash",
    outputDirectory: "~/rosbags",
    outputPrefix: "sensor_stack",
    topics: [
      "/ouster/points",
      "/imu/data",
      "/camera/front/image_raw"
    ]
  }
};

function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}

function loadConfig() {
  ensureConfig();
  return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
}

function saveConfig(config) {
  ensureConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function normalizeCommandRunner(commandRunner = {}) {
  const defaultRunner = DEFAULT_CONFIG.commandRunner;
  const defaultSsh = defaultRunner.ssh;
  const ssh = commandRunner.ssh && typeof commandRunner.ssh === "object"
    ? commandRunner.ssh
    : {};

  return {
    mode: commandRunner.mode === "ssh" ? "ssh" : "local",
    ssh: {
      ...defaultSsh,
      ...ssh,
      options: Array.isArray(ssh.options) ? ssh.options : defaultSsh.options
    }
  };
}

function normalizeConfig(config = {}) {
  return {
    commandRunner: normalizeCommandRunner(config.commandRunner),
    launchProfiles: config.launchProfiles || DEFAULT_CONFIG.launchProfiles,
    sensors: Array.isArray(config.sensors) ? config.sensors : DEFAULT_CONFIG.sensors,
    rosbag: config.rosbag || DEFAULT_CONFIG.rosbag
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function sanitizeFilePath(requestPath) {
  const requestedPath = requestPath === "/" ? "index.html" : requestPath.replace(/^[/\\]+/, "");
  const normalized = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(PUBLIC_DIR, normalized);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolved;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function escapeDoubleQuotedShell(value) {
  return String(value).replace(/(["\\$`])/g, "\\$1");
}

function remotePathExpression(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "~") {
    return "$HOME";
  }
  if (trimmed.startsWith("~/")) {
    return `"$HOME/${escapeDoubleQuotedShell(trimmed.slice(2))}"`;
  }
  return shellQuote(trimmed);
}

function expandLocalPath(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function getCommandRunner() {
  return normalizeCommandRunner(appConfig.commandRunner);
}

function describeRunnerTarget(runner = getCommandRunner()) {
  if (runner.mode !== "ssh") {
    return "local shell";
  }

  const ssh = runner.ssh;
  const destination = ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host;
  return `ssh ${destination}:${ssh.port || 22}`;
}

function buildSshBaseArgs(runner = getCommandRunner()) {
  const ssh = runner.ssh;
  const host = String(ssh.host || "").trim();
  if (!host) {
    throw new Error("SSH runner requires commandRunner.ssh.host.");
  }

  const args = [];
  const port = Number(ssh.port || 22);
  if (port > 0) {
    args.push("-p", String(port));
  }

  const identityFile = expandLocalPath(ssh.identityFile);
  if (identityFile) {
    args.push("-i", identityFile);
  }

  const options = Array.isArray(ssh.options) ? ssh.options : [];
  for (const option of options) {
    const normalizedOption = String(option || "").trim();
    if (normalizedOption) {
      args.push(normalizedOption);
    }
  }

  args.push(ssh.user ? `${ssh.user}@${host}` : host);
  return args;
}

function getRemoteStateDirectory(runner = getCommandRunner()) {
  const ssh = runner.ssh;
  return String(ssh.remoteStateDirectory || "~/.genauto-sensor-dash").trim() || "~/.genauto-sensor-dash";
}

function getRemotePidFile(processName, runner = getCommandRunner()) {
  const safeName = String(processName).replace(/[^a-z0-9_-]/gi, "_");
  return `${getRemoteStateDirectory(runner).replace(/\/+$/, "")}/${safeName}.pid`;
}

function withRemoteWorkingDirectory(command, runner = getCommandRunner()) {
  const ssh = runner.ssh;
  const workingDirectory = String(ssh.workingDirectory || "").trim();
  if (!workingDirectory) {
    return command;
  }
  return `cd ${remotePathExpression(workingDirectory)} && ${command}`;
}

function buildRemoteManagedCommand(command, processName, runner = getCommandRunner()) {
  const stateDirectory = remotePathExpression(getRemoteStateDirectory(runner));
  const pidFile = remotePathExpression(getRemotePidFile(processName, runner));
  const userCommand = withRemoteWorkingDirectory(command, runner);
  const cleanupCommand = `rm -f ${pidFile}`;
  const terminateCommand = `trap '' TERM; kill -TERM -- -$$ 2>/dev/null; ${cleanupCommand}; exit 143`;
  const managedCommand = [
    `mkdir -p ${stateDirectory}`,
    `echo $$ > ${pidFile}`,
    `trap ${shellQuote(cleanupCommand)} EXIT`,
    `trap ${shellQuote(terminateCommand)} INT TERM HUP`,
    userCommand
  ].join("; ");

  return `setsid bash -lc ${shellQuote(managedCommand)}`;
}

function buildRemoteStopCommand(processName, runner = getCommandRunner()) {
  const pidFile = remotePathExpression(getRemotePidFile(processName, runner));
  return [
    `if [ ! -f ${pidFile} ]; then exit 0; fi`,
    `pid="$(cat ${pidFile} 2>/dev/null || true)"`,
    `if [ -z "$pid" ]; then rm -f ${pidFile}; exit 0; fi`,
    `kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true`,
    `for i in 1 2 3 4 5; do kill -0 -- "-$pid" 2>/dev/null || break; sleep 1; done`,
    `kill -0 -- "-$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null || true`,
    `rm -f ${pidFile}`
  ].join("; ");
}

function formatCommand(command, args) {
  return [command, ...args.map(shellQuote)].join(" ");
}

function buildProcessSpec(command, processName, runner = getCommandRunner()) {
  if (runner.mode === "ssh") {
    const remoteCommand = buildRemoteManagedCommand(command, processName, runner);
    const args = [...buildSshBaseArgs(runner), remoteCommand];
    return {
      command: "ssh",
      args,
      displayCommand: formatCommand("ssh", args)
    };
  }

  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-Command", command]
    : ["-lc", command];
  return {
    command: shell,
    args,
    displayCommand: command
  };
}

function buildSshStopSpec(processName, runner = getCommandRunner()) {
  const remoteCommand = `bash -lc ${shellQuote(buildRemoteStopCommand(processName, runner))}`;
  const args = [...buildSshBaseArgs(runner), remoteCommand];
  return {
    command: "ssh",
    args,
    displayCommand: formatCommand("ssh", args)
  };
}

let appConfig = loadConfig();
let activeProcess = null;
let activeProfile = null;
let rosbagProcess = null;
let logLines = [];
let sensorStatuses = {};
let clients = new Set();

function resetSensorStatuses() {
  sensorStatuses = {};
  for (const sensor of appConfig.sensors) {
    sensorStatuses[sensor.id] = {
      matchedOutputs: [],
      healthy: false,
      lastMatchedAt: null
    };
  }
}

function getState() {
  return {
    config: appConfig,
    runtime: {
      isRunning: Boolean(activeProcess),
      activeProfile,
      pid: activeProcess ? activeProcess.pid : null,
      startedAt: activeProcess ? activeProcess.startedAt : null,
      exitCode: activeProcess ? null : null
    },
    rosbag: {
      isRecording: Boolean(rosbagProcess),
      pid: rosbagProcess ? rosbagProcess.pid : null,
      startedAt: rosbagProcess ? rosbagProcess.startedAt : null
    },
    sensors: sensorStatuses,
    logs: logLines.slice(-500)
  };
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

function appendLog(source, message) {
  const lines = message.replace(/\r/g, "").split("\n").filter(Boolean);
  for (const line of lines) {
    const entry = {
      timestamp: new Date().toISOString(),
      source,
      line
    };
    logLines.push(entry);
    if (logLines.length > 1000) {
      logLines = logLines.slice(-1000);
    }
    updateSensorMatches(line);
    broadcast("log", entry);
  }
}

function updateSensorMatches(line) {
  const lowerLine = line.toLowerCase();
  let changed = false;

  for (const sensor of appConfig.sensors) {
    const status = sensorStatuses[sensor.id];
    const expectedOutputs = Array.isArray(sensor.expectedOutputs) ? sensor.expectedOutputs : [];

    for (const expected of expectedOutputs) {
      const normalizedExpected = String(expected).trim().toLowerCase();
      if (!normalizedExpected) {
        continue;
      }

      if (lowerLine.includes(normalizedExpected) && !status.matchedOutputs.includes(expected)) {
        status.matchedOutputs.push(expected);
        status.lastMatchedAt = new Date().toISOString();
        changed = true;
      }
    }

    const nextHealthy = expectedOutputs.length > 0 && status.matchedOutputs.length === expectedOutputs.length;
    if (status.healthy !== nextHealthy) {
      status.healthy = nextHealthy;
      changed = true;
    }
  }

  if (changed) {
    broadcast("sensor-status", sensorStatuses);
  }
}

function waitForExit(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) {
      resolve({ stopped: true, code: proc.exitCode, signal: proc.signalCode });
      return;
    }

    proc.once("exit", (code, signal) => {
      resolve({ stopped: true, code, signal });
    });
  });
}

function terminateProcess(proc, signal, forceSignal) {
  if (proc.exitCode !== null || proc.signalCode) {
    return;
  }

  let exited = false;
  let forceTimer = null;

  proc.once("exit", () => {
    exited = true;
    if (forceTimer) {
      clearTimeout(forceTimer);
    }
  });

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    return;
  }

  proc.kill(signal);
  forceTimer = setTimeout(() => {
    if (!exited) {
      proc.kill(forceSignal);
    }
  }, 5000);
}

function stopRemoteProcess(runner, processName, source) {
  return new Promise((resolve) => {
    let spec;
    try {
      spec = buildSshStopSpec(processName, runner);
    } catch (error) {
      appendLog(source, `Could not build SSH stop command: ${error.message}`);
      resolve({ remoteStopped: false, error: error.message });
      return;
    }

    appendLog(source, `Stopping remote ${processName} process on ${describeRunnerTarget(runner)}`);
    const child = spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: process.env
    });

    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    child.stdout.on("data", (chunk) => appendLog(`${source}-stdout`, chunk.toString()));
    child.stderr.on("data", (chunk) => appendLog(`${source}-stderr`, chunk.toString()));
    child.on("error", (error) => {
      appendLog(source, `Failed to run SSH stop command: ${error.message}`);
      finish({ remoteStopped: false, error: error.message });
    });
    child.on("exit", (code, signal) => {
      if (code !== 0) {
        appendLog(source, `SSH stop command exited with code ${code} signal ${signal || "none"}`);
      }
      finish({ remoteStopped: code === 0, code, signal });
    });
  });
}

async function stopActiveProcess() {
  if (!activeProcess) {
    return { stopped: false };
  }

  const proc = activeProcess;
  const runner = proc.commandRunner || getCommandRunner();
  activeProcess = null;
  activeProfile = null;
  const exitPromise = waitForExit(proc);
  let remoteResult = null;

  if (runner.mode === "ssh") {
    remoteResult = await stopRemoteProcess(runner, "launch", "system");
    terminateProcess(proc, "SIGTERM", "SIGKILL");
  } else {
    terminateProcess(proc, "SIGTERM", "SIGKILL");
  }

  const exitResult = await exitPromise;
  return { ...exitResult, remote: remoteResult };
}

function buildRosbagCommand(runner = getCommandRunner()) {
  const rosbag = appConfig.rosbag || {};
  const topics = Array.isArray(rosbag.topics)
    ? rosbag.topics.map((topic) => String(topic).trim()).filter(Boolean)
    : [];

  if (topics.length === 0) {
    throw new Error("No rosbag topics configured.");
  }

  const outputDirectory = String(rosbag.outputDirectory || "~/rosbags").trim();
  const outputPrefix = String(rosbag.outputPrefix || "sensor_stack").trim();
  const setupCommand = String(rosbag.setupCommand || "").trim();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = `${outputDirectory}/${outputPrefix}_${timestamp}`;
  const useWindowsShell = process.platform === "win32" && runner.mode !== "ssh";
  const mkdirCommand = useWindowsShell
    ? `New-Item -ItemType Directory -Force -Path ${outputDirectory} | Out-Null`
    : `mkdir -p ${outputDirectory}`;
  const recordCommand = `ros2 bag record -o ${outputPath} ${topics.join(" ")}`;

  return setupCommand
    ? `${setupCommand} && ${mkdirCommand} && ${recordCommand}`
    : `${mkdirCommand} && ${recordCommand}`;
}

async function stopRosbagProcess() {
  if (!rosbagProcess) {
    return { stopped: false };
  }

  const proc = rosbagProcess;
  const runner = proc.commandRunner || getCommandRunner();
  rosbagProcess = null;
  const exitPromise = waitForExit(proc);
  let remoteResult = null;

  if (runner.mode === "ssh") {
    remoteResult = await stopRemoteProcess(runner, "rosbag", "rosbag");
    terminateProcess(proc, "SIGTERM", "SIGKILL");
  } else {
    terminateProcess(proc, "SIGINT", "SIGTERM");
  }

  const exitResult = await exitPromise;
  return { ...exitResult, remote: remoteResult };
}

function startRosbagProcess() {
  if (rosbagProcess) {
    throw new Error("Rosbag recording is already running.");
  }
  if (appConfig.rosbag && appConfig.rosbag.enabled === false) {
    throw new Error("Rosbag recording is disabled in config.");
  }

  const runner = getCommandRunner();
  const command = buildRosbagCommand(runner);
  const spec = buildProcessSpec(command, "rosbag", runner);

  appendLog("rosbag", `Starting recorder on ${describeRunnerTarget(runner)}`);
  appendLog("rosbag", `Command: ${spec.displayCommand}`);

  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env: process.env
  });

  child.startedAt = new Date().toISOString();
  child.commandRunner = runner;
  rosbagProcess = child;

  child.stdout.on("data", (chunk) => appendLog("rosbag-stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog("rosbag-stderr", chunk.toString()));
  child.on("error", (error) => {
    appendLog("rosbag", `Failed to start recorder: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (rosbagProcess && rosbagProcess.pid === child.pid) {
      rosbagProcess = null;
    }
    appendLog("rosbag", `Recorder exited with code ${code} signal ${signal || "none"}`);
    broadcast("rosbag-runtime", getState().rosbag);
  });

  broadcast("rosbag-runtime", getState().rosbag);
}

function startProfile(profileId) {
  const profile = appConfig.launchProfiles[profileId];
  if (!profile) {
    throw new Error("Unknown launch profile.");
  }
  if (!profile.command || !profile.command.trim()) {
    throw new Error("Launch profile command is empty.");
  }
  if (activeProcess) {
    throw new Error("A launch process is already running.");
  }

  resetSensorStatuses();
  logLines = [];
  const runner = getCommandRunner();
  const spec = buildProcessSpec(profile.command, "launch", runner);
  appendLog("system", `Starting profile ${profile.label} on ${describeRunnerTarget(runner)}`);
  appendLog("system", `Command: ${spec.displayCommand}`);

  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env: process.env
  });

  child.startedAt = new Date().toISOString();
  child.commandRunner = runner;
  activeProcess = child;
  activeProfile = profileId;

  child.stdout.on("data", (chunk) => appendLog("stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog("stderr", chunk.toString()));
  child.on("error", (error) => {
    appendLog("system", `Failed to start process: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (activeProcess && activeProcess.pid === child.pid) {
      activeProcess = null;
      activeProfile = null;
    }
    appendLog("system", `Process exited with code ${code} signal ${signal || "none"}`);
    broadcast("runtime", getState().runtime);
  });

  broadcast("runtime", getState().runtime);
}

resetSensorStatuses();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, getState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    try {
      const payload = await readRequestBody(req);
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { error: "Invalid config payload." });
        return;
      }

      appConfig = normalizeConfig(payload);
      saveConfig(appConfig);
      resetSensorStatuses();
      broadcast("config", appConfig);
      broadcast("sensor-status", sensorStatuses);
      sendJson(res, 200, { ok: true, config: appConfig });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    try {
      const payload = await readRequestBody(req);
      startProfile(payload.profileId);
      sendJson(res, 200, { ok: true, runtime: getState().runtime });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const result = await stopActiveProcess();
    sendJson(res, 200, { ok: true, result, runtime: getState().runtime });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rosbag/start") {
    try {
      startRosbagProcess();
      sendJson(res, 200, { ok: true, rosbag: getState().rosbag });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rosbag/stop") {
    const result = await stopRosbagProcess();
    sendJson(res, 200, { ok: true, result, rosbag: getState().rosbag });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`event: bootstrap\ndata: ${JSON.stringify(getState())}\n\n`);
    clients.add(res);

    req.on("close", () => {
      clients.delete(res);
    });
    return;
  }

  if (req.method === "GET") {
    const filePath = sanitizeFilePath(url.pathname);
    if (!filePath) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    fs.readFile(filePath, (error, contents) => {
      if (error) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      res.writeHead(200, { "Content-Type": getContentType(filePath) });
      res.end(contents);
    });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`Jetson ROS launcher available at http://${BIND_HOST}:${PORT}`);
});
