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
  hardware: {
    ouster: {
      lidarIp: "",
      lidarMode: "1024x10",
      timestampMode: "TIME_FROM_ROS_TIME",
      pointType: "original"
    }
  },
  drivers: {
    ouster: {
      label: "Ouster LiDAR Driver",
      command: "source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch ouster_ros sensor.launch.xml sensor_hostname:={{hardware.ouster.lidarIp}} lidar_mode:={{hardware.ouster.lidarMode}} timestamp_mode:={{hardware.ouster.timestampMode}} point_type:={{hardware.ouster.pointType}} viz:=false",
      requiredTopics: [
        "/ouster/points"
      ]
    },
    mti680g: {
      label: "MTi-680G IMU/GPS Driver",
      command: "source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch xsens_mti_ros2_driver xsens_mti_node.launch.py",
      requiredTopics: [
        "/imu/data",
        "/gnss"
      ]
    }
  },
  slam: {
    selectedDriver: "lio_sam",
    drivers: {
      custom_slam: {
        label: "Custom SLAM",
        command: "source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch your_slam_package slam.launch.py",
        requiredTopics: [
          "/map",
          "/odom"
        ]
      },
      lio_sam: {
        label: "LIO-SAM",
        command: "source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch lio_sam run.launch.py params_file:=$(ros2 pkg prefix lio_sam)/share/lio_sam/config/params.yaml",
        requiredTopics: [
          "/lio_sam/mapping/odometry",
          "/lio_sam/mapping/odometry_incremental",
          "/lio_sam/mapping/cloud_registered",
          "/lio_sam/mapping/path"
        ]
      },
      slam_toolbox: {
        label: "slam_toolbox",
        command: "source /opt/ros/humble/setup.bash && ros2 launch slam_toolbox online_async_launch.py",
        requiredTopics: [
          "/map",
          "/odom"
        ]
      },
      fast_lio: {
        label: "FAST-LIO",
        command: "source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch fast_lio mapping.launch.py",
        requiredTopics: [
          "/Odometry",
          "/cloud_registered"
        ]
      }
    }
  },
  healthChecks: {
    setupCommand: "source /opt/ros/humble/setup.bash",
    sampleTimeoutSeconds: 4
  },
  rosbag: {
    enabled: true,
    setupCommand: "source /opt/ros/humble/setup.bash",
    outputDirectory: "~/rosbags",
    outputPrefix: "slam",
    topics: [
      "/ouster/points",
      "/imu/data",
      "/gnss",
      "/tf",
      "/tf_static",
      "/lio_sam/deskew/cloud_deskewed",
      "/lio_sam/feature/cloud_corner",
      "/lio_sam/feature/cloud_surface",
      "/lio_sam/mapping/odometry",
      "/lio_sam/mapping/odometry_incremental",
      "/lio_sam/mapping/cloud_registered",
      "/lio_sam/mapping/cloud_registered_raw",
      "/lio_sam/mapping/path"
    ]
  },
  downloads: {
    localDirectory: "~/Downloads/GenAutoSensorDash"
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

function normalizeRosbag(rosbag = {}) {
  const source = rosbag && typeof rosbag === "object" ? rosbag : {};
  return {
    ...DEFAULT_CONFIG.rosbag,
    ...source,
    topics: Array.isArray(source.topics) ? source.topics : DEFAULT_CONFIG.rosbag.topics
  };
}

function normalizeDownloads(downloads = {}) {
  const source = downloads && typeof downloads === "object" ? downloads : {};
  return {
    ...DEFAULT_CONFIG.downloads,
    ...source
  };
}

function normalizeHardware(hardware = {}) {
  const source = hardware && typeof hardware === "object" ? hardware : {};
  return {
    ...DEFAULT_CONFIG.hardware,
    ...source,
    ouster: {
      ...DEFAULT_CONFIG.hardware.ouster,
      ...(source.ouster && typeof source.ouster === "object" ? source.ouster : {})
    }
  };
}

function normalizeProcessMap(processes = {}, defaults = {}) {
  const source = processes && typeof processes === "object" ? processes : {};
  const normalized = {};
  for (const [id, defaultProcess] of Object.entries(defaults)) {
    const processConfig = source[id] && typeof source[id] === "object" ? source[id] : {};
    normalized[id] = {
      ...defaultProcess,
      ...processConfig,
      requiredTopics: Array.isArray(processConfig.requiredTopics)
        ? processConfig.requiredTopics
        : defaultProcess.requiredTopics
    };
  }

  for (const [id, processConfig] of Object.entries(source)) {
    if (normalized[id] || !processConfig || typeof processConfig !== "object") {
      continue;
    }
    normalized[id] = {
      label: processConfig.label || id,
      command: processConfig.command || "",
      requiredTopics: Array.isArray(processConfig.requiredTopics) ? processConfig.requiredTopics : []
    };
  }

  return normalized;
}

function normalizeSlam(slam = {}) {
  const source = slam && typeof slam === "object" ? slam : {};
  const defaultSlam = DEFAULT_CONFIG.slam;

  if (source.drivers && typeof source.drivers === "object") {
    const drivers = normalizeProcessMap(source.drivers, defaultSlam.drivers);
    const selectedDriver = drivers[source.selectedDriver]
      ? source.selectedDriver
      : defaultSlam.selectedDriver;
    return {
      selectedDriver,
      drivers
    };
  }

  const legacyDriverId = source.selectedDriver || "custom_slam";
  const drivers = normalizeProcessMap(
    {
      [legacyDriverId]: {
        label: source.label || "Custom SLAM",
        command: source.command || defaultSlam.drivers.custom_slam.command,
        requiredTopics: Array.isArray(source.requiredTopics)
          ? source.requiredTopics
          : defaultSlam.drivers.custom_slam.requiredTopics
      }
    },
    defaultSlam.drivers
  );

  return {
    selectedDriver: drivers[legacyDriverId] ? legacyDriverId : defaultSlam.selectedDriver,
    drivers
  };
}

function normalizeHealthChecks(healthChecks = {}) {
  const source = healthChecks && typeof healthChecks === "object" ? healthChecks : {};
  const seconds = Number(source.sampleTimeoutSeconds || DEFAULT_CONFIG.healthChecks.sampleTimeoutSeconds);
  return {
    ...DEFAULT_CONFIG.healthChecks,
    ...source,
    sampleTimeoutSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_CONFIG.healthChecks.sampleTimeoutSeconds
  };
}

function normalizeConfig(config = {}) {
  return {
    commandRunner: normalizeCommandRunner(config.commandRunner),
    launchProfiles: config.launchProfiles || DEFAULT_CONFIG.launchProfiles,
    sensors: Array.isArray(config.sensors) ? config.sensors : DEFAULT_CONFIG.sensors,
    hardware: normalizeHardware(config.hardware),
    drivers: normalizeProcessMap(config.drivers, DEFAULT_CONFIG.drivers),
    slam: normalizeSlam(config.slam),
    healthChecks: normalizeHealthChecks(config.healthChecks),
    rosbag: normalizeRosbag(config.rosbag),
    downloads: normalizeDownloads(config.downloads)
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

function getConfigValue(pathExpression) {
  return String(pathExpression)
    .split(".")
    .reduce((value, key) => {
      if (value && Object.prototype.hasOwnProperty.call(value, key)) {
        return value[key];
      }
      return undefined;
    }, appConfig);
}

function expandConfigPlaceholders(command) {
  return String(command || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, pathExpression) => {
    const value = getConfigValue(pathExpression);
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new Error(`Missing config value for command placeholder ${match}.`);
    }
    return String(value).trim();
  });
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

function getStopSignal(processName) {
  return processName === "rosbag" ? "INT" : "TERM";
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
  const stopSignal = getStopSignal(processName);
  const terminateCommand = `trap '' INT TERM HUP; kill -${stopSignal} -- -$$ 2>/dev/null; ${cleanupCommand}; exit 143`;
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
  const stopSignal = getStopSignal(processName);
  return [
    `if [ ! -f ${pidFile} ]; then exit 0; fi`,
    `pid="$(cat ${pidFile} 2>/dev/null || true)"`,
    `if [ -z "$pid" ]; then rm -f ${pidFile}; exit 0; fi`,
    `kill -${stopSignal} -- "-$pid" 2>/dev/null || kill -${stopSignal} "$pid" 2>/dev/null || true`,
    `for i in 1 2 3 4 5; do kill -0 -- "-$pid" 2>/dev/null || break; sleep 1; done`,
    `kill -0 -- "-$pid" 2>/dev/null && kill -TERM -- "-$pid" 2>/dev/null || true`,
    `sleep 1`,
    `kill -0 -- "-$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null || true`,
    `rm -f ${pidFile}`
  ].join("; ");
}

function buildRemoteSignalCommand(processName, signal, runner = getCommandRunner()) {
  const pidFile = remotePathExpression(getRemotePidFile(processName, runner));
  return [
    `if [ ! -f ${pidFile} ]; then echo "missing pidfile"; exit 2; fi`,
    `pid="$(cat ${pidFile} 2>/dev/null || true)"`,
    `if [ -z "$pid" ]; then echo "empty pidfile"; exit 2; fi`,
    `kill -${signal} -- "-$pid" 2>/dev/null || kill -${signal} "$pid"`
  ].join("; ");
}

function formatCommand(command, args) {
  return [command, ...args.map(shellQuote)].join(" ");
}

function buildProcessSpec(command, processName, runner = getCommandRunner()) {
  const renderedCommand = expandConfigPlaceholders(command);
  if (runner.mode === "ssh") {
    const remoteCommand = buildRemoteManagedCommand(renderedCommand, processName, runner);
    const args = [...buildSshBaseArgs(runner), remoteCommand];
    return {
      command: "ssh",
      args,
      displayCommand: formatCommand("ssh", args)
    };
  }

  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-Command", renderedCommand]
    : ["-lc", renderedCommand];
  return {
    command: shell,
    args,
    displayCommand: renderedCommand
  };
}

function buildOneShotSpec(command, runner = getCommandRunner()) {
  const renderedCommand = expandConfigPlaceholders(command);
  if (runner.mode === "ssh") {
    const remoteCommand = `bash -lc ${shellQuote(withRemoteWorkingDirectory(renderedCommand, runner))}`;
    const args = [...buildSshBaseArgs(runner), remoteCommand];
    return {
      command: "ssh",
      args,
      displayCommand: formatCommand("ssh", args)
    };
  }

  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-Command", renderedCommand]
    : ["-lc", renderedCommand];
  return {
    command: shell,
    args,
    displayCommand: renderedCommand
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

function buildSshSignalSpec(processName, signal, runner = getCommandRunner()) {
  const remoteCommand = `bash -lc ${shellQuote(buildRemoteSignalCommand(processName, signal, runner))}`;
  const args = [...buildSshBaseArgs(runner), remoteCommand];
  return {
    command: "ssh",
    args,
    displayCommand: formatCommand("ssh", args)
  };
}

function buildScpBaseArgs(runner = getCommandRunner()) {
  const ssh = runner.ssh;
  const host = String(ssh.host || "").trim();
  if (!host) {
    throw new Error("SCP requires commandRunner.ssh.host.");
  }

  const args = [];
  const port = Number(ssh.port || 22);
  if (port > 0) {
    args.push("-P", String(port));
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

  return args;
}

function runBufferedCommand(command, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        ...result
      });
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({ code: null, signal: null, error });
    });
    child.on("exit", (code, signal) => {
      finish({ code, signal, error: null });
    });
  });
}

