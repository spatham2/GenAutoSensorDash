# Jetson LiDAR Recorder

This is a small web app for controlling ROS2 sensor recording on a Jetson Orin.
It can run commands locally on the same machine as the web server or over SSH on
a remote Jetson, then copy completed rosbags back with `scp`.

## What it does

- Lets you switch between two launch profiles:
  - `gmsl_stack`
  - `security_stack`
- Starts and stops the selected launch command from the web UI
- Checks whether the configured Jetson SSH target is online
- Starts, pauses, resumes, and stops the Ouster, MTi-680G, and selected SLAM processes
- Checks whether the Ouster and MTi-680G ROS topics are publishing live data
- Starts and stops SLAM rosbag recording on the Jetson
- Keeps completed bag files on the Jetson under `~/rosbags`
- Copies completed bag folders to this device with `scp` and downloads `.tar.gz` archives
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

Run these on the Jetson Orin:

```bash
sudo apt update
sudo apt install -y openssh-server openssh-sftp-server
sudo systemctl enable --now ssh

mkdir -p ~/.ssh ~/.genauto-sensor-dash ~/rosbags
chmod 700 ~/.ssh ~/.genauto-sensor-dash
chmod 775 ~/rosbags
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

sudo usermod -aG dialout,plugdev "$USER"
```

Add the dashboard computer's public key to the Jetson:

```bash
printf '%s\n' 'PASTE_THE_CONTENTS_OF_id_ed25519.pub_HERE' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

If you can SSH while off VPN, you can do the key setup from your personal device instead:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C genauto-sensor-dashboard
ssh-copy-id -i ~/.ssh/id_ed25519.pub spatham@10.10.10.1
ssh -i ~/.ssh/id_ed25519 spatham@10.10.10.1 'mkdir -p ~/.genauto-sensor-dash ~/rosbags && test -w ~/rosbags && echo online'
```

Verify the LiDAR topic on the Jetson:

```bash
source /opt/ros/humble/setup.bash
ros2 topic list | grep -E 'ouster|points|lidar'
ros2 topic hz /ouster/points
```

If your point cloud topic is not `/ouster/points`, update `config/app-config.json`.

## ROS2 driver setup on the Orin

Use the ROS2 branches for the Ouster and Xsens drivers:

```bash
mkdir -p ~/ros2_ws/src
cd ~/ros2_ws/src

git clone https://github.com/ouster-lidar/ouster-ros.git
cd ~/ros2_ws/src/ouster-ros
git fetch origin
git switch --track origin/ros2
git submodule update --init --recursive

cd ~/ros2_ws/src
git clone https://github.com/xsenssupport/Xsens_MTi_ROS_Driver_and_Ntrip_Client.git
cd ~/ros2_ws/src/Xsens_MTi_ROS_Driver_and_Ntrip_Client
git fetch origin
git switch --track origin/ros2

cd ~/ros2_ws
source /opt/ros/humble/setup.bash
rosdep install --from-paths src --ignore-src -r -y
colcon build --symlink-install
source install/setup.bash
```

Allow the MTi-680G serial device and tune the Ouster network receive buffers:

```bash
sudo usermod -aG dialout,plugdev "$USER"
sudo modprobe usbserial
echo 2639 0300 | sudo tee /sys/bus/usb-serial/drivers/ftdi_sio/new_id
cd ~/ros2_ws/src/ouster-ros
bash ouster-ros/util/network-configure.bash
```

Log out and back in after changing groups, then verify the drivers:

```bash
source /opt/ros/humble/setup.bash
source ~/ros2_ws/install/setup.bash

ros2 launch ouster_ros sensor.launch.xml sensor_hostname:=<OUSTER_LIDAR_IP> lidar_mode:=1024x10 timestamp_mode:=TIME_FROM_ROS_TIME point_type:=original viz:=false
ros2 launch xsens_mti_ros2_driver xsens_mti_node.launch.py

ros2 topic hz /ouster/points
ros2 topic echo --once /imu/data
ros2 topic echo --once /gnss
```

## Updateable runtime config

Edit `config/app-config.json` to change commands, topics, and the active SLAM driver.

Set the Ouster LiDAR IP once here:

```json
"hardware": {
  "ouster": {
    "lidarIp": "192.168.1.XX",
    "lidarMode": "1024x10",
    "timestampMode": "TIME_FROM_ROS_TIME",
    "pointType": "original"
  }
}
```

