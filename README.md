# Jetson ROS Launcher

This is a small web app base for starting ROS2 launch stacks on a Jetson Orin.
It can run commands locally on the same machine as the web server or over SSH on
a remote Jetson.

## What it does

- Lets you switch between two launch profiles:
  - `gmsl_stack`
  - `security_stack`
- Starts and stops the selected launch command from the web UI
- Streams stdout and stderr into the browser
- Tracks sensor health by matching expected log output snippets
- Saves launch commands and sensor expectations in `config/app-config.json`
- Can execute launch and rosbag commands through SSH with key-based auth

## Run

```bash
npm start
```

Then open `http://127.0.0.1:3000`.

The server binds to `127.0.0.1` by default. To expose it on a trusted network:

```bash
BIND_HOST=0.0.0.0 npm start
```

## Jetson setup

Replace the placeholder commands in `config/app-config.json` with your real commands, for example:

```bash
source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch my_stack gmsl_stack.launch.py
```

Use the same file to define the log snippets that indicate each sensor is healthy.

## SSH mode

Use SSH mode when this app runs on a laptop or workstation but the ROS2 commands
should run on the Jetson Orin.

1. Make sure SSH is enabled on the Jetson:

```bash
sudo systemctl enable --now ssh
```

2. From the machine running this app, verify key-based SSH:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519
ssh-copy-id -i ~/.ssh/id_ed25519.pub ubuntu@jetson-orin.local
ssh ubuntu@jetson-orin.local
```

3. Edit `config/app-config.json`:

```json
{
  "commandRunner": {
    "mode": "ssh",
    "ssh": {
      "host": "jetson-orin.local",
      "user": "ubuntu",
      "port": 22,
      "identityFile": "~/.ssh/id_ed25519",
      "workingDirectory": "",
      "remoteStateDirectory": "~/.genauto-sensor-dash",
      "options": [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new"
      ]
    }
  }
}
```

The launch and rosbag commands still run through `bash -lc` on the Jetson, so
keep the ROS setup commands in each configured command:

```bash
source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch my_stack gmsl_stack.launch.py
```

Remote launch and rosbag processes write pidfiles under
`remoteStateDirectory` so the Stop buttons can terminate the remote process
group.

## Notes

- In local mode on Linux or Jetson, the server runs commands through `/bin/bash -lc`.
- In local mode on Windows, it uses PowerShell so the app can still be tested locally.
- In SSH mode, the local server uses the system `ssh` client and remote `setsid`.
- This base assumes only one launch stack runs at a time.
