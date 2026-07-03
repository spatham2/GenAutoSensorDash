# Jetson ROS Launcher

This is a small web app base for starting ROS2 launch stacks on a Jetson Orin.

## What it does

- Lets you switch between two launch profiles:
  - `gmsl_stack`
  - `security_stack`
- Starts and stops the selected launch command from the web UI
- Streams stdout and stderr into the browser
- Tracks sensor health by matching expected log output snippets
- Saves launch commands and sensor expectations in `config/app-config.json`

## Run

```bash
npm start
```

Then open `http://localhost:3000`.

## Jetson setup

Replace the placeholder commands in `config/app-config.json` with your real commands, for example:

```bash
source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch my_stack gmsl_stack.launch.py
```

Use the same file to define the log snippets that indicate each sensor is healthy.

## Notes

- On Linux or Jetson, the server runs launch commands through `/bin/bash -lc`.
- On Windows, it uses PowerShell so the app can still be tested locally.
- This base assumes only one launch stack runs at a time.
