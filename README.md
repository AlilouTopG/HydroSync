# 🌊 HydroSync — Smart Irrigation & Water Management Digital Twin

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Render-brightgreen?logo=render)](https://hydrosync-0khc.onrender.com/#telemetry)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?logo=node.js)](https://nodejs.org/)
[![Hardware](https://img.shields.io/badge/Hardware-Web%20Serial%20USB-blue)](https://hydrosync-0khc.onrender.com/#telemetry)

An interactive **Digital Twin platform** for precision agriculture and smart water management. It integrates a discrete **PID control loop**, real-time satellite weather sync via **Open-Meteo**, edge hardware streaming via the browser's **Web Serial API**, and dynamic **Disturbance Injection** for resilience testing.

---

## 🚀 Live Demo

Access the interactive operating console deployed on Render:  
👉 **[Launch HydroSync Console](https://hydrosync-0khc.onrender.com/#telemetry)**

---

## ✨ Key Features

* **🎛️ Dynamic PID Regulation:** Closed-loop control maintaining target soil moisture levels by modulating PWM valve/pump outputs with Anti-Windup safeguards.
* **🌧️ Environmental Disturbance Injection:** Real-time simulation of climate anomalies (Severe Drought, Heavy Rain, and Emergency Shutoff) to evaluate system recovery.
* **🔌 Web Serial USB Hardware Ingestion:** Direct telemetry ingestion from physical edge devices (Arduino, ESP32, STM32) directly through the browser without external drivers.
* **🛰️ Live Meteorological Sync:** Live integration with the Open-Meteo API for real-time evapotranspiration ($ET_0$) calculation and rain forecasting.
* **📊 Dual SCADA Visualization:** Animated water tank reservoir tracking, active flow indicators, and continuous telemetry response curves.

---

## 🛠️ Architecture & Tech Stack

* **Backend Server:** Node.js, Express.js
* **Control & Simulation Engine:** Custom discrete PID controller and physics-based disturbance injector (`simulator.js`)
* **Frontend:** HTML5, Modern CSS (Industrial SCADA Theme), Vanilla JavaScript (ES6+)
* **Edge Protocols:** Web Serial API (USB Telemetry)
* **Cloud & Hosting:** Render

---

## 📁 Repository Structure

```text
HydroSync/
├── public/
│   ├── index.html       # SCADA Dashboard UI
│   ├── app.js           # Client telemetry, charting & Web Serial logic
│   ├── style.css        # Dashboard styling & animations
│   └── favicon.svg      # Application icon
├── server.js            # Express server & API endpoints
├── simulator.js         # Digital Twin physics & PID algorithm
└── package.json         # Node dependencies and scripts
