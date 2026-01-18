# 🛡️ RangeShield AI
> **Eliminating EV Range Anxiety with Real-Time Telemetry & Predictive Terrain Analysis.**

![Hero Image](assets/hero-shot.png)
*(Replace with your best screenshot)*

## 🚨 The Problem
EV drivers suffer from "Range Anxiety"—the fear of running out of power. Existing maps are **dumb**: they assume all roads are flat and don't account for battery health leaks or elevation changes.

## 💡 The Solution
RangeShield AI is a **Next.js-powered Guardian System** that sits on top of Google Maps. It uses:
1.  **Terrain-Aware Routing:** Calculates battery drain based on uphill/downhill slopes (Green vs. Red lines).
2.  **Real-Time Guardian:** A background worker that detects anomalies (leaks/rapid drain) instantly via Kafka.
3.  **Smart Rerouting:** Automatically finds charging stations when the "Point of No Return" is approached.



🌟 Key Features🔋 Live Telemetry HUD: Real-time speed, temp, and predicted range overlay.⛰️ Gravity Map: Visualizes energy consumption (Red = Uphill/Drain, Green = Regen).🗣️ Voice Command: "Find me a charger" hands-free integration.⚡ The "Guardian": Background service that monitors battery health 60x/minute.🛠️ Tech StackFramework: Next.js (React)Maps: Google Maps JavaScript API, Turf.jsData Streaming: Confluent Cloud (Apache Kafka)Backend Logic: Node.js (Custom Worker Scripts)🚀 Getting StartedPrerequisitesNode.js (v18+)Google Maps API KeyConfluent Cloud ClusterInstallationClone the repoBashgit clone [https://github.com/your-username/rangeshield-ai.git](https://github.com/your-username/rangeshield-ai.git)
cd rangeshield-ai
Install dependenciesBashnpm install
# If you have separate folders for scripts/workers:
# cd worker && npm install
Configure EnvironmentRename .env.example to .env.local (Next.js standard) and add your API keys.Running the AppYou will need 3 terminal windows to run the full system.Terminal 1: The Web Application (Next.js)Runs the dashboard, map, and voice interface.Bashnpm run dev
# Opens at http://localhost:3000
Terminal 2: The Guardian WorkerListens to Kafka for low battery alerts and fetches charging stations.Bashnode scripts/guardian_worker.js
# (Or whatever your backend consumer script is named)
Terminal 3: Vehicle SimulatorGenerates fake GPS movement and battery drain.Bashnode scripts/simulate_movement.js
📸 ScreenshotsRoute PlanningTelemetry HUD

Built for the AI Partner Catalyst Hackathon 2026.