Put your sensor driver launch commands here:

```json
"drivers": {
  "ouster": {
    "command": "source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch ouster_ros sensor.launch.xml sensor_hostname:={{hardware.ouster.lidarIp}} lidar_mode:={{hardware.ouster.lidarMode}} timestamp_mode:={{hardware.ouster.timestampMode}} point_type:={{hardware.ouster.pointType}} viz:=false",
    "requiredTopics": ["/ouster/points"]
  },
  "mti680g": {
    "command": "source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch xsens_mti_ros2_driver xsens_mti_node.launch.py",
    "requiredTopics": ["/imu/data", "/gnss"]
  }
}
```

The local `ouster-ros` and `Xsens_MTi_ROS_Driver_and_Ntrip_Client` checkouts are currently on ROS1/catkin branches. Switch them to their `ros2` branches before building on the Orin, or replace these commands with a ROS1 bridge flow.

Select which SLAM command the dashboard should run by changing `selectedDriver`:

```json
"slam": {
  "selectedDriver": "lio_sam",
  "drivers": {
    "lio_sam": {
      "label": "LIO-SAM",
      "command": "source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch lio_sam run.launch.py params_file:=$(ros2 pkg prefix lio_sam)/share/lio_sam/config/params.yaml",
      "requiredTopics": [
        "/lio_sam/mapping/odometry",
        "/lio_sam/mapping/odometry_incremental",
        "/lio_sam/mapping/cloud_registered",
        "/lio_sam/mapping/path"
      ]
    },
    "my_slam": {
      "label": "My SLAM",
      "command": "source /opt/ros/humble/setup.bash && source ~/my_ws/install/setup.bash && ros2 launch my_slam bringup.launch.py",
      "requiredTopics": ["/map", "/odom"]
    }
  }
}
```

Record the raw sensors and SLAM outputs by editing `rosbag.topics`:

```json
"rosbag": {
  "topics": [
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
}
```

Replace any placeholder launch commands in `config/app-config.json` with your real commands, for example:

```bash
source /opt/ros/humble/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch my_stack gmsl_stack.launch.py
```

Use the same file to define the log snippets that indicate each sensor is healthy.

## Recording workflow

1. Power the Orin and plug in the Ouster LiDAR and MTi-680G.
2. Start the dashboard:

```bash
npm start
```

3. Open `http://127.0.0.1:3000`.
4. Confirm the SSH target shows `spatham@10.10.10.1:22`, then click **Check Connection**.
5. Start **Ouster LiDAR Driver** and **MTi-680G IMU/GPS Driver**.
6. Click **Check ROS Topics**. MTi-680G is healthy when `/imu/data` and `/gnss` return live data in ROS2.
7. Start **SLAM**. The command comes from `slam.drivers[slam.selectedDriver]`.
8. Click **Start SLAM Recording**. The dashboard runs a configured `ros2 bag record`.

```bash
source /opt/ros/humble/setup.bash && mkdir -p ~/rosbags && ros2 bag record -o ~/rosbags/slam_<timestamp> /ouster/points /imu/data /gnss /tf /tf_static /lio_sam/deskew/cloud_deskewed /lio_sam/feature/cloud_corner /lio_sam/feature/cloud_surface /lio_sam/mapping/odometry /lio_sam/mapping/odometry_incremental /lio_sam/mapping/cloud_registered /lio_sam/mapping/cloud_registered_raw /lio_sam/mapping/path
```

9. Click **Stop Recording** to finalize the bag on the Orin.
10. Click **Save to This Device**. The dashboard runs an `scp -r` copy from the Orin, archives the bag, then downloads the `.tar.gz`.

## SSH mode

Use SSH mode when this app runs on a laptop or workstation but the ROS2 commands
should run on the Jetson Orin.

1. Make sure SSH is enabled on the Jetson:

```bash
sudo systemctl enable --now ssh
```

2. From the machine running this app, verify key-based SSH:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C genauto-sensor-dashboard
ssh-copy-id -i ~/.ssh/id_ed25519.pub spatham@10.10.10.1
ssh -i ~/.ssh/id_ed25519 spatham@10.10.10.1
```

3. Edit `config/app-config.json`:

```json
{
  "commandRunner": {
    "mode": "ssh",
    "ssh": {
      "host": "10.10.10.1",
      "user": "spatham",
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
