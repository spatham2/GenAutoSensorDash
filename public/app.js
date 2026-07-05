const state = {
  config: null,
  connection: null,
  processes: [],
  health: null,
  runtime: null,
  rosbag: null,
  sensors: {},
  logs: []
};

const profileSelect = document.getElementById("profile-select");
const startButton = document.getElementById("start-button");
const stopButton = document.getElementById("stop-button");
const startBagButton = document.getElementById("start-bag-button");
const stopBagButton = document.getElementById("stop-bag-button");
const checkConnectionButton = document.getElementById("check-connection-button");
const checkTopicsButton = document.getElementById("check-topics-button");
const runtimePill = document.getElementById("runtime-pill");
const connectionTarget = document.getElementById("connection-target");
const connectionStatus = document.getElementById("connection-status");
const processList = document.getElementById("process-list");
const launchDetails = document.getElementById("launch-details");
const rosbagDetails = document.getElementById("rosbag-details");
const recordingList = document.getElementById("recording-list");
const sensorList = document.getElementById("sensor-list");
const configEditor = document.getElementById("config-editor");
const saveConfigButton = document.getElementById("save-config-button");
const reloadConfigButton = document.getElementById("reload-config-button");
const logViewer = document.getElementById("log-viewer");

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function renderProfiles() {
  const profiles = state.config?.launchProfiles || {};
  const selected = profileSelect.value;
  profileSelect.innerHTML = "";

  Object.entries(profiles).forEach(([id, profile]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = profile.label;
    profileSelect.appendChild(option);
  });

  if (profiles[selected]) {
    profileSelect.value = selected;
  }

  renderProfileDetails();
}

function renderProfileDetails() {
  const profileId = profileSelect.value;
  const profile = state.config?.launchProfiles?.[profileId];
  if (!profile) {
    launchDetails.innerHTML = "<div class=\"detail-item\">No launch profile configured.</div>";
    return;
  }

  launchDetails.innerHTML = `
    <div class="detail-item">
      <strong>Profile</strong>
      <div>${profile.label}</div>
    </div>
    <div class="detail-item">
      <strong>Execution Target</strong>
      <code>${escapeHtml(formatRunnerTarget())}</code>
    </div>
    <div class="detail-item">
      <strong>Command</strong>
      <code>${escapeHtml(profile.command || "")}</code>
    </div>
  `;
}

function formatRunnerTarget() {
  const runner = state.config?.commandRunner || { mode: "local" };
  if (runner.mode !== "ssh") {
    return "local shell";
  }

  const ssh = runner.ssh || {};
  const host = ssh.host || "unconfigured-host";
  const destination = ssh.user ? `${ssh.user}@${host}` : host;
  return `ssh ${destination}:${ssh.port || 22}`;
}

function requiresConnectionCheck() {
  return state.config?.commandRunner?.mode === "ssh";
}

function isConnectionReady() {
  return !requiresConnectionCheck() || state.connection?.status === "online";
}

function renderConnection() {
  const connection = state.connection || {
    status: "unknown",
    message: "Connection has not been checked yet.",
    target: formatRunnerTarget()
  };
  const status = connection.status || "unknown";

  connectionTarget.textContent = connection.target || formatRunnerTarget();
  connectionStatus.textContent = status === "online"
    ? "Online"
    : status === "checking"
      ? "Checking"
      : status === "offline"
        ? "Offline"
        : "Unknown";
  connectionStatus.className = `status-pill status-${status}`;
  connectionStatus.title = connection.message || "";
  checkConnectionButton.disabled = status === "checking";
  checkConnectionButton.textContent = status === "checking" ? "Checking..." : "Check Connection";
}

function renderRuntime() {
  const runtime = state.runtime || { isRunning: false };
  runtimePill.textContent = runtime.isRunning ? `Running: ${runtime.activeProfile}` : "Idle";
  runtimePill.style.background = runtime.isRunning ? "#d8f3e7" : "#fffaf1";
  startButton.disabled = runtime.isRunning || !isConnectionReady();
  stopButton.disabled = !runtime.isRunning;

  const rosbag = state.rosbag || { isRecording: false };
  startBagButton.disabled = rosbag.isRecording || !isConnectionReady();
  stopBagButton.disabled = !rosbag.isRecording;
  renderRosbagDetails();
  renderRecordings();
}

