

# 🛡️ RangeShield AI

**RangeShield AI** eliminates EV "Range Anxiety" by transforming static navigation into a dynamic, battery-aware guardian system. Built for **AI Partner Catalyst Hackathon 2025**, it leverages **Next.js**, **Kafka Streaming**, and **Predictive Terrain Analysis** to prevent battery depletion before it happens.

---

## High-Level System Overview

RangeShield AI is a full-stack Next.js application that treats vehicle safety as a real-time data problem.

* **Next.js (Full Stack):** Handles both the interactive **Dashboard UI** (React/Tailwind) and the **API Layer** (Server Actions/API Routes) that processes alerts.
* **TypeScript Workers:** Specialized background scripts that act as the "Guardian," listening to Kafka streams for anomalies (rapid drain) and calculating "Point of No Return" logic.
* **Confluent Cloud (Kafka):** The central nervous system, streaming high-frequency GPS telemetry (100ms updates) from the vehicle to the cloud.

---

## Deployment Surfaces

| Component | Technology | Role |
| --- | --- | --- |
| **App Runtime** | **Next.js 15 (TypeScript)** | Main Application, Map UI, Telemetry HUD, Voice Logic |
| **Data Stream** | **Apache Kafka** (Confluent) | Real-time event pipeline for GPS & Battery data |
| **Guardian** | **TypeScript (tsx)** | Background worker that consumes stream & triggers alerts |
| **Simulation** | **TypeScript (tsx)** | Generates mock EV telemetry (GPS, Speed, Battery Drain) |
| **Mapping** | **Google Maps + Turf.js** | Directions, Elevation Analysis, and Vector Rendering |

**Figure 1.** Event-Driven Architecture powered by Next.js and Confluent Cloud.

---

## How It Works

### 1. The "Gravity Map" (Smart Planning)

Unlike standard maps, RangeShield analyzes the **physics** of the route.

* **Terrain Analysis:** For routes < 100km, the app queries the **Google Elevation API**.
* **Energy Visualizer:** The path is color-coded based on battery impact:
* 🔴 **Red:** Uphill (High Consumption)
* 🟢 **Green:** Downhill (Regenerative Braking)



### 2. Real-Time Telemetry Stream

The system simulates a connected vehicle environment using a dedicated TypeScript producer.

* **Simulation:** `simulate_movement.ts` pushes GPS and battery health data to Kafka.
* **Zero-Latency UI:** The Next.js frontend consumes this stream, using **Turf.js** to smoothly interpolate the vehicle marker position (60fps), eliminating the "laggy map" effect.

### 3. The "Guardian" (Anomaly Detection)

A background TypeScript worker monitors the stream for safety threats.

* **Rapid Drain Detection:** Triggers an alert if battery drops >1% per minute (simulating leaks/AC faults).
* **Point of No Return:** Continuously calculates if the remaining range is sufficient to return home.

### 4. Automated Intervention

When a critical threshold is breached:

1. The Guardian intercepts the event.
2. It queries the **Google Places API** for the nearest compatible charging stations.
3. It pushes a "Reroute Recommendation" directly to the Driver's Head-Up Display (HUD).

---

## Tech Stack

* **Framework:** Next.js 15 (App Router)
* **Language:** TypeScript
* **Styling:** Tailwind CSS
* **Streaming:** Confluent Cloud (KafkaJS)
* **Maps:** Google Maps JavaScript API, Google Elevation API
* **Geospatial:** Turf.js

---

## Getting Started

### Prerequisites

* Node.js (v18+)
* Google Maps API Key (Places, Directions, Elevation enabled)
* Confluent Cloud Cluster

### Installation

1. **Clone the repo**
```bash
git clone https://github.com/your-username/rangeshield-ai.git
cd rangeshield-ai

```


2. **Install dependencies**
```bash
npm install

```


3. **Environment Setup**
Rename `.env.example` to `.env.local` and add your keys:
```env
NEXT_PUBLIC_GOOGLE_MAPS_KEY=your_key
CONFLUENT_API_KEY=your_key
CONFLUENT_SECRET=your_secret
CONFLUENT_BOOTSTRAP_SERVER=your_server

```



### Running the System

You need **3 terminal windows** to run the full simulation stack.

**Terminal 1: Next.js App (Frontend & API)**

```bash
npm run dev
# Dashboard available at http://localhost:3000

```

**Terminal 2: Vehicle Simulator (Producer)**
Generates the GPS movement and battery data.

```bash
npx tsx scripts/simulate_movement.ts

```

**Terminal 3: Guardian Worker (Consumer)**
Listens for anomalies and triggers alerts.

```bash
npx tsx scripts/guardian_worker.ts

```

---

## Screenshots

| Route Planning | Telemetry HUD |
| --- | --- |
|  |  |

---

**Built for AI Partner Catalyst 2026.**
