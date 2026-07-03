const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_DIR = path.join(__dirname, "config");
const CONFIG_PATH = path.join(CONFIG_DIR, "app-config.json");

const DEFAULT_CONFIG = {
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
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function saveConfig(config) {
  ensureConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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

function stopActiveProcess() {
  return new Promise((resolve) => {
    if (!activeProcess) {
      resolve({ stopped: false });
      return;
    }

    const proc = activeProcess;
    activeProcess = null;
    activeProfile = null;

    proc.once("exit", (code, signal) => {
      appendLog("system", `Process exited with code ${code} signal ${signal || "none"}`);
      broadcast("runtime", getState().runtime);
      resolve({ stopped: true, code, signal });
    });

    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    } else {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5000);
    }
  });
}

function buildRosbagCommand() {
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
  const mkdirCommand = process.platform === "win32"
    ? `New-Item -ItemType Directory -Force -Path ${outputDirectory} | Out-Null`
    : `mkdir -p ${outputDirectory}`;
  const recordCommand = `ros2 bag record -o ${outputPath} ${topics.join(" ")}`;

  return setupCommand
    ? `${setupCommand} && ${mkdirCommand} && ${recordCommand}`
    : `${mkdirCommand} && ${recordCommand}`;
}

function stopRosbagProcess() {
  return new Promise((resolve) => {
    if (!rosbagProcess) {
      resolve({ stopped: false });
      return;
    }

    const proc = rosbagProcess;
    rosbagProcess = null;

    proc.once("exit", (code, signal) => {
      appendLog("rosbag", `Recorder exited with code ${code} signal ${signal || "none"}`);
      broadcast("rosbag-runtime", getState().rosbag);
      resolve({ stopped: true, code, signal });
    });

    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    } else {
      proc.kill("SIGINT");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGTERM");
        }
      }, 5000);
    }
  });
}

function startRosbagProcess() {
  if (rosbagProcess) {
    throw new Error("Rosbag recording is already running.");
  }
  if (appConfig.rosbag && appConfig.rosbag.enabled === false) {
    throw new Error("Rosbag recording is disabled in config.");
  }

  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const command = buildRosbagCommand();
  const shellArgs = process.platform === "win32"
    ? ["-NoProfile", "-Command", command]
    : ["-lc", command];

  appendLog("rosbag", `Starting recorder with command: ${command}`);

  const child = spawn(shell, shellArgs, {
    cwd: process.cwd(),
    env: process.env
  });

  child.startedAt = new Date().toISOString();
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
  appendLog("system", `Starting profile ${profile.label}`);

  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const shellArgs = process.platform === "win32"
    ? ["-NoProfile", "-Command", profile.command]
    : ["-lc", profile.command];

  const child = spawn(shell, shellArgs, {
    cwd: process.cwd(),
    env: process.env
  });

  child.startedAt = new Date().toISOString();
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

      appConfig = {
        launchProfiles: payload.launchProfiles || {},
        sensors: Array.isArray(payload.sensors) ? payload.sensors : [],
        rosbag: payload.rosbag || DEFAULT_CONFIG.rosbag
      };
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

server.listen(PORT, () => {
  console.log(`Jetson ROS launcher available at http://localhost:${PORT}`);
});