function renderProcesses() {
  const processes = state.processes || [];
  const checks = state.health?.checks || {};
  checkTopicsButton.disabled = !isConnectionReady();

  if (processes.length === 0) {
    processList.innerHTML = "<div class=\"empty-state\">No drivers or SLAM process configured.</div>";
    return;
  }

  processList.innerHTML = processes.map((processInfo) => {
    const status = processInfo.status || "stopped";
    const health = checks[processInfo.id];
    const topics = health?.topics || processInfo.requiredTopics.map((topic) => ({
      topic,
      status: "unknown",
      detail: "not_checked"
    }));
    const selectedDriver = processInfo.selectedDriver
      ? `<span>Selected: ${escapeHtml(processInfo.selectedDriver)}</span>`
      : "";
    const topicItems = topics.map((topic) => `
      <li class="topic-${escapeHtml(topic.status)}">
        <span>${escapeHtml(topic.topic)}</span>
        <strong>${escapeHtml(formatTopicStatus(topic.status))}</strong>
      </li>
    `).join("");

    return `
      <article class="process-card">
        <div class="process-main">
          <div class="process-title">
            <strong>${escapeHtml(processInfo.label)}</strong>
            <span class="sensor-status status-${escapeHtml(status)}">${escapeHtml(formatProcessStatus(status))}</span>
          </div>
          ${selectedDriver}
          <code>${escapeHtml(processInfo.command || "No command configured")}</code>
          <ul class="topic-list">${topicItems || "<li>No required topics configured.</li>"}</ul>
        </div>
        <div class="process-actions">
          <button class="button button-primary" data-process-action="start" data-process-id="${escapeHtml(processInfo.id)}" ${status !== "stopped" || !isConnectionReady() ? "disabled" : ""}>Start</button>
          <button class="button button-secondary" data-process-action="pause" data-process-id="${escapeHtml(processInfo.id)}" ${status !== "running" ? "disabled" : ""}>Pause</button>
          <button class="button button-secondary" data-process-action="resume" data-process-id="${escapeHtml(processInfo.id)}" ${status !== "paused" ? "disabled" : ""}>Resume</button>
          <button class="button button-secondary" data-process-action="stop" data-process-id="${escapeHtml(processInfo.id)}" ${status === "stopped" ? "disabled" : ""}>Stop</button>
        </div>
      </article>
    `;
  }).join("");
}

function formatProcessStatus(status) {
  return {
    running: "Running",
    paused: "Paused",
    stopped: "Stopped"
  }[status] || status;
}

function formatTopicStatus(status) {
  return {
    online: "Data",
    waiting: "Listed",
    offline: "Missing",
    unknown: "Unchecked"
  }[status] || status;
}

function renderSensors() {
  const sensors = state.config?.sensors || [];

  sensorList.innerHTML = sensors.map((sensor) => {
    const status = state.sensors[sensor.id] || {
      matchedOutputs: [],
      healthy: false
    };

    const items = (sensor.expectedOutputs || []).map((output) => {
      const matched = status.matchedOutputs.includes(output);
      return `<li class="${matched ? "matched" : ""}">${escapeHtml(output)}</li>`;
    }).join("");

    return `
      <article class="sensor-card">
        <div class="sensor-row">
          <strong>${escapeHtml(sensor.name)}</strong>
          <span class="sensor-status ${status.healthy ? "status-healthy" : "status-waiting"}">
            ${status.healthy ? "Healthy" : "Waiting"}
          </span>
        </div>
        <ul>${items}</ul>
      </article>
    `;
  }).join("");
}

function renderLogs() {
  logViewer.innerHTML = state.logs.map((entry) => `
    <div class="log-line">
      <span class="log-time">${new Date(entry.timestamp).toLocaleTimeString()}</span>
      <span class="log-source">[${escapeHtml(entry.source)}]</span>
      <span>${escapeHtml(entry.line)}</span>
    </div>
  `).join("");
  logViewer.scrollTop = logViewer.scrollHeight;
}

