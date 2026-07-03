const state = {
  config: null,
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
const runtimePill = document.getElementById("runtime-pill");
const launchDetails = document.getElementById("launch-details");
const rosbagDetails = document.getElementById("rosbag-details");
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
      <strong>Command</strong>
      <code>${escapeHtml(profile.command || "")}</code>
    </div>
  `;
}

function renderRuntime() {
  const runtime = state.runtime || { isRunning: false };
  runtimePill.textContent = runtime.isRunning ? `Running: ${runtime.activeProfile}` : "Idle";
  runtimePill.style.background = runtime.isRunning ? "#d8f3e7" : "#fffaf1";
  startButton.disabled = runtime.isRunning;
  stopButton.disabled = !runtime.isRunning;

  const rosbag = state.rosbag || { isRecording: false };
  startBagButton.disabled = rosbag.isRecording;
  stopBagButton.disabled = !rosbag.isRecording;
  renderRosbagDetails();
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
  const topics = Array.isArray(rosbagConfig.topics) ? rosbagConfig.topics : [];

  rosbagDetails.innerHTML = `
    <div class="detail-item">
      <strong>Status</strong>
      <div>${rosbagRuntime.isRecording ? "Recording" : "Stopped"}</div>
    </div>
    <div class="detail-item">
      <strong>Output Directory</strong>
      <code>${escapeHtml(rosbagConfig.outputDirectory || "~/rosbags")}</code>
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

function renderConfigEditor() {
  if (state.config) {
    configEditor.value = JSON.stringify(state.config, null, 2);
  }
}

function renderAll() {
  renderProfiles();
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
  state.runtime = data.runtime;
  state.rosbag = data.rosbag;
  state.sensors = data.sensors;
  state.logs = data.logs;
  renderAll();
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

async function saveConfig() {
  try {
    const nextConfig = JSON.parse(configEditor.value);
    const data = await request("/api/config", {
      method: "POST",
      body: JSON.stringify(nextConfig)
    });
    state.config = data.config;
    renderAll();
    window.alert("Config saved.");
  } catch (error) {
    window.alert(`Could not save config: ${error.message}`);
  }
}

function attachEvents() {
  profileSelect.addEventListener("change", renderProfileDetails);
  startButton.addEventListener("click", startLaunch);
  stopButton.addEventListener("click", stopLaunch);
  startBagButton.addEventListener("click", startRosbag);
  stopBagButton.addEventListener("click", stopRosbag);
  saveConfigButton.addEventListener("click", saveConfig);
  reloadConfigButton.addEventListener("click", loadState);
}

function connectEvents() {
  const events = new EventSource("/api/events");

  events.addEventListener("bootstrap", (event) => {
    const data = JSON.parse(event.data);
    state.config = data.config;
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
    renderProfiles();
    renderRosbagDetails();
    renderSensors();
    renderConfigEditor();
  });
}

attachEvents();
loadState();
connectEvents();