function safeFileName(value) {
  const safe = String(value || "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || "recording";
}

function remoteBasename(value) {
  return String(value || "")
    .replace(/\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .pop() || "recording";
}

function getLocalDownloadDirectory() {
  return expandLocalPath(appConfig.downloads?.localDirectory || DEFAULT_CONFIG.downloads.localDirectory);
}

function serializeRecording(recording) {
  if (!recording) {
    return null;
  }

  const { commandRunner, ...publicRecording } = recording;
  return publicRecording;
}

function buildScpSource(recording, runner) {
  const ssh = runner.ssh;
  const host = String(ssh.host || "").trim();
  const destination = ssh.user ? `${ssh.user}@${host}` : host;
  return `${destination}:${recording.remotePath}`;
}

function buildConnectionCheckSpec(runner = getCommandRunner()) {
  const stateDirectory = remotePathExpression(getRemoteStateDirectory(runner));
  const outputDirectory = remotePathExpression(appConfig.rosbag?.outputDirectory || DEFAULT_CONFIG.rosbag.outputDirectory);
  const checkCommand = [
    `mkdir -p ${stateDirectory} ${outputDirectory}`,
    `test -w ${stateDirectory}`,
    `test -w ${outputDirectory}`,
    `printf 'online '`,
    `hostname`
  ].join(" && ");
  const remoteCommand = `bash -lc ${shellQuote(checkCommand)}`;
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
let managedProcesses = {};
let activeRosbagRecording = null;
let rosbagRecordings = [];
let downloadArchives = new Map();
let connectionStatus = {
  status: "unknown",
  checkedAt: null,
  message: "Connection has not been checked yet."
};
let topicHealth = {
  checkedAt: null,
  checks: {}
};
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

function getConnectionState() {
  return {
    ...connectionStatus,
    target: describeRunnerTarget()
  };
}

function setConnectionStatus(status, message) {
  connectionStatus = {
    status,
    message,
    checkedAt: new Date().toISOString()
  };
  broadcast("connection", getConnectionState());
}

function getConfiguredProcesses() {
  const driverProcesses = Object.entries(appConfig.drivers || {}).map(([id, config]) => ({
    id,
    type: "driver",
    ...config
  }));
  const slamConfig = appConfig.slam || DEFAULT_CONFIG.slam;
  const selectedSlamDriver = slamConfig.selectedDriver || DEFAULT_CONFIG.slam.selectedDriver;
  const slamDriver = slamConfig.drivers?.[selectedSlamDriver] || DEFAULT_CONFIG.slam.drivers.custom_slam;
  return [
    ...driverProcesses,
    {
      id: "slam",
      type: "slam",
      selectedDriver: selectedSlamDriver,
      availableDrivers: Object.keys(slamConfig.drivers || {}),
      ...slamDriver
    }
  ];
}

function getConfiguredProcess(processId) {
  return getConfiguredProcesses().find((processConfig) => processConfig.id === processId) || null;
}

function getManagedProcessState(processConfig) {
  const proc = managedProcesses[processConfig.id];
  return {
    id: processConfig.id,
    type: processConfig.type,
    label: processConfig.label || processConfig.id,
    selectedDriver: processConfig.selectedDriver || null,
    availableDrivers: Array.isArray(processConfig.availableDrivers) ? processConfig.availableDrivers : [],
    command: processConfig.command || "",
    requiredTopics: Array.isArray(processConfig.requiredTopics) ? processConfig.requiredTopics : [],
    status: proc ? proc.status : "stopped",
    pid: proc ? proc.pid : null,
    startedAt: proc ? proc.startedAt : null,
    pausedAt: proc ? proc.pausedAt : null
  };
}

function getManagedProcessStates() {
  return getConfiguredProcesses().map(getManagedProcessState);
}

function getState() {
  return {
    config: appConfig,
    connection: getConnectionState(),
    processes: getManagedProcessStates(),
    health: topicHealth,
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
      startedAt: rosbagProcess ? rosbagProcess.startedAt : null,
      activeRecording: serializeRecording(activeRosbagRecording),
      recordings: rosbagRecordings.slice(-20).map(serializeRecording)
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

async function checkConnection() {
  const runner = getCommandRunner();
  setConnectionStatus("checking", `Checking ${describeRunnerTarget(runner)}...`);

  if (runner.mode !== "ssh") {
    setConnectionStatus("online", "Local command runner is available.");
    appendLog("connection", "Local command runner is online.");
    return getConnectionState();
  }

  let spec;
  try {
    spec = buildConnectionCheckSpec(runner);
  } catch (error) {
    setConnectionStatus("offline", error.message);
    appendLog("connection", `Connection check could not start: ${error.message}`);
    return getConnectionState();
  }

  appendLog("connection", `Checking ${describeRunnerTarget(runner)}`);
  const result = await runBufferedCommand(spec.command, spec.args, 10000);
  const output = `${result.stdout}${result.stderr}`.trim();

  if (result.code === 0) {
    const message = output || "Jetson is online and writable.";
    setConnectionStatus("online", message);
    appendLog("connection", `Online: ${message}`);
  } else {
    const detail = result.error
      ? result.error.message
      : output || `ssh exited with code ${result.code} signal ${result.signal || "none"}`;
    setConnectionStatus("offline", detail);
    appendLog("connection", `Offline: ${detail}`);
  }

  return getConnectionState();
}

function buildTopicHealthCommand() {
  const healthConfig = appConfig.healthChecks || DEFAULT_CONFIG.healthChecks;
  const setupCommand = String(healthConfig.setupCommand || "").trim();
  const timeoutSeconds = Math.max(1, Number(healthConfig.sampleTimeoutSeconds || 4));
  const checks = getConfiguredProcesses()
    .map((processConfig) => ({
      id: processConfig.id,
      label: processConfig.label || processConfig.id,
      topics: Array.isArray(processConfig.requiredTopics)
        ? processConfig.requiredTopics.map((topic) => String(topic).trim()).filter(Boolean)
        : []
    }))
    .filter((check) => check.topics.length > 0);

  const lines = [];
  for (const check of checks) {
    for (const topic of check.topics) {
      lines.push([
        `topic=${shellQuote(topic)}`,
        `if timeout ${Math.ceil(timeoutSeconds)}s ros2 topic echo --once "$topic" >/dev/null 2>&1; then`,
        `printf '%s|%s|online|data\\n' ${shellQuote(check.id)} "$topic"`,
        `elif ros2 topic list 2>/dev/null | grep -Fxq "$topic"; then`,
        `printf '%s|%s|waiting|listed_no_data\\n' ${shellQuote(check.id)} "$topic"`,
        `else`,
        `printf '%s|%s|offline|missing\\n' ${shellQuote(check.id)} "$topic"`,
        `fi`
      ].join(" "));
    }
  }

  const checkCommand = lines.length > 0 ? lines.join("; ") : "true";
  return setupCommand ? `${setupCommand} && ${checkCommand}` : checkCommand;
}

function parseTopicHealthOutput(output) {
  const checks = {};
  for (const processConfig of getConfiguredProcesses()) {
    checks[processConfig.id] = {
      id: processConfig.id,
      label: processConfig.label || processConfig.id,
      healthy: false,
      topics: []
    };
  }

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [processId, topic, status, detail] = trimmed.split("|");
    if (!processId || !topic || !checks[processId]) {
      continue;
    }
    checks[processId].topics.push({
      topic,
      status: status || "unknown",
      detail: detail || ""
    });
  }

  for (const check of Object.values(checks)) {
    const expectedTopics = getConfiguredProcess(check.id)?.requiredTopics || [];
    if (check.topics.length === 0 && expectedTopics.length > 0) {
      check.topics = expectedTopics.map((topic) => ({
        topic,
        status: "offline",
        detail: "not_checked"
      }));
    }
    check.healthy = check.topics.length > 0 && check.topics.every((topic) => topic.status === "online");
  }

  return checks;
}

async function checkTopicHealth() {
  const runner = getCommandRunner();
  const command = buildTopicHealthCommand();
  const spec = buildOneShotSpec(command, runner);

  appendLog("health", `Checking ROS topics on ${describeRunnerTarget(runner)}`);
  const result = await runBufferedCommand(spec.command, spec.args, 60000);
  const output = `${result.stdout || ""}`.trim();
  const errorOutput = `${result.stderr || ""}`.trim();

  topicHealth = {
    checkedAt: new Date().toISOString(),
    checks: parseTopicHealthOutput(output),
    error: result.code === 0 ? null : (result.error ? result.error.message : errorOutput || `health check exited with ${result.code}`)
  };

  if (topicHealth.error) {
    appendLog("health", `Topic check warning: ${topicHealth.error}`);
  }
  broadcast("health", topicHealth);
  return topicHealth;
}

function createRosbagRecording(outputPath, runner) {
  const startedAt = new Date().toISOString();
  const name = remoteBasename(outputPath);
  return {
    id: safeFileName(`${name}-${startedAt}`),
    name,
    remotePath: outputPath,
    target: describeRunnerTarget(runner),
    status: "recording",
    startedAt,
    stoppedAt: null,
    downloadedAt: null,
    archiveName: null,
    commandRunner: runner
  };
}

function upsertRosbagRecording(recording) {
  const existingIndex = rosbagRecordings.findIndex((item) => item.id === recording.id);
  if (existingIndex >= 0) {
    rosbagRecordings[existingIndex] = recording;
  } else {
    rosbagRecordings.push(recording);
  }
  rosbagRecordings = rosbagRecordings.slice(-50);
}

function finalizeRosbagRecording(recordingId, status = "saved_on_jetson") {
  const recording = rosbagRecordings.find((item) => item.id === recordingId);
  if (!recording) {
    return null;
  }

  if (recording.status === "recording") {
    recording.status = status;
    recording.stoppedAt = new Date().toISOString();
  }

  if (activeRosbagRecording && activeRosbagRecording.id === recording.id) {
    activeRosbagRecording = null;
  }

  broadcast("rosbag-runtime", getState().rosbag);
  return recording;
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

async function signalRemoteProcess(runner, processName, signal, source) {
  let spec;
  try {
    spec = buildSshSignalSpec(processName, signal, runner);
  } catch (error) {
    appendLog(source, `Could not build SSH ${signal} command: ${error.message}`);
    return { signaled: false, error: error.message };
  }

  appendLog(source, `Sending ${signal} to remote ${processName} process on ${describeRunnerTarget(runner)}`);
  const result = await runBufferedCommand(spec.command, spec.args, 10000);
  if (result.code !== 0) {
    const detail = result.error
      ? result.error.message
      : `${result.stderr || result.stdout || `ssh exited with ${result.code}`}`.trim();
    appendLog(source, `Remote ${signal} failed: ${detail}`);
  }
  return { signaled: result.code === 0, code: result.code, signal: result.signal };
}

function getManagedProcessName(processId) {
  return `managed_${String(processId).replace(/[^a-z0-9_-]/gi, "_")}`;
}

function broadcastProcesses() {
  broadcast("processes", getManagedProcessStates());
}

function startManagedProcess(processId) {
  const processConfig = getConfiguredProcess(processId);
  if (!processConfig) {
    throw new Error("Unknown process.");
  }
  if (!processConfig.command || !processConfig.command.trim()) {
    throw new Error(`${processConfig.label || processId} command is empty.`);
  }
  if (managedProcesses[processId]) {
    throw new Error(`${processConfig.label || processId} is already started.`);
  }

  const runner = getCommandRunner();
  const processName = getManagedProcessName(processId);
  const spec = buildProcessSpec(processConfig.command, processName, runner);

  appendLog(processId, `Starting ${processConfig.label || processId} on ${describeRunnerTarget(runner)}`);
  appendLog(processId, `Command: ${spec.displayCommand}`);

  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env: process.env
  });

  child.startedAt = new Date().toISOString();
  child.pausedAt = null;
  child.status = "running";
  child.commandRunner = runner;
  child.processName = processName;
  child.processId = processId;
  managedProcesses[processId] = child;

  child.stdout.on("data", (chunk) => appendLog(`${processId}-stdout`, chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog(`${processId}-stderr`, chunk.toString()));
  child.on("error", (error) => {
    appendLog(processId, `Failed to start ${processConfig.label || processId}: ${error.message}`);
    if (managedProcesses[processId] && managedProcesses[processId].pid === child.pid) {
      delete managedProcesses[processId];
      broadcastProcesses();
    }
  });
  child.on("exit", (code, signal) => {
    if (managedProcesses[processId] && managedProcesses[processId].pid === child.pid) {
      delete managedProcesses[processId];
    }
    appendLog(processId, `${processConfig.label || processId} exited with code ${code} signal ${signal || "none"}`);
    broadcastProcesses();
  });

  broadcastProcesses();
}

async function stopManagedProcess(processId) {
  const proc = managedProcesses[processId];
  if (!proc) {
    return { stopped: false };
  }

  const runner = proc.commandRunner || getCommandRunner();
  delete managedProcesses[processId];
  const exitPromise = waitForExit(proc);
  let remoteResult = null;

  if (runner.mode === "ssh") {
    remoteResult = await stopRemoteProcess(runner, proc.processName, processId);
    terminateProcess(proc, "SIGTERM", "SIGKILL");
  } else {
    terminateProcess(proc, "SIGTERM", "SIGKILL");
  }

  const exitResult = await exitPromise;
  broadcastProcesses();
  return { ...exitResult, remote: remoteResult };
}

async function pauseManagedProcess(processId) {
  const proc = managedProcesses[processId];
  if (!proc) {
    throw new Error("Process is not running.");
  }
  if (proc.status === "paused") {
    return { paused: true };
  }

  const runner = proc.commandRunner || getCommandRunner();
  let result = { signaled: true };
  if (runner.mode === "ssh") {
    result = await signalRemoteProcess(runner, proc.processName, "STOP", processId);
  } else if (process.platform === "win32") {
    throw new Error("Pause is not supported for local Windows processes.");
  } else {
    proc.kill("SIGSTOP");
  }

  if (result.signaled) {
    proc.status = "paused";
    proc.pausedAt = new Date().toISOString();
    broadcastProcesses();
  }
  return { paused: result.signaled, result };
}

async function resumeManagedProcess(processId) {
  const proc = managedProcesses[processId];
  if (!proc) {
    throw new Error("Process is not running.");
  }
  if (proc.status !== "paused") {
    return { resumed: true };
  }

  const runner = proc.commandRunner || getCommandRunner();
  let result = { signaled: true };
  if (runner.mode === "ssh") {
    result = await signalRemoteProcess(runner, proc.processName, "CONT", processId);
  } else if (process.platform === "win32") {
    throw new Error("Resume is not supported for local Windows processes.");
  } else {
    proc.kill("SIGCONT");
  }

  if (result.signaled) {
    proc.status = "running";
    proc.pausedAt = null;
    broadcastProcesses();
  }
  return { resumed: result.signaled, result };
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

function buildRosbagPlan(runner = getCommandRunner()) {
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
    : `mkdir -p ${remotePathExpression(outputDirectory)}`;
  const recordCommand = useWindowsShell
    ? `ros2 bag record -o ${outputPath} ${topics.join(" ")}`
    : `ros2 bag record -o ${remotePathExpression(outputPath)} ${topics.map(shellQuote).join(" ")}`;

  const command = setupCommand
    ? `${setupCommand} && ${mkdirCommand} && ${recordCommand}`
    : `${mkdirCommand} && ${recordCommand}`;

  return {
    command,
    outputPath
  };
}

async function stopRosbagProcess() {
  if (!rosbagProcess) {
    return { stopped: false };
  }

  const proc = rosbagProcess;
  const runner = proc.commandRunner || getCommandRunner();
  const recordingId = proc.recordingId;
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
  if (recordingId) {
    finalizeRosbagRecording(recordingId, "saved_on_jetson");
  }
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
  const plan = buildRosbagPlan(runner);
  const recording = createRosbagRecording(plan.outputPath, runner);
  const spec = buildProcessSpec(plan.command, "rosbag", runner);

  appendLog("rosbag", `Starting recorder on ${describeRunnerTarget(runner)}`);
  appendLog("rosbag", `Output: ${plan.outputPath}`);
  appendLog("rosbag", `Command: ${spec.displayCommand}`);

  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env: process.env
  });

  child.startedAt = recording.startedAt;
  child.commandRunner = runner;
  child.recordingId = recording.id;
  activeRosbagRecording = recording;
  upsertRosbagRecording(recording);
  rosbagProcess = child;

  child.stdout.on("data", (chunk) => appendLog("rosbag-stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog("rosbag-stderr", chunk.toString()));
  child.on("error", (error) => {
    appendLog("rosbag", `Failed to start recorder: ${error.message}`);
    if (rosbagProcess && rosbagProcess.pid === child.pid) {
      rosbagProcess = null;
    }
    finalizeRosbagRecording(recording.id, "failed");
  });
  child.on("exit", (code, signal) => {
    if (rosbagProcess && rosbagProcess.pid === child.pid) {
      rosbagProcess = null;
    }
    finalizeRosbagRecording(recording.id, "saved_on_jetson");
    appendLog("rosbag", `Recorder exited with code ${code} signal ${signal || "none"}`);
    broadcast("rosbag-runtime", getState().rosbag);
  });

  broadcast("rosbag-runtime", getState().rosbag);
}

async function prepareRecordingDownload(recordingId) {
  const recording = rosbagRecordings.find((item) => item.id === recordingId);
  if (!recording) {
    throw new Error("Unknown recording.");
  }
  if (recording.status === "recording") {
    throw new Error("Stop the recording before saving it to this device.");
  }

  const previousStatus = recording.status;
  recording.status = "copying_to_device";
  broadcast("rosbag-runtime", getState().rosbag);

  const safeName = safeFileName(recording.name || recording.id);
  const localRoot = getLocalDownloadDirectory();
  const copyParent = path.join(localRoot, "copies");
  const archiveParent = path.join(localRoot, "archives");
  const localCopyPath = path.join(copyParent, `${safeName}-${recording.id}`);
  const archiveName = `${safeName}-${recording.id}.tar.gz`;
  const archivePath = path.join(archiveParent, archiveName);

  try {
    fs.mkdirSync(copyParent, { recursive: true });
    fs.mkdirSync(archiveParent, { recursive: true });
    fs.rmSync(localCopyPath, { recursive: true, force: true });

    if (recording.commandRunner?.mode === "ssh") {
      const scpArgs = [
        ...buildScpBaseArgs(recording.commandRunner),
        "-r",
        buildScpSource(recording, recording.commandRunner),
        localCopyPath
      ];
      appendLog("download", `Copying ${recording.remotePath} to this device with scp.`);
      const scpResult = await runBufferedCommand("scp", scpArgs, 30 * 60 * 1000);
      if (scpResult.code !== 0) {
        const detail = scpResult.error
          ? scpResult.error.message
          : `${scpResult.stderr || scpResult.stdout || "scp failed"}`.trim();
        throw new Error(detail);
      }
    } else {
      const localSource = expandLocalPath(recording.remotePath);
      if (!fs.existsSync(localSource)) {
        throw new Error(`Local recording does not exist: ${localSource}`);
      }
      fs.cpSync(localSource, localCopyPath, { recursive: true });
    }

    const tarResult = await runBufferedCommand(
      "tar",
      ["-czf", archivePath, "-C", path.dirname(localCopyPath), path.basename(localCopyPath)],
      30 * 60 * 1000
    );
    if (tarResult.code !== 0) {
      const detail = tarResult.error
        ? tarResult.error.message
        : `${tarResult.stderr || tarResult.stdout || "tar failed"}`.trim();
      throw new Error(detail);
    }

    downloadArchives.set(archiveName, {
      path: archivePath,
      createdAt: new Date().toISOString()
    });
    recording.status = "downloaded";
    recording.downloadedAt = new Date().toISOString();
    recording.archiveName = archiveName;
    appendLog("download", `Saved archive: ${archivePath}`);
    broadcast("rosbag-runtime", getState().rosbag);

    return {
      archiveName,
      downloadUrl: `/api/downloads/${encodeURIComponent(archiveName)}`,
      localArchivePath: archivePath
    };
  } catch (error) {
    recording.status = previousStatus;
    broadcast("rosbag-runtime", getState().rosbag);
    throw error;
  }
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

  if (req.method === "POST" && url.pathname === "/api/connection/check") {
    const connection = await checkConnection();
    sendJson(res, 200, { ok: connection.status === "online", connection });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/health/check") {
    const health = await checkTopicHealth();
    sendJson(res, 200, { ok: !health.error, health });
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
      topicHealth = {
        checkedAt: null,
        checks: {}
      };
      setConnectionStatus("unknown", "Config changed. Check the Jetson connection again.");
      broadcast("config", appConfig);
      broadcastProcesses();
      broadcast("health", topicHealth);
      broadcast("sensor-status", sensorStatuses);
      sendJson(res, 200, { ok: true, config: appConfig, processes: getManagedProcessStates(), health: topicHealth });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  const processActionMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/(start|stop|pause|resume)$/);
  if (req.method === "POST" && processActionMatch) {
    const processId = decodeURIComponent(processActionMatch[1]);
    const action = processActionMatch[2];
    try {
      let result;
      if (action === "start") {
        startManagedProcess(processId);
        result = { started: true };
      } else if (action === "stop") {
        result = await stopManagedProcess(processId);
      } else if (action === "pause") {
        result = await pauseManagedProcess(processId);
      } else {
        result = await resumeManagedProcess(processId);
      }
      sendJson(res, 200, { ok: true, result, processes: getManagedProcessStates() });
    } catch (error) {
      sendJson(res, 400, { error: error.message, processes: getManagedProcessStates() });
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

  const recordingDownloadMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/download$/);
  if (req.method === "POST" && recordingDownloadMatch) {
    try {
      const result = await prepareRecordingDownload(decodeURIComponent(recordingDownloadMatch[1]));
      sendJson(res, 200, { ok: true, ...result, rosbag: getState().rosbag });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
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

  const downloadMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)$/);
  if (req.method === "GET" && downloadMatch) {
    const archiveName = decodeURIComponent(downloadMatch[1]);
    const archive = downloadArchives.get(archiveName);
    if (!archive || !fs.existsSync(archive.path)) {
      sendJson(res, 404, { error: "Download not found." });
      return;
    }

    const stat = fs.statSync(archive.path);
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${archiveName}"`
    });
    fs.createReadStream(archive.path).pipe(res);
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
  console.log(`Jetson LiDAR recorder available at http://${BIND_HOST}:${PORT}`);
});