function renderRosbagDetails() {
  const rosbagConfig = state.config?.rosbag || {};
  const rosbagRuntime = state.rosbag || { isRecording: false };
  const activeRecording = rosbagRuntime.activeRecording;
  const topics = Array.isArray(rosbagConfig.topics) ? rosbagConfig.topics : [];

  rosbagDetails.innerHTML = `
    <div class="detail-item">
      <strong>Status</strong>
      <div>${rosbagRuntime.isRecording ? "Recording" : "Stopped"}</div>
    </div>
    <div class="detail-item">
      <strong>Execution Target</strong>
      <code>${escapeHtml(formatRunnerTarget())}</code>
    </div>
    <div class="detail-item">
      <strong>Output Directory</strong>
      <code>${escapeHtml(rosbagConfig.outputDirectory || "~/rosbags")}</code>
    </div>
    <div class="detail-item">
      <strong>Active Output</strong>
      <code>${escapeHtml(activeRecording?.remotePath || "No active recording")}</code>
    </div>
    <div class="detail-item">
      <strong>Setup Command</strong>
      <code>${escapeHtml(rosbagConfig.setupCommand || "Uses current shell environment")}</code>
    </div>
    <div class="detail-item">
      <strong>Topics</strong>
      <code>${escapeHtml(topics.length > 0 ? topics.join(", ") : "No topics configured")}</code>
    </div>
  `;
}

function renderRecordings() {
  const recordings = [...(state.rosbag?.recordings || [])].reverse();
  if (recordings.length === 0) {
    recordingList.innerHTML = "<div class=\"empty-state\">No completed recordings yet.</div>";
    return;
  }

  recordingList.innerHTML = recordings.map((recording) => {
    const isBusy = recording.status === "recording" || recording.status === "copying_to_device";
    const canDownload = recording.status !== "recording" && recording.status !== "copying_to_device";
    const statusLabel = {
      recording: "Recording",
      saved_on_jetson: "Saved on Orin",
      copying_to_device: "Copying",
      downloaded: "Saved locally",
      failed: "Failed",
      stopped: "Stopped"
    }[recording.status] || recording.status;

    return `
      <article class="recording-card">
        <div>
          <strong>${escapeHtml(recording.name)}</strong>
          <code>${escapeHtml(recording.remotePath)}</code>
          <span>${escapeHtml(statusLabel)}</span>
        </div>
        <button
          class="button button-secondary"
          data-recording-download="${escapeHtml(recording.id)}"
          ${canDownload ? "" : "disabled"}
        >
          ${isBusy ? "Working..." : "Save to This Device"}
        </button>
      </article>
    `;
  }).join("");
}

function renderConfigEditor() {
  if (state.config) {
    configEditor.value = JSON.stringify(state.config, null, 2);
  }
}

function renderAll() {
  renderConnection();
  renderProfiles();
  renderProcesses();
  renderRuntime();
  renderSensors();
  renderLogs();
  renderConfigEditor();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

async function loadState() {
  const data = await request("/api/state");
  state.config = data.config;
  state.connection = data.connection;
  state.processes = data.processes;
  state.health = data.health;
  state.runtime = data.runtime;
  state.rosbag = data.rosbag;
  state.sensors = data.sensors;
  state.logs = data.logs;
  renderAll();
}

async function checkConnection() {
  try {
    const data = await request("/api/connection/check", {
      method: "POST",
      body: JSON.stringify({})
    });
    state.connection = data.connection;
    renderConnection();
    renderRuntime();
    renderProcesses();
  } catch (error) {
    window.alert(error.message);
  }
}

async function checkTopics() {
  try {
    const data = await request("/api/health/check", {
      method: "POST",
      body: JSON.stringify({})
    });
    state.health = data.health;
    renderProcesses();
  } catch (error) {
    window.alert(error.message);
  }
}

async function runProcessAction(processId, action) {
  try {
    const data = await request(`/api/processes/${encodeURIComponent(processId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({})
    });
    state.processes = data.processes;
    renderProcesses();
  } catch (error) {
    window.alert(error.message);
  }
}

async function startLaunch() {
  try {
    await request("/api/start", {
      method: "POST",
      body: JSON.stringify({ profileId: profileSelect.value })
    });
  } catch (error) {
    window.alert(error.message);
  }
}

async function stopLaunch() {
  try {
    await request("/api/stop", {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch (error) {
    window.alert(error.message);
  }
}

async function startRosbag() {
  try {
    await request("/api/rosbag/start", {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch (error) {
    window.alert(error.message);
  }
}

async function stopRosbag() {
  try {
    await request("/api/rosbag/stop", {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch (error) {
    window.alert(error.message);
  }
}

async function downloadRecording(recordingId) {
  try {
    const data = await request(`/api/recordings/${encodeURIComponent(recordingId)}/download`, {
      method: "POST",
      body: JSON.stringify({})
    });
    state.rosbag = data.rosbag;
    renderRuntime();
    window.location.href = data.downloadUrl;
  } catch (error) {
    window.alert(`Could not save recording: ${error.message}`);
  }
}

async function saveConfig() {
  try {
    const nextConfig = JSON.parse(configEditor.value);
    const data = await request("/api/config", {
      method: "POST",
      body: JSON.stringify(nextConfig)
    });
    state.config = data.config;
    state.processes = data.processes || state.processes;
    state.health = data.health || state.health;
    renderAll();
    window.alert("Config saved.");
  } catch (error) {
    window.alert(`Could not save config: ${error.message}`);
  }
}

function attachEvents() {
  profileSelect.addEventListener("change", renderProfileDetails);
  checkConnectionButton.addEventListener("click", checkConnection);
  checkTopicsButton.addEventListener("click", checkTopics);
  startButton.addEventListener("click", startLaunch);
  stopButton.addEventListener("click", stopLaunch);
  startBagButton.addEventListener("click", startRosbag);
  stopBagButton.addEventListener("click", stopRosbag);
  saveConfigButton.addEventListener("click", saveConfig);
  reloadConfigButton.addEventListener("click", loadState);
  recordingList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-recording-download]");
    if (!button) {
      return;
    }
    downloadRecording(button.dataset.recordingDownload);
  });
  processList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-process-action]");
    if (!button) {
      return;
    }
    runProcessAction(button.dataset.processId, button.dataset.processAction);
  });
}

function connectEvents() {
  const events = new EventSource("/api/events");

  events.addEventListener("bootstrap", (event) => {
    const data = JSON.parse(event.data);
    state.config = data.config;
    state.connection = data.connection;
    state.processes = data.processes;
    state.health = data.health;
    state.runtime = data.runtime;
    state.rosbag = data.rosbag;
    state.sensors = data.sensors;
    state.logs = data.logs;
    renderAll();
  });

  events.addEventListener("runtime", (event) => {
    state.runtime = JSON.parse(event.data);
    renderRuntime();
  });

  events.addEventListener("rosbag-runtime", (event) => {
    state.rosbag = JSON.parse(event.data);
    renderRuntime();
  });

  events.addEventListener("connection", (event) => {
    state.connection = JSON.parse(event.data);
    renderConnection();
    renderRuntime();
    renderProcesses();
  });

  events.addEventListener("processes", (event) => {
    state.processes = JSON.parse(event.data);
    renderProcesses();
  });

  events.addEventListener("health", (event) => {
    state.health = JSON.parse(event.data);
    renderProcesses();
  });

  events.addEventListener("log", (event) => {
    state.logs.push(JSON.parse(event.data));
    state.logs = state.logs.slice(-500);
    renderLogs();
  });

  events.addEventListener("sensor-status", (event) => {
    state.sensors = JSON.parse(event.data);
    renderSensors();
  });

  events.addEventListener("config", (event) => {
    state.config = JSON.parse(event.data);
    renderConnection();
    renderProfiles();
    renderProcesses();
    renderRosbagDetails();
    renderSensors();
    renderConfigEditor();
  });
}

attachEvents();
loadState();
connectEvents();
